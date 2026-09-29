import { Connection, Commitment, Keypair, Transaction } from "@solana/web3.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, opts?: { attempts?: number; baseDelayMs?: number }): Promise<T> {
  const attempts = Math.max(1, Math.min(6, opts?.attempts ?? 3));
  const baseDelayMs = Math.max(50, opts?.baseDelayMs ?? 250);

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) break;
      const backoff = baseDelayMs * 2 ** i;
      const jitter = Math.floor(Math.random() * 80);
      await sleep(backoff + jitter);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function getServerCommitment(): Commitment {
  const raw = (process.env.SOLANA_COMMITMENT ?? "confirmed").trim() as Commitment;
  return raw || "confirmed";
}

let warnedPublicRpc = false;

export function getConnection(): Connection {
  const configured = String(process.env.SOLANA_RPC_URL ?? "").trim();
  if (!configured && process.env.NODE_ENV === "production" && !warnedPublicRpc) {
    warnedPublicRpc = true;
    console.warn("[rpc] SOLANA_RPC_URL is not set - falling back to the public mainnet RPC, which is heavily rate-limited. Set a dedicated RPC (Helius/Triton/QuickNode).");
  }
  const url = configured || "https://api.mainnet-beta.solana.com";
  return new Connection(url, getServerCommitment());
}

function isCommitmentSatisfied(current: string | null | undefined, desired: Commitment): boolean {
  const c = String(current ?? "");
  if (desired === "processed") return c === "processed" || c === "confirmed" || c === "finalized";
  if (desired === "confirmed") return c === "confirmed" || c === "finalized";
  if (desired === "finalized") return c === "finalized";
  return c === desired;
}

export async function confirmSignatureViaRpc(
  connection: Connection,
  signature: string,
  commitment: Commitment
): Promise<void> {
  const sig = String(signature ?? "").trim();
  if (!sig) throw new Error("Missing signature");

  const timeoutMs = 60_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const st = await withRetry(() => connection.getSignatureStatuses([sig], { searchTransactionHistory: true }));
    const s = st?.value?.[0] as any;

    if (s?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
    }

    const confirmationStatus = typeof s?.confirmationStatus === "string" ? s.confirmationStatus : null;
    if (confirmationStatus && isCommitmentSatisfied(confirmationStatus, commitment)) {
      return;
    }

    await sleep(1200);
  }

  throw new Error("Transaction confirmation timeout");
}

export async function sendAndConfirm(opts: {
  connection: Connection;
  tx: Transaction;
  signers: Keypair[];
}): Promise<string> {
  const { connection, tx, signers } = opts;

  // Use processed for speed, then confirm at configured commitment.
  const processed = "processed" as Commitment;
  const finality = getServerCommitment();

  const latest = await withRetry(() => connection.getLatestBlockhash(processed));
  tx.recentBlockhash = latest.blockhash;
  tx.lastValidBlockHeight = latest.lastValidBlockHeight;

  const sig = await withRetry(() => connection.sendTransaction(tx, signers, { skipPreflight: false, preflightCommitment: processed }));
  await confirmSignatureViaRpc(connection, sig, finality);

  return sig;
}
