import { hasDatabase, getPool } from "./db";
import { privyCreateSolanaWallet } from "./privy";

export type LaunchTreasuryWalletRecord = {
  payerWallet: string;
  walletId: string;
  treasuryWallet: string;
  createdAtUnix: number;
  updatedAtUnix: number;
};

const mem = {
  byPayer: new Map<string, LaunchTreasuryWalletRecord>(),
};

let ensuredSchema: Promise<void> | null = null;

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

async function ensureSchema(): Promise<void> {
  if (!hasDatabase()) return;
  if (ensuredSchema) return ensuredSchema;

  ensuredSchema = (async () => {
    const pool = getPool();
    await pool.query(`
      create table if not exists public.launch_treasury_wallets (
        payer_wallet text primary key,
        wallet_id text not null,
        treasury_wallet text not null,
        created_at_unix bigint not null,
        updated_at_unix bigint not null
      );
      create index if not exists launch_treasury_wallets_updated_idx on public.launch_treasury_wallets(updated_at_unix);
      create index if not exists launch_treasury_wallets_treasury_idx on public.launch_treasury_wallets(treasury_wallet);
    `);
  })().catch((e) => {
    ensuredSchema = null;
    throw e;
  });

  return ensuredSchema;
}

function rowToRecord(row: any): LaunchTreasuryWalletRecord {
  return {
    payerWallet: String(row.payer_wallet),
    walletId: String(row.wallet_id),
    treasuryWallet: String(row.treasury_wallet),
    createdAtUnix: Number(row.created_at_unix),
    updatedAtUnix: Number(row.updated_at_unix),
  };
}

export async function getLaunchTreasuryWallet(payerWallet: string): Promise<LaunchTreasuryWalletRecord | null> {
  await ensureSchema();

  const key = String(payerWallet ?? "").trim();
  if (!key) return null;

  if (!hasDatabase()) {
    return mem.byPayer.get(key) ?? null;
  }

  const pool = getPool();
  const res = await pool.query("select * from public.launch_treasury_wallets where payer_wallet=$1", [key]);
  const row = res.rows[0];
  return row ? rowToRecord(row) : null;
}

/** Reverse lookup: which payer's launch wallet is this address? (null = not a launch wallet we created) */
export async function getLaunchTreasuryWalletByAddress(treasuryWallet: string): Promise<LaunchTreasuryWalletRecord | null> {
  await ensureSchema();

  const key = String(treasuryWallet ?? "").trim();
  if (!key) return null;

  if (!hasDatabase()) {
    return Array.from(mem.byPayer.values()).find((r) => r.treasuryWallet === key) ?? null;
  }

  const res = await getPool().query("select * from public.launch_treasury_wallets where treasury_wallet=$1 limit 1", [key]);
  const row = res.rows[0];
  return row ? rowToRecord(row) : null;
}

/**
 * Is this wallet (in any status, archived included) a commitment's escrow or creator authority? A launch wallet that
 * launched a token IS that token's fee escrow, so admin refunds/sweeps must never move its SOL.
 * Returns the commitment id, or null. Throws if it can't tell (callers must then refuse).
 */
export async function findCommitmentUsingWallet(address: string): Promise<string | null> {
  const key = String(address ?? "").trim();
  if (!key) return null;

  const { listCommitments } = await import("./escrowStore");
  if (!hasDatabase()) {
    const hit = (await listCommitments()).find((c) => c.escrowPubkey === key || c.authority === key);
    return hit ? hit.id : null;
  }

  // listCommitments() also creates the table on a fresh database; the direct query keeps this cheap afterwards.
  try {
    const res = await getPool().query("select id from commitments where escrow_pubkey = $1 or authority = $1 limit 1", [key]);
    return res.rows[0] ? String(res.rows[0].id) : null;
  } catch {
    const hit = (await listCommitments()).find((c) => c.escrowPubkey === key || c.authority === key);
    return hit ? hit.id : null;
  }
}

/** Launch wallets created at/after `sinceUnix`, newest first (admin sweep of abandoned top-ups). */
export async function listLaunchTreasuryWallets(input: { sinceUnix: number; limit: number }): Promise<LaunchTreasuryWalletRecord[]> {
  await ensureSchema();
  const limit = Math.max(1, Math.min(500, Math.floor(Number(input.limit) || 50)));
  const since = Math.max(0, Math.floor(Number(input.sinceUnix) || 0));

  if (!hasDatabase()) {
    return Array.from(mem.byPayer.values())
      .filter((r) => r.createdAtUnix >= since)
      .sort((a, b) => b.createdAtUnix - a.createdAtUnix)
      .slice(0, limit);
  }

  const res = await getPool().query(
    "select * from public.launch_treasury_wallets where created_at_unix >= $1 order by created_at_unix desc limit $2",
    [String(since), String(limit)]
  );
  return res.rows.map(rowToRecord);
}

