import { NextResponse } from "next/server";
import crypto from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

import { CommitmentKind, createCommitmentRecord, createRewardCommitmentRecord, insertCommitment, listCommitments, publicView } from "../../lib/escrowStore";
import { getConnection, getMintAuthorityBase58, getTokenMetadataUpdateAuthorityBase58 } from "../../lib/solana";
import { getSafeErrorMessage } from "../../lib/safeError";

export const runtime = "nodejs";

export async function GET() {
  try {
    const commitments = (await listCommitments()).map(publicView);
    return NextResponse.json({ commitments });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as any;
    const statement = typeof body.statement === "string" ? body.statement.trim() : "";
    if (statement.length > 140) {
      return NextResponse.json({ error: "Statement too long (max 140 chars)" }, { status: 400 });
    }

    const kind = (typeof body.kind === "string" ? body.kind : "personal") as CommitmentKind;

    if (kind === "creator_reward") {
      const creator = new PublicKey(String(body.creatorPubkey ?? ""));

      const tokenMintRaw = typeof body.tokenMint === "string" ? body.tokenMint.trim() : "";
      if (!tokenMintRaw) {
        return NextResponse.json({ error: "tokenMint is required" }, { status: 400 });
      }
      const tokenMint = new PublicKey(tokenMintRaw).toBase58();

      const devVerify = body.devVerify as any;
      const devWalletPubkey = typeof devVerify?.walletPubkey === "string" ? devVerify.walletPubkey.trim() : "";
      const signatureB58 = typeof devVerify?.signatureB58 === "string" ? devVerify.signatureB58.trim() : "";
      const timestampUnix = Number(devVerify?.timestampUnix);
      if (!devWalletPubkey || !signatureB58 || !Number.isFinite(timestampUnix) || timestampUnix <= 0) {
        return NextResponse.json({ error: "devVerify (walletPubkey, signatureB58, timestampUnix) is required" }, { status: 400 });
      }

      const devWallet = new PublicKey(devWalletPubkey);
      if (devWallet.toBase58() !== creator.toBase58()) {
        return NextResponse.json({ error: "creatorPubkey must match connected dev wallet" }, { status: 400 });
      }

      const nowUnix = Math.floor(Date.now() / 1000);
      if (Math.abs(nowUnix - timestampUnix) > 5 * 60) {
        return NextResponse.json({ error: "Verification timestamp expired" }, { status: 400 });
      }

      const message = `Commit To Ship\nDev Verification\nMint: ${tokenMint}\nWallet: ${devWallet.toBase58()}\nTimestamp: ${timestampUnix}`;
      const signature = bs58.decode(signatureB58);
      const okSig = nacl.sign.detached.verify(new TextEncoder().encode(message), signature, devWallet.toBytes());
      if (!okSig) {
        return NextResponse.json({ error: "Invalid dev verification signature" }, { status: 401 });
      }

      const connection = getConnection();
      const [mintAuthority, updateAuthority] = await Promise.all([
        getMintAuthorityBase58({ connection, mint: new PublicKey(tokenMint) }),
        getTokenMetadataUpdateAuthorityBase58({ connection, mint: new PublicKey(tokenMint) }),
      ]);

      const okAuthority = mintAuthority === devWallet.toBase58() || updateAuthority === devWallet.toBase58();
      if (!okAuthority) {
        return NextResponse.json({ error: "Wallet is not token authority", mintAuthority, updateAuthority }, { status: 403 });
      }

      const rawMilestones = Array.isArray(body.milestones) ? body.milestones : null;
      if (!rawMilestones || rawMilestones.length === 0) {
        return NextResponse.json({ error: "Milestones are required" }, { status: 400 });
      }
      if (rawMilestones.length > 12) {
        return NextResponse.json({ error: "Too many milestones (max 12)" }, { status: 400 });
      }

      const milestones = rawMilestones.map((m: any, idx: number) => {
        const title = typeof m?.title === "string" ? m.title.trim() : "";
        const unlockLamports = Number(m?.unlockLamports);
        if (!title.length) throw new Error(`Milestone ${idx + 1}: title required`);
        if (title.length > 80) throw new Error(`Milestone ${idx + 1}: title too long (max 80 chars)`);
        if (!Number.isFinite(unlockLamports) || unlockLamports <= 0) throw new Error(`Milestone ${idx + 1}: invalid unlockLamports`);
        const id = typeof m?.id === "string" && m.id.trim().length > 0 ? m.id.trim() : crypto.randomBytes(8).toString("hex");
        return { id, title, unlockLamports: Math.floor(unlockLamports) };
      });

      const escrow = Keypair.generate();
      const id = crypto.randomBytes(16).toString("hex");

      const record = createRewardCommitmentRecord({
        id,
        statement: statement.length ? statement : undefined,
        creatorPubkey: creator.toBase58(),
        escrowPubkey: escrow.publicKey.toBase58(),
        escrowSecretKeyB58: bs58.encode(escrow.secretKey),
        milestones,
        tokenMint,
      });

      await insertCommitment(record);

      return NextResponse.json({
        id,
        kind: record.kind,
        statement: record.statement ?? null,
        creatorPubkey: record.creatorPubkey ?? null,
        tokenMint: record.tokenMint ?? null,
        escrowPubkey: record.escrowPubkey,
        totalFundedLamports: record.totalFundedLamports,
        unlockedLamports: record.unlockedLamports,
        milestones: record.milestones ?? [],
        status: record.status,
      });
    }

    const authority = new PublicKey(body.authority);
    const destinationOnFail = new PublicKey(body.destinationOnFail);

    const amountLamports = Number(body.amountLamports);
    const deadlineUnix = Number(body.deadlineUnix);

    if (!Number.isFinite(amountLamports) || amountLamports <= 0) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }

    if (!Number.isFinite(deadlineUnix) || deadlineUnix <= Math.floor(Date.now() / 1000)) {
      return NextResponse.json({ error: "Invalid deadline" }, { status: 400 });
    }

    const escrow = Keypair.generate();
    const id = crypto.randomBytes(16).toString("hex");

    const record = createCommitmentRecord({
      id,
      statement: statement.length ? statement : undefined,
      authority: authority.toBase58(),
      destinationOnFail: destinationOnFail.toBase58(),
      amountLamports,
      deadlineUnix,
      escrowPubkey: escrow.publicKey.toBase58(),
      escrowSecretKeyB58: bs58.encode(escrow.secretKey),
    });

    await insertCommitment(record);

    return NextResponse.json({
      id,
      statement: record.statement ?? null,
      escrowPubkey: record.escrowPubkey,
      amountLamports: record.amountLamports,
      deadlineUnix: record.deadlineUnix,
      authority: record.authority,
      destinationOnFail: record.destinationOnFail,
    });
  } catch (e) {
    const message = getSafeErrorMessage(e);
    const status = message === "DATABASE_URL is required" ? 500 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
