import {
  ComputeBudgetProgram,
  Connection,
  Commitment,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

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

/**
 * Polls a signature until it reaches `commitment`. Throws "Transaction failed: …" when it landed with an error, and
 * a TX_UNCERTAIN TxSendError after 60s (the transaction may still land - never treat that as "not sent").
 */
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

    if (s?.err && isCommitmentSatisfied(s?.confirmationStatus, "confirmed")) {
      throw new TxSendError("TX_FAILED", `Transaction failed: ${JSON.stringify(s.err)}`, { signature: sig, noEffect: true, chainError: s.err });
    }

    const confirmationStatus = typeof s?.confirmationStatus === "string" ? s.confirmationStatus : null;
    if (!s?.err && confirmationStatus && isCommitmentSatisfied(confirmationStatus, commitment)) {
      return;
    }

    await sleep(1200);
  }

  throw new TxSendError("TX_UNCERTAIN", "Transaction confirmation timeout", { signature: sig, noEffect: false });
}

// ---------------------------------------------------------------------------------------------------------------------
// Durable send / confirm state machine
//
//  1. sign once for a blockhash, compute the signature from the signed bytes and hand it to `onPrepared` (callers
//     persist it) BEFORE anything is broadcast;
//  2. broadcast the SAME bytes repeatedly until the signature confirms;
//  3. a new transaction is only built once the old one is provably dead: the finalized block height is past its
//     lastValidBlockHeight AND the signature status (searched in history, answered by a node that has seen that
//     finalized slot) is still null;
//  4. an on-chain error is final - it is reported, never retried;
//  5. running out of patience is reported as TX_UNCERTAIN with the signature, never as a failure.
// ---------------------------------------------------------------------------------------------------------------------

export type TxSendErrorCode =
  /** Landed with an on-chain error: no state change except the fee. */
  | "TX_FAILED"
  /** The RPC refused the very first broadcast after simulating it: the bytes never left the RPC. */
  | "TX_PREFLIGHT_FAILED"
  /** The blockhash is provably expired and the signature never landed. */
  | "TX_EXPIRED"
  /** Nothing was broadcast (signing failed, caller vetoed in onPrepared, RPC refused before sending). */
  | "TX_ABORTED"
  /** We ran out of patience: the transaction may still land. Keep the claim, resolve later by signature. */
  | "TX_UNCERTAIN";

export class TxSendError extends Error {
  code: TxSendErrorCode;
  /** Last signature that was (possibly) broadcast. */
  signature: string | null;
  lastValidBlockHeight: number | null;
  /** True when it is proven that no transfer happened (safe to release a claim / let the user retry). */
  noEffect: boolean;
  chainError?: unknown;
  status: number;

  constructor(
    code: TxSendErrorCode,
    message: string,
    extra?: { signature?: string | null; lastValidBlockHeight?: number | null; noEffect?: boolean; chainError?: unknown; cause?: unknown }
  ) {
    super(message);
    this.name = "TxSendError";
    this.code = code;
    this.signature = extra?.signature ?? null;
    this.lastValidBlockHeight = extra?.lastValidBlockHeight ?? null;
    this.noEffect = Boolean(extra?.noEffect);
    this.chainError = extra?.chainError;
    // Uncertain sends are "accepted, still pending" (202); everything else is a server-side failure.
    this.status = code === "TX_UNCERTAIN" ? 202 : 502;
    if (extra?.cause !== undefined) (this as any).cause = extra.cause;
  }
}

export function isTxSendError(e: unknown): e is TxSendError {
  return Boolean(e) && typeof e === "object" && (e as any).name === "TxSendError" && typeof (e as any).code === "string";
}

/** True only when it is proven that the transaction did not (and can no longer) move funds. */
export function isTxDefinitelyNotLanded(e: unknown): boolean {
  return isTxSendError(e) && e.noEffect === true;
}

/** Signature of a wire-format transaction (legacy or v0): the first signature is the fee payer's = the tx id. */
export function signatureFromRawTransaction(raw: Uint8Array): string {
  const bytes = Uint8Array.from(raw);
  // compact-u16 signature count
  let count = 0;
  let size = 0;
  let offset = 0;
  for (;;) {
    const b = bytes[offset++];
    count |= (b & 0x7f) << (size * 7);
    size++;
    if ((b & 0x80) === 0) break;
    if (size > 3) throw new Error("Invalid transaction encoding");
  }
  if (count < 1 || bytes.length < offset + 64) throw new Error("Transaction has no signatures");
  const sig = bytes.subarray(offset, offset + 64);
  if (sig.every((x) => x === 0)) throw new Error("Transaction fee payer signature is missing");
  return bs58.encode(sig);
}

