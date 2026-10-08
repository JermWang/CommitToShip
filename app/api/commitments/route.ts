import { NextResponse } from "next/server";
import crypto from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

import {
  CommitmentKind,
  CreatorFeeMode,
  createCommitmentRecord,
  createRewardCommitmentRecord,
  getActiveCommitmentByTokenMint,
  insertCommitment,
  listCommitments,
  publicView,
  tryConsumeSignedRequestNonce,
} from "../../lib/escrowStore";
import { checkRateLimit } from "../../lib/rateLimit";
import { getConnection, getMintAuthorityBase58, getTokenMetadataUpdateAuthorityBase58, verifyTokenExistsOnChain } from "../../lib/solana";
import { privyCreateSolanaWallet } from "../../lib/privy";
import { getSafeErrorMessage } from "../../lib/safeError";
import { getAllowedCreatorWallets } from "../../lib/creatorAuth";

export const runtime = "nodejs";

function isPublicLaunchEnabled(): boolean {
  // Public launches enabled by default (closed beta ended)
  const raw = String(process.env.CTS_PUBLIC_LAUNCHES ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

/** What the authority wallet signs to create a personal commitment (binds every parameter + a timestamp). */
function personalCommitmentMessage(input: {
  authority: string;
  destinationOnFail: string;
  amountLamports: number;
  deadlineUnix: number;
  timestampUnix: number;
}): string {
  return [
    "Ship & Commit",
    "Create Commitment",
    `Authority: ${input.authority}`,
    `DestinationOnFail: ${input.destinationOnFail}`,
    `AmountLamports: ${input.amountLamports}`,
    `DeadlineUnix: ${input.deadlineUnix}`,
    `Timestamp: ${input.timestampUnix}`,
  ].join("\n");
}

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
    const commitments = (await listCommitments()).filter((c) => c.status !== "archived").map(publicView);
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
      const forbiddenAuthority = typeof body.authority === "string" ? body.authority.trim() : "";
      const forbiddenDestinationOnFail = typeof body.destinationOnFail === "string" ? body.destinationOnFail.trim() : "";
      if (forbiddenAuthority || forbiddenDestinationOnFail) {
        return NextResponse.json(
          {
            error: "creator_reward commitments do not allow authority/destinationOnFail overrides",
            hint: "Failure handling for creator rewards is system-controlled via milestone failure distributions.",
          },
          { status: 400 }
        );
      }

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

      if (!isPublicLaunchEnabled()) {
        const allowed = getAllowedCreatorWallets();
        if (!allowed.has(devWallet.toBase58())) {
          return NextResponse.json(
            {
              error: "This wallet is not approved to launch yet",
              hint: "Launches are currently limited to approved wallets.",
            },
            { status: 403 }
          );
        }
      }

      const nowUnix = Math.floor(Date.now() / 1000);
      if (Math.abs(nowUnix - timestampUnix) > 5 * 60) {
        return NextResponse.json({ error: "Verification timestamp expired" }, { status: 400 });
      }

      const message = `Ship & Commit\nDev Verification\nMint: ${tokenMint}\nWallet: ${devWallet.toBase58()}\nTimestamp: ${timestampUnix}`;
      const signature = bs58.decode(signatureB58);
      const okSig = nacl.sign.detached.verify(new TextEncoder().encode(message), signature, devWallet.toBytes());
      if (!okSig) {
        return NextResponse.json({ error: "Invalid dev verification signature" }, { status: 401 });
      }

      if (creatorFeeMode === "managed") {
        const existingManaged = (await listCommitments()).find(
          (c) => c.kind === "creator_reward" && c.creatorFeeMode === "managed" && c.status !== "archived" && c.authority === creator.toBase58()
        );
        if (existingManaged) {
          return NextResponse.json(
            {
              error: "Creator wallet already has a managed creator reward commitment",
              creatorPubkey: creator.toBase58(),
              existingCommitmentId: existingManaged.id,
              hint: "Managed mode requires a unique creator wallet. Use assisted mode or a different wallet.",
            },
            { status: 409 }
          );
        }
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
      let milestones: Array<{ id: string; title: string; unlockLamports: number; unlockPercent: number; dueAtUnix: number }> = [];
      if (rawMilestones.length > 0) {
        const hasPercents = rawMilestones.some((m: any) => m?.unlockPercent != null);

        const nowUnix = Math.floor(Date.now() / 1000);
        const maxFutureSeconds = 10 * 365 * 24 * 60 * 60;

        milestones = rawMilestones.map((m: any, idx: number) => {
          const title = typeof m?.title === "string" ? m.title.trim() : "";
          const unlockPercent = Number(m?.unlockPercent) || 0;
          const unlockLamports = Number(m?.unlockLamports) || 0;
          const dueAtUnix = Number(m?.dueAtUnix) || 0;
          if (!title.length) throw new Error(`Milestone ${idx + 1}: title required`);
          if (title.length > 80) throw new Error(`Milestone ${idx + 1}: title too long (max 80 chars)`);
          if (hasPercents && (unlockPercent <= 0 || unlockPercent > 100)) throw new Error(`Milestone ${idx + 1}: invalid unlock percentage`);
          if (!hasPercents && (!Number.isFinite(unlockLamports) || unlockLamports <= 0)) throw new Error(`Milestone ${idx + 1}: invalid unlockLamports`);
          if (!Number.isFinite(dueAtUnix) || dueAtUnix <= 0) throw new Error(`Milestone ${idx + 1}: invalid dueAtUnix`);
          if (dueAtUnix < nowUnix - 60) throw new Error(`Milestone ${idx + 1}: dueAtUnix must be in the future`);
          if (dueAtUnix > nowUnix + maxFutureSeconds) throw new Error(`Milestone ${idx + 1}: dueAtUnix too far in the future`);
          const id = typeof m?.id === "string" && m.id.trim().length > 0 ? m.id.trim() : crypto.randomBytes(8).toString("hex");
          return { id, title, unlockLamports: Math.floor(unlockLamports), unlockPercent, dueAtUnix: Math.floor(dueAtUnix) };
        });

        // The milestones together may never unlock more than the whole escrow (same rule as add/edit).
        if (hasPercents) {
          const totalPercent = milestones.reduce((acc, m) => acc + (Number(m.unlockPercent) || 0), 0);
          if (totalPercent > 100.0001) {
            return NextResponse.json({ error: `Total allocation cannot exceed 100% (would be ${totalPercent}%).` }, { status: 400 });
          }
        }
        if (new Set(milestones.map((m) => m.id)).size !== milestones.length) {
          return NextResponse.json({ error: "Duplicate milestone ids" }, { status: 400 });
        }
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

    // The authority wallet must sign the exact commitment (single use, +-5 min) BEFORE any escrow wallet is created:
    // otherwise anyone could mint Privy wallets + DB rows for arbitrary addresses.
    const authorityAuth = body.authorityAuth as any;
    const authSigB58 = typeof authorityAuth?.signatureB58 === "string" ? authorityAuth.signatureB58.trim() : "";
    const authTs = Math.floor(Number(authorityAuth?.timestampUnix));
    const expectedAuthMessage = personalCommitmentMessage({
      authority: authority.toBase58(),
      destinationOnFail: destinationOnFail.toBase58(),
      amountLamports: Math.floor(amountLamports),
      deadlineUnix: Math.floor(deadlineUnix),
      timestampUnix: Number.isFinite(authTs) && authTs > 0 ? authTs : Math.floor(Date.now() / 1000),
    });
    if (!authSigB58 || !Number.isFinite(authTs) || authTs <= 0) {
      return NextResponse.json(
        {
          error: "authorityAuth (signatureB58, timestampUnix) is required",
          hint: "Sign the commitment with the authority (refund) wallet.",
          message: expectedAuthMessage,
        },
        { status: 400 }
      );
    }
    if (Math.abs(Math.floor(Date.now() / 1000) - authTs) > 5 * 60) {
      return NextResponse.json({ error: "Signature timestamp expired, sign again" }, { status: 400 });
    }
    let authSig: Uint8Array;
    try {
      authSig = bs58.decode(authSigB58);
    } catch {
      authSig = new Uint8Array(0);
    }
    if (authSig.length !== nacl.sign.signatureLength) {
      return NextResponse.json({ error: "Invalid signature encoding" }, { status: 400 });
    }
    if (!nacl.sign.detached.verify(new TextEncoder().encode(expectedAuthMessage), authSig, authority.toBytes())) {
      return NextResponse.json({ error: "Invalid authority signature", hint: "Sign with the authority (refund) wallet." }, { status: 401 });
    }
    if (!(await tryConsumeSignedRequestNonce({ scope: "create_commitment", nonce: authSigB58 }))) {
      return NextResponse.json({ error: "This signature was already used" }, { status: 409 });
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
