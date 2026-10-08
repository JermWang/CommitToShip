import crypto from "crypto";
import { Connection, PublicKey } from "@solana/web3.js";

import { getPool, hasDatabase } from "./db";
import { getConnection, getSignatureOutcome, withRetry } from "./rpc";

/**
 * One launch per payer wallet at a time, and a durable record of what was sent on-chain.
 * Prevents double-launches from double clicks / two tabs / client retries, and keeps the mint + tx signature
 * around if the process dies between "tx confirmed" and "commitment saved".
 *
 * The signature (and its lastValidBlockHeight) is written BEFORE the transaction is broadcast, under a per-claim
 * compare-and-set, so a launch that might still land is never forgotten, and a 'submitted' attempt is only re-claimed
 * once the chain proves it is dead (expired or failed). If it landed, it is marked 'onchain_unrecorded' instead.
 */

export type LaunchAttemptStatus = "in_flight" | "submitted" | "confirmed" | "onchain_unrecorded" | "failed";

export type LaunchAttempt = {
  payerWallet: string;
  status: LaunchAttemptStatus;
  tokenMint: string | null;
  txSig: string | null;
  lastValidBlockHeight: number | null;
  claimId: string | null;
  startedAtUnix: number;
  updatedAtUnix: number;
};

const IN_FLIGHT_STALE_SECONDS = 5 * 60;
// Without a recorded lastValidBlockHeight, a 'submitted' tx older than this can't land any more (blockhashes live ~1-2 min).
const SUBMITTED_NO_LVBH_DEAD_SECONDS = 10 * 60;

const mem = new Map<string, LaunchAttempt>();
let ensured: Promise<void> | null = null;

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

async function ensureSchema(): Promise<void> {
  if (!hasDatabase()) return;
  if (ensured) return ensured;
  ensured = (async () => {
    await getPool().query(`
      create table if not exists launch_attempts (
        payer_wallet text primary key,
        status text not null,
        token_mint text null,
        tx_sig text null,
        started_at_unix bigint not null,
        updated_at_unix bigint not null
      );
      alter table launch_attempts add column if not exists claim_id text null;
      alter table launch_attempts add column if not exists last_valid_block_height bigint null;
    `);
  })().catch((e) => {
    ensured = null;
    throw e;
  });
  return ensured;
}

function rowToAttempt(row: any): LaunchAttempt {
  const lvbh = row.last_valid_block_height == null ? null : Number(row.last_valid_block_height);
  return {
    payerWallet: String(row.payer_wallet),
    status: String(row.status) as LaunchAttemptStatus,
    tokenMint: row.token_mint ? String(row.token_mint) : null,
    txSig: row.tx_sig ? String(row.tx_sig) : null,
    lastValidBlockHeight: lvbh != null && Number.isFinite(lvbh) && lvbh > 0 ? lvbh : null,
    claimId: row.claim_id ? String(row.claim_id) : null,
    startedAtUnix: Number(row.started_at_unix),
    updatedAtUnix: Number(row.updated_at_unix),
  };
}

export async function getLaunchAttempt(payerWallet: string): Promise<LaunchAttempt | null> {
  await ensureSchema();
  if (!hasDatabase()) return mem.get(payerWallet) ?? null;
  const { rows } = await getPool().query("select * from launch_attempts where payer_wallet = $1", [payerWallet]);
  return rows[0] ? rowToAttempt(rows[0]) : null;
}

export type ClaimResult =
  | { ok: true; claimId: string }
  | { ok: false; reason: "in_progress" | "already_launched" | "pending_chain"; attempt: LaunchAttempt };

type ChainVerdict = "landed" | "dead" | "pending";

/**
 * Where does a 'submitted' launch stand on-chain?
 *  - landed:  the mint account exists or the signature confirmed
 *  - dead:    the signature failed on-chain, or its blockhash provably expired without it landing
 *  - pending: anything else (including RPC trouble) - never treat "can't tell" as dead
 */