export type SignatureOutcome = {
  outcome: "confirmed" | "failed" | "expired" | "pending";
  confirmationStatus?: string | null;
  err?: unknown;
};

/**
 * Where does a signature stand right now?
 *  - confirmed: reached the server commitment without error
 *  - failed:    landed (confirmed) with an on-chain error - nothing moved
 *  - expired:   finalized block height > lastValidBlockHeight and no status from a node that has seen that slot
 *  - pending:   anything else (including "can't tell": RPC errors, lagging nodes, unknown lastValidBlockHeight)
 */
export async function getSignatureOutcome(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number | null | undefined
): Promise<SignatureOutcome> {
  const sig = String(signature ?? "").trim();
  if (!sig) return { outcome: "pending" };
  const desired = getServerCommitment();

  const classify = (s: any): SignatureOutcome | null => {
    if (!s) return null;
    const cs = typeof s.confirmationStatus === "string" ? s.confirmationStatus : null;
    if (s.err) {
      // A failure seen only at "processed" could still be on a minority fork; wait for it to be confirmed.
      return isCommitmentSatisfied(cs, "confirmed") ? { outcome: "failed", confirmationStatus: cs, err: s.err } : { outcome: "pending", confirmationStatus: cs };
    }
    return isCommitmentSatisfied(cs, desired) ? { outcome: "confirmed", confirmationStatus: cs } : { outcome: "pending", confirmationStatus: cs };
  };

  const first = await withRetry(() => connection.getSignatureStatuses([sig], { searchTransactionHistory: true }));
  const firstClass = classify(first?.value?.[0]);
  if (firstClass) return firstClass;

  const lvbh = Number(lastValidBlockHeight ?? 0);
  if (!Number.isFinite(lvbh) || lvbh <= 0) return { outcome: "pending" };

  // Expiry is judged against the FINALIZED chain so a fork switch can't resurrect the transaction.
  const epoch = await withRetry(() => connection.getEpochInfo("finalized"));
  let finalizedHeight = Number(epoch?.blockHeight);
  if (!Number.isFinite(finalizedHeight)) {
    // Some providers omit blockHeight from getEpochInfo; ask for it explicitly at the same commitment.
    finalizedHeight = Number(await withRetry(() => connection.getBlockHeight({ commitment: "finalized", minContextSlot: epoch.absoluteSlot })));
  }
  if (!(finalizedHeight > lvbh)) return { outcome: "pending" };

  const again = await withRetry(() => connection.getSignatureStatuses([sig], { searchTransactionHistory: true }));
  const againClass = classify(again?.value?.[0]);
  if (againClass) return againClass;

  // The "null" answer only counts if the node that gave it has itself seen the finalized slot we compared against.
  const ctxSlot = Number((again as any)?.context?.slot ?? 0);
  if (!(ctxSlot >= Number(epoch.absoluteSlot ?? Infinity))) return { outcome: "pending" };

  return { outcome: "expired" };
}

/** Patience per signed transaction (≈ blockhash lifetime + finality); CTS_TX_CONFIRM_TIMEOUT_MS overrides. */
function defaultConfirmTimeoutMs(): number {
  const raw = Number(String(process.env.CTS_TX_CONFIRM_TIMEOUT_MS ?? "").trim() || NaN);
  return Number.isFinite(raw) && raw >= 5_000 ? Math.floor(raw) : 100_000;
}

export type DurablePreparedInfo = {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** 0 for the first transaction, 1+ for rebuilds after a proven expiry. */
  attempt: number;
  /** Signature of the previous (expired) transaction, null on the first attempt. */
  previousSignature: string | null;
};

