import crypto from "crypto";

import { getPool, hasDatabase } from "./db";

type LockRow = {
  commitmentId: string;
  milestoneId: string;
  createdAtUnix: number;
  txSig?: string | null;
  ownerToken?: string | null;
};

const mem = {
  locks: new Map<string, LockRow>(),
};

let ensuredSchema: Promise<void> | null = null;

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function key(commitmentId: string, milestoneId: string): string {
  return `${commitmentId}:${milestoneId}`;
}

async function ensureSchema(): Promise<void> {
  if (!hasDatabase()) return;
  if (ensuredSchema) return ensuredSchema;

  ensuredSchema = (async () => {
    const pool = getPool();
    await pool.query(`
      create table if not exists reward_release_locks (
        commitment_id text not null,
        milestone_id text not null,
        created_at_unix bigint not null,
        tx_sig text null,
        primary key (commitment_id, milestone_id)
      );
    `);
    await pool.query("alter table reward_release_locks add column if not exists owner_token text null");
  })().catch((e) => {
    ensuredSchema = null;
    throw e;
  });

  return ensuredSchema;
}

export async function tryAcquireRewardReleaseLock(input: {
  commitmentId: string;
  milestoneId: string;
}): Promise<{ acquired: true; token: string } | { acquired: false; existing: LockRow }> {
  await ensureSchema();

  const createdAtUnix = nowUnix();
  const token = crypto.randomBytes(16).toString("hex");

  if (!hasDatabase()) {
    const k = key(input.commitmentId, input.milestoneId);
    const existing = mem.locks.get(k);
    if (existing) return { acquired: false, existing };
    mem.locks.set(k, { commitmentId: input.commitmentId, milestoneId: input.milestoneId, createdAtUnix, txSig: null, ownerToken: token });
    return { acquired: true, token };
  }

  const pool = getPool();
  const res = await pool.query(
    `insert into reward_release_locks (commitment_id, milestone_id, created_at_unix, tx_sig, owner_token)
     values ($1,$2,$3,null,$4)
     on conflict (commitment_id, milestone_id) do nothing
     returning commitment_id`,
    [input.commitmentId, input.milestoneId, String(createdAtUnix), token]
  );

  if (res.rows[0]) return { acquired: true, token };

  const existingRes = await pool.query(
    "select commitment_id, milestone_id, created_at_unix, tx_sig from reward_release_locks where commitment_id=$1 and milestone_id=$2",
    [input.commitmentId, input.milestoneId]
  );
  const row = existingRes.rows[0];
  const existing: LockRow = {
    commitmentId: input.commitmentId,
    milestoneId: input.milestoneId,
    createdAtUnix: row ? Number(row.created_at_unix) : createdAtUnix,
    txSig: row ? (row.tx_sig ?? null) : null,
  };
  return { acquired: false, existing };
}

/**
 * Releases the lock. With `token` only the holder's lock is deleted (CAS) - a lock that recorded a tx signature is
 * never deleted by a non-holder. Without `token` (legacy callers) the lock is deleted unless it holds a signature.
 */
export async function releaseRewardReleaseLock(input: { commitmentId: string; milestoneId: string; token?: string }): Promise<void> {
  await ensureSchema();

  if (!hasDatabase()) {
    const k = key(input.commitmentId, input.milestoneId);
    const cur = mem.locks.get(k);
    if (!cur) return;
    if (input.token ? cur.ownerToken === input.token : !cur.txSig) mem.locks.delete(k);
    return;
  }

  const pool = getPool();
  if (input.token) {
    await pool.query("delete from reward_release_locks where commitment_id=$1 and milestone_id=$2 and owner_token=$3", [input.commitmentId, input.milestoneId, input.token]);
    return;
  }
  await pool.query("delete from reward_release_locks where commitment_id=$1 and milestone_id=$2 and tx_sig is null", [input.commitmentId, input.milestoneId]);
}

export async function setRewardReleaseLockTxSig(input: {
  commitmentId: string;
  milestoneId: string;
  txSig: string;
}): Promise<void> {
  await ensureSchema();

  if (!hasDatabase()) {
    const k = key(input.commitmentId, input.milestoneId);
    const existing = mem.locks.get(k);
    if (existing) mem.locks.set(k, { ...existing, txSig: input.txSig });
    return;
  }

  const pool = getPool();
  await pool.query(
    "update reward_release_locks set tx_sig=$3 where commitment_id=$1 and milestone_id=$2",
    [input.commitmentId, input.milestoneId, input.txSig]
  );
}
