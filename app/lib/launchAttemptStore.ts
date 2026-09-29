import { getPool, hasDatabase } from "./db";

/**
 * One launch per payer wallet at a time, and a durable record of what was sent on-chain.
 * Prevents double-launches from double clicks / two tabs / client retries, and keeps the mint + tx signature
 * around if the process dies between "tx confirmed" and "commitment saved".
 */

export type LaunchAttemptStatus = "in_flight" | "submitted" | "confirmed" | "onchain_unrecorded" | "failed";

export type LaunchAttempt = {
  payerWallet: string;
  status: LaunchAttemptStatus;
  tokenMint: string | null;
  txSig: string | null;
  startedAtUnix: number;
  updatedAtUnix: number;
};

const IN_FLIGHT_STALE_SECONDS = 5 * 60;
// A submitted tx can legitimately take a while to resolve; give it longer before another launch is allowed.
const SUBMITTED_STALE_SECONDS = 10 * 60;

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
    `);
  })().catch((e) => {
    ensured = null;
    throw e;
  });
  return ensured;
}

function rowToAttempt(row: any): LaunchAttempt {
  return {
    payerWallet: String(row.payer_wallet),
    status: String(row.status) as LaunchAttemptStatus,
    tokenMint: row.token_mint ? String(row.token_mint) : null,
    txSig: row.tx_sig ? String(row.tx_sig) : null,
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

export type ClaimResult = { ok: true } | { ok: false; reason: "in_progress" | "already_launched" | "pending_chain"; attempt: LaunchAttempt };

/** Atomically claims the right to launch. Fails while another launch for this payer is running or already on-chain. */
export async function claimLaunchAttempt(payerWallet: string): Promise<ClaimResult> {
  await ensureSchema();
  const t = nowUnix();

  if (!hasDatabase()) {
    const cur = mem.get(payerWallet);
    if (cur) {
      const blocked = classifyBlocked(cur, t);
      if (blocked) return { ok: false, reason: blocked, attempt: cur };
    }
    mem.set(payerWallet, { payerWallet, status: "in_flight", tokenMint: null, txSig: null, startedAtUnix: t, updatedAtUnix: t });
    return { ok: true };
  }

  const pool = getPool();
  const claimed = await pool.query(
    `insert into launch_attempts (payer_wallet, status, token_mint, tx_sig, started_at_unix, updated_at_unix)
     values ($1, 'in_flight', null, null, $2, $2)
     on conflict (payer_wallet) do update
       set status = 'in_flight', token_mint = null, tx_sig = null, started_at_unix = $2, updated_at_unix = $2
       where launch_attempts.status = 'failed'
          or (launch_attempts.status = 'in_flight' and launch_attempts.started_at_unix < $2 - $3)
          or (launch_attempts.status = 'submitted' and launch_attempts.started_at_unix < $2 - $4)
     returning payer_wallet`,
    [payerWallet, String(t), IN_FLIGHT_STALE_SECONDS, SUBMITTED_STALE_SECONDS]
  );
  if (claimed.rows[0]) return { ok: true };

  const attempt = (await getLaunchAttempt(payerWallet)) as LaunchAttempt;
  const reason = classifyBlocked(attempt, t) ?? "in_progress";
  return { ok: false, reason, attempt };
}

function classifyBlocked(a: LaunchAttempt, t: number): "in_progress" | "already_launched" | "pending_chain" | null {
  if (a.status === "failed") return null;
  if (a.status === "in_flight") return t - a.startedAtUnix < IN_FLIGHT_STALE_SECONDS ? "in_progress" : null;
  if (a.status === "submitted") return t - a.startedAtUnix < SUBMITTED_STALE_SECONDS ? "pending_chain" : null;
  return "already_launched";
}

export async function updateLaunchAttempt(
  payerWallet: string,
  patch: { status: LaunchAttemptStatus; tokenMint?: string | null; txSig?: string | null }
): Promise<void> {
  await ensureSchema();
  const t = nowUnix();

  if (!hasDatabase()) {
    const cur = mem.get(payerWallet);
    if (cur) mem.set(payerWallet, { ...cur, status: patch.status, tokenMint: patch.tokenMint ?? cur.tokenMint, txSig: patch.txSig ?? cur.txSig, updatedAtUnix: t });
    return;
  }

  await getPool().query(
    `update launch_attempts
        set status = $2, token_mint = coalesce($3, token_mint), tx_sig = coalesce($4, tx_sig), updated_at_unix = $5
      where payer_wallet = $1`,
    [payerWallet, patch.status, patch.tokenMint ?? null, patch.txSig ?? null, String(t)]
  );
}