export type DurableSendInput = {
  connection: Connection;
  /** Builds and fully signs a transaction for the given blockhash; returns its wire bytes. Must not broadcast. */
  sign: (latest: { blockhash: string; lastValidBlockHeight: number }) => Promise<Uint8Array> | Uint8Array;
  /**
   * Called with the signature BEFORE the first broadcast of every (re)built transaction. Persist it here.
   * Return false (or throw) to abort without broadcasting - e.g. when a compare-and-set shows we lost the claim.
   */
  onPrepared?: (info: DurablePreparedInfo) => Promise<boolean | void> | boolean | void;
  /** How many times a provably expired transaction may be rebuilt with a fresh blockhash (default 2). */
  maxRebuilds?: number;
  /** Total patience per signed transaction before giving up with TX_UNCERTAIN (default 100s ≈ blockhash life + finality). */
  confirmTimeoutMs?: number;
  rebroadcastIntervalMs?: number;
  pollIntervalMs?: number;
  /** Simulate on the first broadcast (default true) so deterministic failures are caught before anything is sent. */
  preflight?: boolean;
  /** Test hooks. */
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
};

export type DurableSendResult = { signature: string; blockhash: string; lastValidBlockHeight: number; attempts: number };

function errText(e: unknown): string {
  const anyE = e as any;
  const logs = Array.isArray(anyE?.logs) ? anyE.logs.join("\n") : "";
  return `${String(anyE?.message ?? e ?? "")}\n${logs}`.toLowerCase();
}

function isAlreadyProcessedError(e: unknown): boolean {
  const t = errText(e);
  return t.includes("already been processed") || t.includes("alreadyprocessed");
}

/** A preflight (simulation) rejection that proves the RPC did not forward the transaction. */
function isDeterministicPreflightError(e: unknown): boolean {
  const t = errText(e);
  if (t.includes("blockhash not found") || t.includes("node is behind") || t.includes("minimum context slot")) return false;
  if (isAlreadyProcessedError(e)) return false;
  return t.includes("transaction simulation failed") || t.includes("simulation failed") || t.includes("insufficient funds") || t.includes("instructionerror");
}

/**
 * Broadcasts already-signed bytes (never re-signs) until the signature confirms ("confirmed"), is provably expired
 * ("expired"), fails on-chain (throws TX_FAILED), is rejected by the first preflight (throws TX_PREFLIGHT_FAILED) or
 * patience runs out (throws TX_UNCERTAIN). Usable for user-signed transactions whose blockhash we can't change.
 */
export async function broadcastUntilFinal(input: {
  connection: Connection;
  raw: Uint8Array;
  signature?: string;
  lastValidBlockHeight: number | null;
  confirmTimeoutMs?: number;
  rebroadcastIntervalMs?: number;
  pollIntervalMs?: number;
  preflight?: boolean;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}): Promise<"confirmed" | "expired"> {
  const { connection, raw } = input;
  const signature = input.signature ?? signatureFromRawTransaction(raw);
  const lvbh = input.lastValidBlockHeight;
  const confirmTimeoutMs = Math.max(5_000, Number(input.confirmTimeoutMs ?? defaultConfirmTimeoutMs()));
  const rebroadcastIntervalMs = Math.max(500, Number(input.rebroadcastIntervalMs ?? 2_000));
  const pollIntervalMs = Math.max(100, Number(input.pollIntervalMs ?? 1_200));
  const preflight = input.preflight !== false;
  const doSleep = input.sleepFn ?? sleep;
  const now = input.nowFn ?? (() => Date.now());

  const startedAt = now();
  let lastBroadcastAt = -Infinity;
  let firstBroadcast = true;

  for (;;) {
    if (now() - lastBroadcastAt >= rebroadcastIntervalMs) {
      const usePreflight = firstBroadcast && preflight;
      lastBroadcastAt = now();
      try {
        await connection.sendRawTransaction(raw, {
          skipPreflight: !usePreflight,
          preflightCommitment: "confirmed",
          maxRetries: 0,
        });
      } catch (e) {
        if (usePreflight && isDeterministicPreflightError(e)) {
          throw new TxSendError("TX_PREFLIGHT_FAILED", `Transaction rejected by simulation: ${String((e as any)?.message ?? e)}`, {
            signature,
            lastValidBlockHeight: lvbh,
            noEffect: true,
            cause: e,
          });
        }
        // Network errors, rate limits, "already processed", lagging nodes: the bytes may be out there. Keep polling.
      }
      firstBroadcast = false;
    }

    let state: SignatureOutcome;
    try {
      state = await getSignatureOutcome(connection, signature, lvbh);
    } catch {
      state = { outcome: "pending" };
    }

    if (state.outcome === "confirmed") return "confirmed";
    if (state.outcome === "failed") {
      throw new TxSendError("TX_FAILED", `Transaction failed: ${JSON.stringify(state.err)}`, {
        signature,
        lastValidBlockHeight: lvbh,
        noEffect: true,
        chainError: state.err,
      });
    }
    if (state.outcome === "expired") return "expired";
    if (now() - startedAt >= confirmTimeoutMs) {
      throw new TxSendError("TX_UNCERTAIN", "Transaction confirmation timeout (it may still land)", {
        signature,
        lastValidBlockHeight: lvbh,
        noEffect: false,
      });
    }
    await doSleep(pollIntervalMs);
  }
}