export async function resolveSubmittedLaunch(attempt: LaunchAttempt, connection: Connection = getConnection()): Promise<ChainVerdict> {
  try {
    if (attempt.tokenMint) {
      const info = await withRetry(() => connection.getAccountInfo(new PublicKey(attempt.tokenMint as string), "confirmed"));
      if (info) return "landed";
    }
    if (attempt.txSig) {
      const state = await getSignatureOutcome(connection, attempt.txSig, attempt.lastValidBlockHeight);
      if (state.outcome === "confirmed") return "landed";
      if (state.outcome === "failed" || state.outcome === "expired") return "dead";
      if (attempt.lastValidBlockHeight == null && nowUnix() - attempt.updatedAtUnix > SUBMITTED_NO_LVBH_DEAD_SECONDS) {
        // Legacy row without lvbh: no status after 10 minutes and no mint account -> its blockhash is long gone.
        const st = await withRetry(() => connection.getSignatureStatuses([attempt.txSig as string], { searchTransactionHistory: true }));
        if (!st?.value?.[0]) return "dead";
      }
      return "pending";
    }
    // 'submitted' without a signature (pre-fix rows): only the age + missing mint can tell.
    return nowUnix() - attempt.updatedAtUnix > SUBMITTED_NO_LVBH_DEAD_SECONDS ? "dead" : "pending";
  } catch {
    return "pending";
  }
}

/**
 * Atomically claims the right to launch. Fails while another launch for this payer is running, is still pending
 * on-chain, or already landed. Returns a claim id that every later write of this launch must present.
 */
export async function claimLaunchAttempt(payerWallet: string, opts?: { connection?: Connection }): Promise<ClaimResult> {
  await ensureSchema();
  const t = nowUnix();
  const claimId = crypto.randomBytes(12).toString("hex");

  // A 'submitted' attempt is resolved against the chain first: landed -> recorded as such; dead -> re-claimable.
  let deadSubmittedSig: string | null | undefined; // undefined = no dead submitted attempt to take over
  const current = await getLaunchAttempt(payerWallet);
  if (current?.status === "submitted") {
    const verdict = await resolveSubmittedLaunch(current, opts?.connection);
    if (verdict === "landed") {
      await updateLaunchAttempt(payerWallet, { status: "onchain_unrecorded", expectTxSig: current.txSig }).catch(() => null);
      return { ok: false, reason: "already_launched", attempt: { ...current, status: "onchain_unrecorded" } };
    }
    if (verdict === "pending") return { ok: false, reason: "pending_chain", attempt: current };
    deadSubmittedSig = current.txSig;
  }

  if (!hasDatabase()) {
    const cur = mem.get(payerWallet);
    if (cur) {
      const takeOverDead = cur.status === "submitted" && deadSubmittedSig !== undefined && cur.txSig === deadSubmittedSig;
      const blocked = takeOverDead ? null : classifyBlocked(cur, t);
      if (blocked) return { ok: false, reason: blocked, attempt: cur };
    }
    mem.set(payerWallet, { payerWallet, status: "in_flight", tokenMint: null, txSig: null, lastValidBlockHeight: null, claimId, startedAtUnix: t, updatedAtUnix: t });
    return { ok: true, claimId };
  }

  const pool = getPool();
  const claimed = await pool.query(
    `insert into launch_attempts (payer_wallet, status, token_mint, tx_sig, last_valid_block_height, claim_id, started_at_unix, updated_at_unix)
     values ($1, 'in_flight', null, null, null, $5, $2, $2)
     on conflict (payer_wallet) do update
       set status = 'in_flight', token_mint = null, tx_sig = null, last_valid_block_height = null, claim_id = $5,
           started_at_unix = $2, updated_at_unix = $2
       where launch_attempts.status = 'failed'
          or (launch_attempts.status = 'in_flight' and launch_attempts.started_at_unix < $2 - $3)
          or ($4::boolean and launch_attempts.status = 'submitted' and launch_attempts.tx_sig is not distinct from $6)
     returning payer_wallet`,
    [payerWallet, String(t), IN_FLIGHT_STALE_SECONDS, deadSubmittedSig !== undefined, claimId, deadSubmittedSig ?? null]
  );
  if (claimed.rows[0]) return { ok: true, claimId };

  const attempt = (await getLaunchAttempt(payerWallet)) as LaunchAttempt;
  const reason = classifyBlocked(attempt, t) ?? "in_progress";
  return { ok: false, reason, attempt };
}

