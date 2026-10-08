import crypto from "crypto";

import { getPool, hasDatabase } from "./db";

type LockRow = {
  creatorPubkey: string;
  createdAtUnix: number;
  /** Signature of the sweep transaction that was (about to be) broadcast while holding the lock. */
  txSig?: string | null;
  pendingLvbh?: number | null;
  ownerToken?: string | null;
};

const mem = {
  locks: new Map<string, LockRow>(),
};

let ensuredSchema: Promise<void> | null = null;

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function newToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

async function ensureSchema(): Promise<void> {
  if (!hasDatabase()) return;
  if (ensuredSchema) return ensuredSchema;

  ensuredSchema = (async () => {
    const pool = getPool();
    await pool.query(`
      create table if not exists pumpfun_creator_fee_claim_locks (
        creator_pubkey text primary key,
        created_at_unix bigint not null,
        tx_sig text null
      );
    `);
    await pool.query("alter table pumpfun_creator_fee_claim_locks add column if not exists owner_token text null");
    await pool.query("alter table pumpfun_creator_fee_claim_locks add column if not exists pending_lvbh bigint null");
  })().catch((e) => {
    ensuredSchema = null;
    throw e;
  });

  return ensuredSchema;
}

function rowToLock(creatorPubkey: string, row: any): LockRow {
  return {
    creatorPubkey,
    createdAtUnix: Number(row?.created_at_unix ?? 0),
    txSig: row?.tx_sig ? String(row.tx_sig) : null,
    pendingLvbh: row?.pending_lvbh != null ? Number(row.pending_lvbh) : null,
    ownerToken: row?.owner_token ? String(row.owner_token) : null,
  };
}

/**
 * Per-creator sweep lock. A lock older than `maxAgeSeconds` may be taken over, but only with a compare-and-set on
 * (created_at_unix, owner_token), and - when it recorded a pending transaction - only after `canTakeOver` confirmed
 * that transaction is settled (landed and accounted, failed, or provably expired).
 */
export async function tryAcquirePumpfunCreatorFeeClaimLock(input: {
  creatorPubkey: string;
  maxAgeSeconds: number;
  canTakeOver?: (existing: LockRow) => Promise<boolean>;
}): Promise<{ acquired: true; token: string } | { acquired: false; existing: LockRow }> {
  await ensureSchema();

  const createdAtUnix = nowUnix();
  const maxAgeSeconds = Math.max(10, Math.min(30 * 60, input.maxAgeSeconds));
  const token = newToken();

  const mayTakeOver = async (existing: LockRow): Promise<boolean> => {
    if (createdAtUnix - existing.createdAtUnix <= maxAgeSeconds) return false;
    if (!existing.txSig) return true;
    if (!input.canTakeOver) return false;
    try {
      return await input.canTakeOver(existing);
    } catch {
      return false;
    }
  };

  if (!hasDatabase()) {
    const existing = mem.locks.get(input.creatorPubkey);
    if (!existing) {
      mem.locks.set(input.creatorPubkey, { creatorPubkey: input.creatorPubkey, createdAtUnix, txSig: null, ownerToken: token });
      return { acquired: true, token };
    }
    if (await mayTakeOver(existing)) {
      const current = mem.locks.get(input.creatorPubkey);
      if (current && current.createdAtUnix === existing.createdAtUnix && (current.ownerToken ?? null) === (existing.ownerToken ?? null)) {
        mem.locks.set(input.creatorPubkey, { creatorPubkey: input.creatorPubkey, createdAtUnix, txSig: null, ownerToken: token });
        return { acquired: true, token };
      }
    }
    return { acquired: false, existing };
  }

  const pool = getPool();

  const res = await pool.query(
    `insert into pumpfun_creator_fee_claim_locks (creator_pubkey, created_at_unix, tx_sig, owner_token)
     values ($1,$2,null,$3)
     on conflict (creator_pubkey) do nothing
     returning creator_pubkey`,
    [input.creatorPubkey, String(createdAtUnix), token]
  );

  if (res.rows[0]) return { acquired: true, token };

  const existingRes = await pool.query(
    "select creator_pubkey, created_at_unix, tx_sig, owner_token, pending_lvbh from pumpfun_creator_fee_claim_locks where creator_pubkey=$1",
    [input.creatorPubkey]
  );
  const row = existingRes.rows[0];
  if (!row) return tryAcquirePumpfunCreatorFeeClaimLock(input);
  const existing = rowToLock(input.creatorPubkey, row);

  if (await mayTakeOver(existing)) {
    const takeOver = await pool.query(
      `update pumpfun_creator_fee_claim_locks set created_at_unix=$2, tx_sig=null, pending_lvbh=null, owner_token=$3
       where creator_pubkey=$1 and created_at_unix=$4 and owner_token is not distinct from $5 and tx_sig is not distinct from $6
       returning creator_pubkey`,
      [input.creatorPubkey, String(createdAtUnix), token, String(existing.createdAtUnix), existing.ownerToken ?? null, existing.txSig ?? null]
    );
    if (takeOver.rows[0]) return { acquired: true, token };
  }

  return { acquired: false, existing };
}