export async function sendAndConfirmDurable(input: DurableSendInput): Promise<DurableSendResult> {
  const { connection } = input;
  const maxRebuilds = Math.max(0, Math.min(5, Math.floor(Number(input.maxRebuilds ?? 2))));
  const confirmTimeoutMs = Math.max(5_000, Number(input.confirmTimeoutMs ?? defaultConfirmTimeoutMs()));
  const rebroadcastIntervalMs = Math.max(500, Number(input.rebroadcastIntervalMs ?? 2_000));
  const pollIntervalMs = Math.max(100, Number(input.pollIntervalMs ?? 1_200));
  const preflight = input.preflight !== false;
  const doSleep = input.sleepFn ?? sleep;
  const now = input.nowFn ?? (() => Date.now());

  let previousSignature: string | null = null;
  let previousLvbh: number | null = null;

  for (let attempt = 0; attempt <= maxRebuilds; attempt++) {
    // ---- build + sign (nothing is broadcast in this block, so every failure here is "no effect")
    let latest: { blockhash: string; lastValidBlockHeight: number };
    let raw: Uint8Array;
    let signature: string;
    try {
      latest = await withRetry(() => connection.getLatestBlockhash("confirmed"));
      raw = Uint8Array.from(await input.sign({ blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }));
      signature = signatureFromRawTransaction(raw);
    } catch (e) {
      throw new TxSendError("TX_ABORTED", `Transaction was not sent: ${String((e as any)?.message ?? e)}`, {
        signature: previousSignature,
        lastValidBlockHeight: previousLvbh,
        noEffect: true,
        cause: e,
      });
    }

    if (input.onPrepared) {
      let verdict: boolean | void;
      try {
        verdict = await input.onPrepared({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, attempt, previousSignature });
      } catch (e) {
        throw new TxSendError("TX_ABORTED", `Transaction was not sent (could not record it first): ${String((e as any)?.message ?? e)}`, {
          signature: previousSignature,
          lastValidBlockHeight: previousLvbh,
          noEffect: true,
          cause: e,
        });
      }
      if (verdict === false) {
        throw new TxSendError("TX_ABORTED", "Transaction was not sent: the payout claim is no longer held by this request", {
          signature: previousSignature,
          lastValidBlockHeight: previousLvbh,
          noEffect: true,
        });
      }
    }

    // ---- broadcast the same bytes until it confirms, fails on-chain, provably expires, or we run out of patience
    const final = await broadcastUntilFinal({
      connection,
      raw,
      signature,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      confirmTimeoutMs,
      rebroadcastIntervalMs,
      pollIntervalMs,
      preflight,
      sleepFn: doSleep,
      nowFn: now,
    });
    if (final === "confirmed") {
      return { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, attempts: attempt + 1 };
    }
    // expired: provably dead - rebuild with a fresh blockhash (if allowed)
    previousSignature = signature;
    previousLvbh = latest.lastValidBlockHeight;
  }

  throw new TxSendError("TX_EXPIRED", "Transaction expired before it was confirmed", {
    signature: previousSignature,
    lastValidBlockHeight: previousLvbh,
    noEffect: true,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Priority fees + compute sizing
// ---------------------------------------------------------------------------------------------------------------------

const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey("ComputeBudget111111111111111111111111111111");

function intEnv(name: string, fallback: number): number {
  const str = String(process.env[name] ?? "").trim();
  if (!str) return fallback;
  const raw = Number(str);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

export function getPriorityFeeBounds(): { floor: number; cap: number } {
  const floor = intEnv("CTS_PRIORITY_FEE_FLOOR_MICROLAMPORTS", 20_000);
  const cap = Math.max(floor, intEnv("CTS_PRIORITY_FEE_CAP_MICROLAMPORTS", 2_000_000));
  return { floor, cap };
}

/** p75 of recent prioritization fees paid by transactions writing the same accounts, clamped to [floor, cap] µlamports/CU. */
export async function getPriorityFeeMicroLamports(connection: Connection, writableAccounts: PublicKey[]): Promise<number> {
  const { floor, cap } = getPriorityFeeBounds();
  try {
    const uniq = Array.from(new Set(writableAccounts.map((k) => k.toBase58()))).slice(0, 128).map((k) => new PublicKey(k));
    const recent = await connection.getRecentPrioritizationFees(uniq.length ? { lockedWritableAccounts: uniq } : undefined);
    const fees = (recent ?? [])
      .map((r) => Number(r.prioritizationFee))
      .filter((f) => Number.isFinite(f) && f > 0)
      .sort((a, b) => a - b);
    const p75 = fees.length ? fees[Math.min(fees.length - 1, Math.floor(fees.length * 0.75))] : 0;
    return Math.min(cap, Math.max(floor, p75));
  } catch {
    return floor;
  }
}

export function isComputeBudgetInstruction(ix: TransactionInstruction): boolean {
  return ix.programId.equals(COMPUTE_BUDGET_PROGRAM_ID);
}

/** Units consumed by `instructions` (simulated unsigned, sigVerify off), or null when the simulation can't tell. */
export async function simulateComputeUnits(input: { connection: Connection; payer: PublicKey; instructions: TransactionInstruction[] }): Promise<number | null> {
  try {
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...input.instructions.filter((ix) => !isComputeBudgetInstruction(ix))];
    const message = new TransactionMessage({
      payerKey: input.payer,
      recentBlockhash: bs58.encode(new Uint8Array(32)),
      instructions: ixs,
    }).compileToV0Message();
    const sim = await input.connection.simulateTransaction(new VersionedTransaction(message), {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    const units = Number(sim?.value?.unitsConsumed ?? 0);
    if (sim?.value?.err || !Number.isFinite(units) || units <= 0) return null;
    return units;
  } catch {
    return null;
  }
}

/**
 * Compute-budget instructions for `instructions`: limit = simulated units × 1.2 (+ margin), price = p75 recent fee.
 * `fallbackUnits` is used when the simulation can't size the transaction.
 */
export async function buildPriorityFeeInstructions(input: {
  connection: Connection;
  payer: PublicKey;
  instructions: TransactionInstruction[];
  fallbackUnits?: number;
  simulate?: boolean;
}): Promise<{ instructions: TransactionInstruction[]; computeUnitLimit: number; microLamports: number; priorityFeeLamports: number }> {
  const core = input.instructions.filter((ix) => !isComputeBudgetInstruction(ix));
  const writable: PublicKey[] = [input.payer];
  for (const ix of core) for (const k of ix.keys) if (k.isWritable) writable.push(k.pubkey);

  const [microLamports, simulated] = await Promise.all([
    getPriorityFeeMicroLamports(input.connection, writable),
    input.simulate === false ? Promise.resolve(null) : simulateComputeUnits({ connection: input.connection, payer: input.payer, instructions: core }),
  ]);
  const fallback = Math.max(1_000, Math.floor(Number(input.fallbackUnits ?? 200_000)));
  // The two compute-budget instructions themselves cost ~150 CU each.
  const computeUnitLimit = Math.min(1_400_000, simulated != null ? Math.ceil(simulated * 1.2) + 1_000 : fallback);
  const priorityFeeLamports = Math.ceil((computeUnitLimit * microLamports) / 1_000_000);
  return {
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports })],
    computeUnitLimit,
    microLamports,
    priorityFeeLamports,
  };
}

/**
 * Signs `tx` with `signers` for the blockhash and broadcasts it through the durable state machine.
 * Kept for existing callers; the transaction is re-signed only after a proven expiry.
 */
export async function sendAndConfirm(opts: {
  connection: Connection;
  tx: Transaction;
  signers: Keypair[];
  onPrepared?: DurableSendInput["onPrepared"];
}): Promise<string> {
  const { connection, tx, signers } = opts;
  const res = await sendAndConfirmDurable({
    connection,
    onPrepared: opts.onPrepared,
    sign: (latest) => {
      tx.recentBlockhash = latest.blockhash;
      tx.lastValidBlockHeight = latest.lastValidBlockHeight;
      tx.signatures = [];
      tx.sign(...signers);
      return tx.serialize();
    },
  });
  return res.signature;
}