export async function getOrCreateLaunchTreasuryWallet(input: {
  payerWallet: string;
}): Promise<{ record: LaunchTreasuryWalletRecord; created: boolean }> {
  await ensureSchema();

  const payerWallet = String(input.payerWallet ?? "").trim();
  if (!payerWallet) throw new Error("payerWallet is required");

  const existing = await getLaunchTreasuryWallet(payerWallet);
  if (existing) return { record: existing, created: false };

  // Deterministic per payer: a retry after a lost response/failed insert gets the wallet Privy already made.
  const { walletId, address } = await privyCreateSolanaWallet({ operationKey: `launch-treasury:${payerWallet}` });
  const ts = nowUnix();

  const rec: LaunchTreasuryWalletRecord = {
    payerWallet,
    walletId,
    treasuryWallet: address,
    createdAtUnix: ts,
    updatedAtUnix: ts,
  };

  if (!hasDatabase()) {
    mem.byPayer.set(payerWallet, rec);
    return { record: rec, created: true };
  }

  const pool = getPool();
  try {
    await pool.query(
      "insert into public.launch_treasury_wallets (payer_wallet, wallet_id, treasury_wallet, created_at_unix, updated_at_unix) values ($1,$2,$3,$4,$5)",
      [payerWallet, walletId, address, String(ts), String(ts)]
    );
    return { record: rec, created: true };
  } catch {
    const after = await getLaunchTreasuryWallet(payerWallet);
    if (after) return { record: after, created: false };
    throw new Error("Failed to create or load treasury wallet");
  }
}

export type LaunchWalletRefundResult =
  | { ok: true; signature: string; refundedLamports: number }
  | { ok: false; status: number; code: string; error: string; commitmentId?: string | null };

/**
 * Admin refund of a launch wallet's SOL back to the payer that funded it. Wallet id, source and destination all come
 * from launch_treasury_wallets (never from a request), and the launch wallet is refused when:
 *  - it is (or ever was) a commitment escrow/authority - i.e. it launched a token and now holds creator fees;
 *  - a launch for its payer is running, pending on-chain or landed. The launch slot is CLAIMED for the duration of
 *    the refund, so a launch can't start spending the same SOL concurrently.
 */
export async function refundLaunchWalletToPayer(input: {
  record: LaunchTreasuryWalletRecord;
  keepLamports?: number;
}): Promise<LaunchWalletRefundResult> {
  const { record } = input;
  const commitmentId = await findCommitmentUsingWallet(record.treasuryWallet);
  if (commitmentId) {
    return { ok: false, status: 409, code: "LIVE_ESCROW", error: "This launch wallet is a live commitment escrow; it can't be refunded", commitmentId };
  }

  const { claimLaunchAttempt, updateLaunchAttempt } = await import("./launchAttemptStore");
  const claim = await claimLaunchAttempt(record.payerWallet);
  if (!claim.ok) {
    return {
      ok: false,
      status: 409,
      code: claim.reason === "already_launched" ? "ALREADY_LAUNCHED" : "LAUNCH_IN_PROGRESS",
      error:
        claim.reason === "already_launched"
          ? "This payer's launch is on-chain; its wallet holds the token's fees"
          : "A launch for this payer is running or still confirming",
    };
  }

  try {
    // Re-check under the claim: a launch that recorded its commitment between the two checks is caught here.
    const lateCommitmentId = await findCommitmentUsingWallet(record.treasuryWallet);
    if (lateCommitmentId) {
      return { ok: false, status: 409, code: "LIVE_ESCROW", error: "This launch wallet is a live commitment escrow; it can't be refunded", commitmentId: lateCommitmentId };
    }
    const { PublicKey } = await import("@solana/web3.js");
    const { privyRefundWalletToDestination } = await import("./privy");
    const { getSolanaCaip2 } = await import("./solana");
    const res = await privyRefundWalletToDestination({
      walletId: record.walletId,
      fromPubkey: new PublicKey(record.treasuryWallet),
      toPubkey: new PublicKey(record.payerWallet),
      caip2: getSolanaCaip2(),
      keepLamports: input.keepLamports,
    });
    if (!res.ok) return { ok: false, status: 502, code: "REFUND_FAILED", error: res.error };
    return { ok: true, signature: res.signature, refundedLamports: res.refundedLamports };
  } finally {
    await updateLaunchAttempt(record.payerWallet, { status: "failed", claimId: claim.claimId }).catch(() => null);
  }
}