/**
 * Records the signature about to be broadcast under the lock (CAS on the owner token and the previously recorded
 * signature). Returns false when the lock is no longer ours - the caller must then not broadcast.
 */
export async function setPumpfunCreatorFeeClaimLockTxSig(input: {
  creatorPubkey: string;
  token: string;
  txSig: string;
  lastValidBlockHeight: number;
  previousTxSig: string | null;
}): Promise<boolean> {
  await ensureSchema();
  if (!hasDatabase()) {
    const cur = mem.locks.get(input.creatorPubkey);
    if (!cur || cur.ownerToken !== input.token || (cur.txSig ?? null) !== (input.previousTxSig ?? null)) return false;
    mem.locks.set(input.creatorPubkey, { ...cur, txSig: input.txSig, pendingLvbh: input.lastValidBlockHeight });
    return true;
  }
  const res = await getPool().query(
    `update pumpfun_creator_fee_claim_locks set tx_sig=$3, pending_lvbh=$4
     where creator_pubkey=$1 and owner_token=$2 and tx_sig is not distinct from $5 returning 1`,
    [input.creatorPubkey, input.token, input.txSig, String(input.lastValidBlockHeight), input.previousTxSig ?? null]
  );
  return Boolean(res.rows[0]);
}

/**
 * Releases the lock. With `token`, only the holder's lock is touched (CAS). `keepPendingSig` leaves the recorded
 * signature behind as an already-stale lock, so the next sweep resolves (and accounts) it before doing anything else.
 * Without `token` (legacy callers) the lock is deleted unconditionally.
 */
export async function releasePumpfunCreatorFeeClaimLock(input: { creatorPubkey: string; token?: string; keepPendingSig?: boolean }): Promise<void> {
  await ensureSchema();

  if (!hasDatabase()) {
    const cur = mem.locks.get(input.creatorPubkey);
    if (!cur) return;
    if (input.token && cur.ownerToken !== input.token) return;
    if (input.keepPendingSig && cur.txSig) mem.locks.set(input.creatorPubkey, { ...cur, createdAtUnix: 0, ownerToken: null });
    else mem.locks.delete(input.creatorPubkey);
    return;
  }

  const pool = getPool();
  if (!input.token) {
    await pool.query("delete from pumpfun_creator_fee_claim_locks where creator_pubkey=$1", [input.creatorPubkey]);
    return;
  }
  if (input.keepPendingSig) {
    const kept = await pool.query(
      "update pumpfun_creator_fee_claim_locks set created_at_unix=0, owner_token=null where creator_pubkey=$1 and owner_token=$2 and tx_sig is not null returning 1",
      [input.creatorPubkey, input.token]
    );
    if (kept.rows[0]) return;
  }
  await pool.query("delete from pumpfun_creator_fee_claim_locks where creator_pubkey=$1 and owner_token=$2", [input.creatorPubkey, input.token]);
}