function classifyBlocked(a: LaunchAttempt, t: number): "in_progress" | "already_launched" | "pending_chain" | null {
  if (a.status === "failed") return null;
  if (a.status === "in_flight") return t - a.startedAtUnix < IN_FLIGHT_STALE_SECONDS ? "in_progress" : null;
  if (a.status === "submitted") return "pending_chain";
  return "already_launched";
}

/**
 * Records the signature of a launch transaction BEFORE it is broadcast. Compare-and-set on the claim id: returns false
 * (and the caller must NOT broadcast) when this request no longer owns the launch slot.
 */
export async function markLaunchSubmitted(
  payerWallet: string,
  input: { claimId: string; tokenMint: string; txSig: string; lastValidBlockHeight: number }
): Promise<boolean> {
  await ensureSchema();
  const t = nowUnix();

  if (!hasDatabase()) {
    const cur = mem.get(payerWallet);
    if (!cur || cur.claimId !== input.claimId || (cur.status !== "in_flight" && cur.status !== "submitted")) return false;
    mem.set(payerWallet, { ...cur, status: "submitted", tokenMint: input.tokenMint, txSig: input.txSig, lastValidBlockHeight: input.lastValidBlockHeight, updatedAtUnix: t });
    return true;
  }

  const res = await getPool().query(
    `update launch_attempts
        set status = 'submitted', token_mint = $3, tx_sig = $4, last_valid_block_height = $5, updated_at_unix = $6
      where payer_wallet = $1 and claim_id = $2 and status in ('in_flight', 'submitted')
      returning payer_wallet`,
    [payerWallet, input.claimId, input.tokenMint, input.txSig, String(Math.floor(input.lastValidBlockHeight)), String(t)]
  );
  return Boolean(res.rows[0]);
}

/**
 * Moves an attempt to a new status. `claimId` / `expectTxSig` turn it into a compare-and-set so a request can never
 * overwrite a launch slot that was taken over by another request.
 */
export async function updateLaunchAttempt(
  payerWallet: string,
  patch: { status: LaunchAttemptStatus; tokenMint?: string | null; txSig?: string | null; claimId?: string | null; expectTxSig?: string | null }
): Promise<boolean> {
  await ensureSchema();
  const t = nowUnix();

  if (!hasDatabase()) {
    const cur = mem.get(payerWallet);
    if (!cur) return false;
    if (patch.claimId && cur.claimId !== patch.claimId) return false;
    if (patch.expectTxSig !== undefined && cur.txSig !== (patch.expectTxSig ?? null)) return false;
    mem.set(payerWallet, { ...cur, status: patch.status, tokenMint: patch.tokenMint ?? cur.tokenMint, txSig: patch.txSig ?? cur.txSig, updatedAtUnix: t });
    return true;
  }

  const res = await getPool().query(
    `update launch_attempts
        set status = $2, token_mint = coalesce($3, token_mint), tx_sig = coalesce($4, tx_sig), updated_at_unix = $5
      where payer_wallet = $1
        and ($6::text is null or claim_id = $6)
        and (not $7::boolean or tx_sig is not distinct from $8)
      returning payer_wallet`,
    [
      payerWallet,
      patch.status,
      patch.tokenMint ?? null,
      patch.txSig ?? null,
      String(t),
      patch.claimId ?? null,
      patch.expectTxSig !== undefined,
      patch.expectTxSig ?? null,
    ]
  );
  return Boolean(res.rows[0]);
}
