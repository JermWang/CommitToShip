import { NextResponse } from "next/server";
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

import { checkRateLimit } from "../../../../../lib/rateLimit";
import { apiError } from "../../../../../lib/apiError";
import { getAsdConfig } from "../../../../../lib/asdStore";
import { getAsdFundingTargetLamports } from "../../../../../lib/asdExecution";
import { getServerCommitment, withRetry } from "../../../../../lib/rpc";
import {
  buildCreateAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
  getConnection,
  getTokenProgramIdForMint,
  verifyTokenExistsOnChain,
} from "../../../../../lib/solana";

export const runtime = "nodejs";

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** SPL TransferChecked (works for Token and Token-2022 mints). */
function transferCheckedIx(input: {
  tokenProgram: PublicKey;
  source: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amountRaw: bigint;
  decimals: number;
}): TransactionInstruction {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(input.amountRaw, 1);
  data[9] = input.decimals;
  return new TransactionInstruction({
    programId: input.tokenProgram,
    keys: [
      { pubkey: input.source, isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: input.destination, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/**
 * POST /api/commitments/[id]/asd/fund-tx  { amountRaw?: string, solLamports?: number }
 *
 * ASD sells from a creator-funded vault. This builds (never sends) the funding transaction for the CREATOR wallet to
 * sign and send itself: create the vault's token account if needed, TransferChecked `amountRaw` project tokens from the
 * creator's ATA into the vault, and top the vault up with SOL for swap fees (default: up to the reserve the executor
 * keeps; the reserve is never forwarded). No auth needed: only the creator can sign it.
 */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "asd:fund-tx", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const commitmentId = String(ctx?.params?.id ?? "").trim();
    const cfg = commitmentId ? await getAsdConfig(commitmentId) : null;
    if (!cfg) return NextResponse.json({ error: "ASD config not found" }, { status: 404 });
    if (!cfg.activatedAtUnix || !cfg.vaultPubkey) return NextResponse.json({ error: "Activate ASD first (the vault is created on activation)" }, { status: 409 });
    if (cfg.status === "disabled") return NextResponse.json({ error: "ASD is disabled for this commitment" }, { status: 409 });

    const body = (await req.json().catch(() => null)) as any;

    let amountRaw = 0n;
    if (body?.amountRaw != null && String(body.amountRaw).trim() !== "") {
      const t = String(body.amountRaw).trim();
      if (!/^\d{1,20}$/.test(t)) throw httpError(400, "amountRaw must be a positive integer (raw token units)");
      amountRaw = BigInt(t);
      if (amountRaw <= 0n || amountRaw > 18446744073709551615n) throw httpError(400, "amountRaw out of range");
    }

    const connection = getConnection();
    const commitment = getServerCommitment();
    const creator = new PublicKey(cfg.creatorPubkey);
    const vault = new PublicKey(cfg.vaultPubkey);
    const mint = new PublicKey(cfg.tokenMint);

    let solLamports: number;
    const vaultSol = await withRetry(() => connection.getBalance(vault, commitment));
    if (body?.solLamports != null) {
      solLamports = Math.floor(Number(body.solLamports));
      if (!Number.isFinite(solLamports) || solLamports < 0 || solLamports > 100_000_000_000) throw httpError(400, "solLamports out of range");
    } else {
      solLamports = Math.max(0, getAsdFundingTargetLamports() - vaultSol);
    }

    if (amountRaw <= 0n && solLamports <= 0) {
      return NextResponse.json({ error: "Nothing to fund: pass amountRaw (tokens) and/or solLamports", vaultSolLamports: vaultSol }, { status: 400 });
    }

    const instructions: TransactionInstruction[] = [];
    let vaultTokenAccount: string | null = null;

    if (amountRaw > 0n) {
      const tokenProgram = await getTokenProgramIdForMint({ connection, mint });
      const info = await verifyTokenExistsOnChain({ connection, mint });
      const decimals = Number(info.decimals);
      if (!info.isMintAccount || !Number.isFinite(decimals)) throw httpError(409, "Project token mint is not a valid mint");

      const source = getAssociatedTokenAddress({ owner: creator, mint, tokenProgram });
      const balance = await withRetry(() => connection.getTokenAccountBalance(source, commitment)).catch(() => null);
      const have = BigInt(String(balance?.value?.amount ?? "0"));
      if (have < amountRaw) {
        throw httpError(400, `The creator wallet's token account holds ${have.toString()} raw units, less than amountRaw`);
      }

      const { ix: createAta, ata } = buildCreateAssociatedTokenAccountIdempotentInstruction({ payer: creator, owner: vault, mint, tokenProgram });
      vaultTokenAccount = ata.toBase58();
      instructions.push(createAta);
      instructions.push(transferCheckedIx({ tokenProgram, source, mint, destination: ata, owner: creator, amountRaw, decimals: Math.floor(decimals) }));
    }

    if (solLamports > 0) {
      instructions.push(SystemProgram.transfer({ fromPubkey: creator, toPubkey: vault, lamports: solLamports }));
    }

    const latest = await withRetry(() => connection.getLatestBlockhash("confirmed"));
    const message = new TransactionMessage({ payerKey: creator, recentBlockhash: latest.blockhash, instructions }).compileToLegacyMessage();
    const tx = new VersionedTransaction(message);

    // Read-only dry run so the caller sees problems before asking the wallet to sign.
    let simulation: { err: unknown; logs: string[] | null } | null = null;
    try {
      const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
      simulation = { err: sim.value.err ?? null, logs: sim.value.logs ?? null };
    } catch {
      simulation = null;
    }

    return NextResponse.json({
      ok: true,
      txBase64: Buffer.from(tx.serialize()).toString("base64"),
      lastValidBlockHeight: latest.lastValidBlockHeight,
      feePayer: creator.toBase58(),
      vaultPubkey: vault.toBase58(),
      vaultTokenAccount,
      amountRaw: amountRaw.toString(),
      solLamports,
      vaultSolLamports: vaultSol,
      simulation,
    });
  } catch (e) {
    return apiError(e, "asd/fund-tx");
  }
}
