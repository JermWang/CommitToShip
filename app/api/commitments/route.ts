import { NextResponse } from "next/server";
import crypto from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

import { CommitmentKind, CreatorFeeMode, createCommitmentRecord, createRewardCommitmentRecord, getActiveCommitmentByTokenMint, insertCommitment, listCommitments, publicView } from "../../lib/escrowStore";
import { checkRateLimit } from "../../lib/rateLimit";
import { getConnection, getMintAuthorityBase58, getTokenMetadataUpdateAuthorityBase58, verifyTokenExistsOnChain } from "../../lib/solana";
import { privyCreateSolanaWallet } from "../../lib/privy";
import { getSafeErrorMessage } from "../../lib/safeError";

export const runtime = "nodejs";

async function createEscrow(): Promise<{ escrowPubkey: string; escrowSecretKeyB58: string }> {
  if (process.env.NODE_ENV === "production") {
    const created = await privyCreateSolanaWallet();
    return { escrowPubkey: created.address, escrowSecretKeyB58: `privy:${created.walletId}` };
  }

  try {
    const created = await privyCreateSolanaWallet();
    return { escrowPubkey: created.address, escrowSecretKeyB58: `privy:${created.walletId}` };
  } catch {
    const escrow = Keypair.generate();
    return { escrowPubkey: escrow.publicKey.toBase58(), escrowSecretKeyB58: bs58.encode(escrow.secretKey) };
  }
}

export async function GET(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "commitments:get", limit: 120, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }
    const commitments = (await listCommitments()).map(publicView);
    return NextResponse.json({ commitments });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "commitments:post", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const body = (await req.json()) as any;
    const statement = typeof body.statement === "string" ? body.statement.trim() : "";
    if (statement.length > 140) {
      return NextResponse.json({ error: "Statement too long (max 140 chars)" }, { status: 400 });
    }

    const kind = (typeof body.kind === "string" ? body.kind : "personal") as CommitmentKind;

    if (kind === "creator_reward") {
      const creator = new PublicKey(String(body.creatorPubkey ?? ""));

      const rawMode = typeof body.creatorFeeMode === "string" ? body.creatorFeeMode.trim() : "";
      const creatorFeeMode: CreatorFeeMode | undefined = rawMode === "managed" || rawMode === "assisted" ? (rawMode as CreatorFeeMode) : undefined;

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
      const mintPk = new PublicKey(tokenMint);

      // Step 1: Verify token exists on-chain and is a valid mint account
      const tokenVerification = await verifyTokenExistsOnChain({ connection, mint: mintPk });
      if (!tokenVerification.exists) {
        return NextResponse.json({ 
          error: "Token does not exist on-chain", 
          tokenMint,
          hint: "The provided token mint address does not correspond to any account on Solana"
        }, { status: 400 });
      }
      if (!tokenVerification.isMintAccount) {
        return NextResponse.json({ 
          error: "Address is not a valid token mint", 
          tokenMint,
          hint: "The provided address exists but is not a SPL Token or Token-2022 mint account"
        }, { status: 400 });
      }

      // Step 1b: Check for existing active commitment for this token
      const existingCommitment = await getActiveCommitmentByTokenMint(tokenMint);
      if (existingCommitment) {
        return NextResponse.json({ 
          error: "An active commitment already exists for this token", 
          tokenMint,
          existingCommitmentId: existingCommitment.id,
          hint: "Each token can only have one active commitment at a time"
        }, { status: 409 });
      }

      // Step 2: Verify wallet has authority over the token (mint authority OR metadata update authority)
      const [mintAuthority, updateAuthority] = await Promise.all([
        getMintAuthorityBase58({ connection, mint: mintPk }),
        getTokenMetadataUpdateAuthorityBase58({ connection, mint: mintPk }),
      ]);

      const isMintAuthority = mintAuthority === devWallet.toBase58();
      const isUpdateAuthority = updateAuthority === devWallet.toBase58();
      const okAuthority = isMintAuthority || isUpdateAuthority;
      
      if (!okAuthority) {
        return NextResponse.json({ 
          error: "Wallet does not control this token", 
          tokenMint,
          walletPubkey: devWallet.toBase58(),
          mintAuthority: mintAuthority ?? "(revoked or none)",
          updateAuthority: updateAuthority ?? "(no metadata)",
          hint: "Your wallet must be either the mint authority or metadata update authority to create a commitment for this token"
        }, { status: 403 });
      }

      // Milestones are optional at creation - can be added post-launch from the dashboard
      const rawMilestones = Array.isArray(body.milestones) ? body.milestones : [];
      if (rawMilestones.length > 12) {
        return NextResponse.json({ error: "Too many milestones (max 12)" }, { status: 400 });
      }

      // Validate milestones if provided
      let milestones: Array<{ id: string; title: string; unlockLamports: number; unlockPercent: number }> = [];
      if (rawMilestones.length > 0) {
        const hasPercents = rawMilestones.some((m: any) => m?.unlockPercent != null);
        
        if (hasPercents) {
          const totalPercent = rawMilestones.reduce((sum: number, m: any) => sum + (Number(m?.unlockPercent) || 0), 0);
          if (totalPercent !== 100) {
            return NextResponse.json({ error: `Milestone percentages must total 100% (currently ${totalPercent}%)` }, { status: 400 });
          }
        }

        milestones = rawMilestones.map((m: any, idx: number) => {
          const title = typeof m?.title === "string" ? m.title.trim() : "";
          const unlockPercent = Number(m?.unlockPercent) || 0;
          const unlockLamports = Number(m?.unlockLamports) || 0;
          if (!title.length) throw new Error(`Milestone ${idx + 1}: title required`);
          if (title.length > 80) throw new Error(`Milestone ${idx + 1}: title too long (max 80 chars)`);
          if (hasPercents && (unlockPercent <= 0 || unlockPercent > 100)) throw new Error(`Milestone ${idx + 1}: invalid unlock percentage`);
          if (!hasPercents && (!Number.isFinite(unlockLamports) || unlockLamports <= 0)) throw new Error(`Milestone ${idx + 1}: invalid unlockLamports`);
          const id = typeof m?.id === "string" && m.id.trim().length > 0 ? m.id.trim() : crypto.randomBytes(8).toString("hex");
          return { id, title, unlockLamports: Math.floor(unlockLamports), unlockPercent };
        });
      }

      const escrow = await createEscrow();
      const id = crypto.randomBytes(16).toString("hex");

      const record = createRewardCommitmentRecord({
        id,
        statement: statement.length ? statement : undefined,
        creatorPubkey: creator.toBase58(),
        escrowPubkey: escrow.escrowPubkey,
        escrowSecretKeyB58: escrow.escrowSecretKeyB58,
        milestones,
        tokenMint,
        creatorFeeMode,
      });

      await insertCommitment(record);

      return NextResponse.json({
        id,
        kind: record.kind,
        statement: record.statement ?? null,
        creatorPubkey: record.creatorPubkey ?? null,
        creatorFeeMode: record.creatorFeeMode ?? null,
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

    const escrow = await createEscrow();
    const id = crypto.randomBytes(16).toString("hex");

    const record = createCommitmentRecord({
      id,
      statement: statement.length ? statement : undefined,
      authority: authority.toBase58(),
      destinationOnFail: destinationOnFail.toBase58(),
      amountLamports,
      deadlineUnix,
      escrowPubkey: escrow.escrowPubkey,
      escrowSecretKeyB58: escrow.escrowSecretKeyB58,
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
