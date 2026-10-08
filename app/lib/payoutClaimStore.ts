/**
 * Payout claim bookkeeping that makes every escrow/faucet payout exactly-once:
 *
 *  - every payout is guarded by a claim row (existing tables, owned by escrowStore) that this module extends with
 *    `claim_token` (who holds the claim), `pending_tx_sig` + `pending_lvbh` (the signature and blockhash expiry of the
 *    transaction that is about to be / was broadcast - written BEFORE broadcast) and `pending_at_unix`;
 *  - `tx_sig` keeps its old meaning: the payout is confirmed on-chain (all existing readers keep working);
 *  - a claim is only ever taken over or released when the chain proves the pending transaction can no longer land
 *    (failed on-chain, or finalized block height past its lastValidBlockHeight with no status), never by age alone;
 *  - every takeover / pending update / release is a compare-and-set on (claim_token, pending_tx_sig).
 */
import crypto from "crypto";
import { NextResponse } from "next/server";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { PoolClient } from "pg";

import { getPool, hasDatabase } from "./db";
import { auditLog } from "./auditLog";
import { checkRateLimit } from "./rateLimit";
import { apiError } from "./apiError";
import { getSafeErrorMessage, redactSensitive } from "./safeError";
import {
  RewardMilestone,
  claimForFailureSettlement,
  claimForResolution,
  deleteRewardMilestonePayoutClaim,
  finalizeCommitmentStatus,
  finalizeResolution,
  releaseFailureSettlementClaim,
  releaseResolutionClaim,
  getCommitment,
  getEscrowSignerRef,
  getMilestoneFailureReservedLamports,
  getRewardApprovalThreshold,
  getRewardMilestonePayoutClaim,
  getRewardMilestoneVoteCounts,
  normalizeRewardMilestonesClaimable,
  publicView,
  releaseFailureDistributionClaim,
  releaseMilestoneFailureDistributionClaim,
  setFailureDistributionClaimTxSig,
  setMilestoneFailureDistributionClaimTxSig,
  setRewardMilestonePayoutClaimTxSig,
  sumReleasedLamports,
  tryAcquireFailureDistributionClaim,
  tryAcquireMilestoneFailureDistributionClaim,
  tryAcquireRewardMilestonePayoutClaim,
  updateRewardTotalsAndMilestones,
} from "./escrowStore";
import type { CommitmentRecord } from "./escrowStore";
import { broadcastUntilFinal, buildPriorityFeeInstructions, getServerCommitment, getSignatureOutcome, isTxSendError, signatureFromRawTransaction, withRetry } from "./rpc";
import {
  buildCreateAssociatedTokenAccountIdempotentInstruction,
  buildSplTokenTransferInstruction,
  closeNativeWsolTokenAccounts,
  findSystemTransferSignature,
  getAssociatedTokenAddress,
  getBalanceLamports,
  getBlockhashExpiryBound,
  getChainUnixTime,
  getConnection,
  getMintDecimals,
  getRentExemptMinLamports,
  keypairFromBase58Secret,
  payoutSignerFromEscrowRef,
  privySignTransactionVerified,
  transferLamportsFromSigner,
  verifyExactUserTransaction,
} from "./solana";

// ---------------------------------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------------------------------

export type ClaimTable =
  | "reward_milestone_payout_claims"
  | "failure_distribution_claims"
  | "milestone_failure_distribution_claims"
  | "vote_reward_distribution_claims"
  | "payout_intents";

const SPECS: Record<ClaimTable, { k1: string; k2: string | null; created: string }> = {
  reward_milestone_payout_claims: { k1: "commitment_id", k2: "milestone_id", created: "created_at_unix" },
  failure_distribution_claims: { k1: "distribution_id", k2: "wallet_pubkey", created: "claimed_at_unix" },
  milestone_failure_distribution_claims: { k1: "distribution_id", k2: "wallet_pubkey", created: "claimed_at_unix" },
  vote_reward_distribution_claims: { k1: "distribution_id", k2: "wallet_pubkey", created: "claimed_at_unix" },
  payout_intents: { k1: "intent_key", k2: null, created: "created_at_unix" },
};

const EXTENDED_TABLES: ClaimTable[] = [
  "reward_milestone_payout_claims",
  "failure_distribution_claims",
  "milestone_failure_distribution_claims",
  "vote_reward_distribution_claims",
];

let ensured: Promise<void> | null = null;

export async function ensurePayoutClaimSchema(): Promise<void> {
  if (!hasDatabase()) return;
  if (ensured) return ensured;

  ensured = (async () => {
    // Runs escrowStore's own schema bootstrap so the base claim tables exist before they are extended.
    await getRewardMilestonePayoutClaim({ commitmentId: "__schema__", milestoneId: "__schema__" });

    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('cts_payout_claim_schema'))");
      for (const t of EXTENDED_TABLES) {
        await client.query(`alter table ${t} add column if not exists claim_token text null`);
        await client.query(`alter table ${t} add column if not exists pending_tx_sig text null`);
        await client.query(`alter table ${t} add column if not exists pending_lvbh bigint null`);
        await client.query(`alter table ${t} add column if not exists pending_at_unix bigint null`);
      }
      await client.query(`
        create table if not exists payout_intents (
          intent_key text primary key,
          kind text not null,
          created_at_unix bigint not null,
          to_pubkey text not null,
          amount_lamports bigint null,
          claim_token text null,
          pending_tx_sig text null,
          pending_lvbh bigint null,
          pending_at_unix bigint null,
          tx_sig text null,
          amount_paid_lamports bigint null
        )
      `);
      await client.query(`
        create table if not exists escrow_sweep_ledger (
          signature text primary key,
          commitment_id text not null,
          source text not null,
          lamports bigint not null,
          created_at_unix bigint not null
        )
      `);
      await client.query("commit");
    } catch (e) {
      try {
        await client.query("rollback");
      } catch {
        // ignore
      }
      throw e;
    } finally {
      client.release();
    }
  })().catch((e) => {
    ensured = null;
    throw e;
  });

  return ensured;
}

// ---------------------------------------------------------------------------------------------------------------------
// Claim slots
// ---------------------------------------------------------------------------------------------------------------------

export type ClaimSlot = { table: ClaimTable; k1: string; k2?: string | null };

export type ClaimSlotState = {
  createdAtUnix: number;
  txSig: string | null;
  claimToken: string | null;
  pendingTxSig: string | null;
  pendingLvbh: number | null;
  pendingAtUnix: number | null;
  amount: string;
  toPubkey: string | null;
};

const mem = {
  slots: new Map<string, ClaimSlotState>(),
  ledger: new Set<string>(),
};

function slotKey(slot: ClaimSlot): string {
  return `${slot.table}|${slot.k1}|${slot.k2 ?? ""}`;
}

function keyWhere(slot: ClaimSlot, firstParam: number): { sql: string; params: string[] } {
  const spec = SPECS[slot.table];
  if (spec.k2) return { sql: `${spec.k1}=$${firstParam} and ${spec.k2}=$${firstParam + 1}`, params: [slot.k1, String(slot.k2 ?? "")] };
  return { sql: `${spec.k1}=$${firstParam}`, params: [slot.k1] };
}

function emptyTxSig(): string {
  return "(tx_sig is null or tx_sig='')";
}

function cleanSig(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function rowToState(table: ClaimTable, row: any): ClaimSlotState {
  const spec = SPECS[table];
  const amount =
    row.amount_lamports != null ? String(row.amount_lamports) : row.amount_raw != null ? String(row.amount_raw) : "0";
  return {
    createdAtUnix: Number(row[spec.created] ?? 0),
    txSig: cleanSig(row.tx_sig),
    claimToken: cleanSig(row.claim_token),
    pendingTxSig: cleanSig(row.pending_tx_sig),
    pendingLvbh: row.pending_lvbh != null ? Number(row.pending_lvbh) : null,
    pendingAtUnix: row.pending_at_unix != null ? Number(row.pending_at_unix) : null,
    amount,
    toPubkey: row.to_pubkey != null ? String(row.to_pubkey) : null,
  };
}

export function newClaimToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

export async function readClaimSlot(slot: ClaimSlot): Promise<ClaimSlotState | null> {
  if (!hasDatabase()) return mem.slots.get(slotKey(slot)) ?? null;
  await ensurePayoutClaimSchema();
  const w = keyWhere(slot, 1);
  const res = await getPool().query(`select * from ${slot.table} where ${w.sql}`, w.params);
  const row = res.rows[0];
  return row ? rowToState(slot.table, row) : null;
}

/**
 * Inserts the claim row (with a fresh claim token) for the three server-paid claim kinds and generic intents.
 * Returns the current state when somebody already holds it.
 */
export async function acquireClaimSlot(
  slot: ClaimSlot,
  input: { createdAtUnix: number; amount: number | string; toPubkey?: string; kind?: string }
): Promise<{ acquired: true; token: string } | { acquired: false; state: ClaimSlotState }> {
  const token = newClaimToken();
  const createdAtUnix = Math.floor(input.createdAtUnix);
  const amount = String(input.amount);

  if (!hasDatabase()) {
    const k = slotKey(slot);
    const existing = mem.slots.get(k);
    if (existing) return { acquired: false, state: existing };
    // Keep escrowStore's in-memory views (reserved / paid amounts) in sync in mock mode.
    if (slot.table === "reward_milestone_payout_claims") {
      const r = await tryAcquireRewardMilestonePayoutClaim({ commitmentId: slot.k1, milestoneId: String(slot.k2), createdAtUnix, toPubkey: String(input.toPubkey), amountLamports: Number(amount) });
      if (!r.acquired) return { acquired: false, state: { createdAtUnix: r.existing.createdAtUnix, txSig: r.existing.txSig ?? null, claimToken: null, pendingTxSig: null, pendingLvbh: null, pendingAtUnix: null, amount: String(r.existing.amountLamports), toPubkey: r.existing.toPubkey } };
    } else if (slot.table === "failure_distribution_claims") {
      const r = await tryAcquireFailureDistributionClaim({ distributionId: slot.k1, walletPubkey: String(slot.k2), claimedAtUnix: createdAtUnix, amountLamports: Number(amount) });
      if (!r.acquired) return { acquired: false, state: { createdAtUnix: r.existing.claimedAtUnix, txSig: r.existing.txSig ?? null, claimToken: null, pendingTxSig: null, pendingLvbh: null, pendingAtUnix: null, amount: String(r.existing.amountLamports), toPubkey: null } };
    } else if (slot.table === "milestone_failure_distribution_claims") {
      const r = await tryAcquireMilestoneFailureDistributionClaim({ distributionId: slot.k1, walletPubkey: String(slot.k2), claimedAtUnix: createdAtUnix, amountLamports: Number(amount) });
      if (!r.acquired) return { acquired: false, state: { createdAtUnix: r.existing.claimedAtUnix, txSig: r.existing.txSig ?? null, claimToken: null, pendingTxSig: null, pendingLvbh: null, pendingAtUnix: null, amount: String(r.existing.amountLamports), toPubkey: null } };
    }
    mem.slots.set(k, { createdAtUnix, txSig: null, claimToken: token, pendingTxSig: null, pendingLvbh: null, pendingAtUnix: null, amount, toPubkey: input.toPubkey ?? null });
    return { acquired: true, token };
  }

  await ensurePayoutClaimSchema();
  const pool = getPool();
  let res;
  switch (slot.table) {
    case "reward_milestone_payout_claims":
      res = await pool.query(
        `insert into reward_milestone_payout_claims (commitment_id, milestone_id, created_at_unix, to_pubkey, amount_lamports, tx_sig, claim_token)
         values ($1,$2,$3,$4,$5,null,$6) on conflict (commitment_id, milestone_id) do nothing returning commitment_id`,
        [slot.k1, String(slot.k2), String(createdAtUnix), String(input.toPubkey), amount, token]
      );
      break;
    case "failure_distribution_claims":
    case "milestone_failure_distribution_claims":
      res = await pool.query(
        `insert into ${slot.table} (distribution_id, wallet_pubkey, claimed_at_unix, amount_lamports, tx_sig, claim_token)
         values ($1,$2,$3,$4,'',$5) on conflict (distribution_id, wallet_pubkey) do nothing returning distribution_id`,
        [slot.k1, String(slot.k2), String(createdAtUnix), amount, token]
      );
      break;
    case "payout_intents":
      res = await pool.query(
        `insert into payout_intents (intent_key, kind, created_at_unix, to_pubkey, amount_lamports, claim_token)
         values ($1,$2,$3,$4,$5,$6) on conflict (intent_key) do nothing returning intent_key`,
        [slot.k1, String(input.kind ?? "payout"), String(createdAtUnix), String(input.toPubkey ?? ""), amount === "all" ? null : amount, token]
      );
      break;
    default:
      throw new Error(`acquireClaimSlot does not support ${slot.table}`);
  }
  if (res.rows[0]) return { acquired: true, token };
  const state = await readClaimSlot(slot);
  if (!state) return acquireClaimSlot(slot, input); // deleted in between: try once more
  return { acquired: false, state };
}

/** CAS: record the signature about to be broadcast. False = we no longer hold the claim (do NOT broadcast). */
export async function setClaimSlotPending(
  slot: ClaimSlot,
  input: { token: string; signature: string; lastValidBlockHeight: number; previousSignature: string | null; nowUnix?: number }
): Promise<boolean> {
  const nowUnix = Math.floor(input.nowUnix ?? Date.now() / 1000);
  if (!hasDatabase()) {
    const k = slotKey(slot);
    const s = mem.slots.get(k);
    if (!s || s.txSig || s.claimToken !== input.token || (s.pendingTxSig ?? null) !== (input.previousSignature ?? null)) return false;
    mem.slots.set(k, { ...s, pendingTxSig: input.signature, pendingLvbh: input.lastValidBlockHeight, pendingAtUnix: nowUnix });
    return true;
  }
  await ensurePayoutClaimSchema();
  const w = keyWhere(slot, 5);
  const res = await getPool().query(
    `update ${slot.table} set pending_tx_sig=$1, pending_lvbh=$2, pending_at_unix=$3
     where ${w.sql} and claim_token=$4 and ${emptyTxSig()} and pending_tx_sig is not distinct from $${5 + w.params.length}
     returning 1`,
    [input.signature, String(input.lastValidBlockHeight), String(nowUnix), input.token, ...w.params, input.previousSignature]
  );
  return Boolean(res.rows[0]);
}

/** Marks the payout as confirmed (tx_sig). Idempotent; never overwrites an existing tx_sig. */
export async function markClaimSlotPaid(slot: ClaimSlot, input: { signature: string; amountPaid?: number }): Promise<void> {
  const sig = String(input.signature).trim();
  if (!hasDatabase()) {
    const k = slotKey(slot);
    const s = mem.slots.get(k);
    if (s && !s.txSig) mem.slots.set(k, { ...s, txSig: sig });
    if (slot.table === "reward_milestone_payout_claims") await setRewardMilestonePayoutClaimTxSig({ commitmentId: slot.k1, milestoneId: String(slot.k2), txSig: sig });
    if (slot.table === "failure_distribution_claims") await setFailureDistributionClaimTxSig({ distributionId: slot.k1, walletPubkey: String(slot.k2), txSig: sig });
    if (slot.table === "milestone_failure_distribution_claims") await setMilestoneFailureDistributionClaimTxSig({ distributionId: slot.k1, walletPubkey: String(slot.k2), txSig: sig });
    return;
  }
  await ensurePayoutClaimSchema();
  const w = keyWhere(slot, 2);
  const extra = slot.table === "payout_intents" && input.amountPaid != null ? `, amount_paid_lamports=${Math.floor(Number(input.amountPaid))}` : "";
  await withRetry(() => getPool().query(`update ${slot.table} set tx_sig=$1${extra} where ${w.sql} and ${emptyTxSig()}`, [sig, ...w.params]));
}

/**
 * CAS delete of an unpaid claim held by `token` (only call when the chain proved nothing was paid).
 * Without a token (admin reset of a legacy row) the expected pending signature must match instead.
 */
export async function releaseClaimSlot(slot: ClaimSlot, input: { token: string | null; expectedPendingSig?: string | null }): Promise<boolean> {
  if (!hasDatabase()) {
    const k = slotKey(slot);
    const s = mem.slots.get(k);
    if (!s || s.txSig) return false;
    if (input.token != null && s.claimToken !== input.token) return false;
    if (input.token == null && (s.pendingTxSig ?? null) !== (input.expectedPendingSig ?? null)) return false;
    mem.slots.delete(k);
    if (slot.table === "reward_milestone_payout_claims") await deleteRewardMilestonePayoutClaim({ commitmentId: slot.k1, milestoneId: String(slot.k2) });
    if (slot.table === "failure_distribution_claims") await releaseFailureDistributionClaim({ distributionId: slot.k1, walletPubkey: String(slot.k2) });
    if (slot.table === "milestone_failure_distribution_claims") await releaseMilestoneFailureDistributionClaim({ distributionId: slot.k1, walletPubkey: String(slot.k2) });
    return true;
  }
  await ensurePayoutClaimSchema();
  const w = keyWhere(slot, 2);
  const cond = input.token != null ? "claim_token=$1" : `pending_tx_sig is not distinct from $1`;
  const res = await getPool().query(
    `delete from ${slot.table} where ${w.sql} and ${emptyTxSig()} and ${cond} returning 1`,
    [input.token != null ? input.token : (input.expectedPendingSig ?? null), ...w.params]
  );
  return Boolean(res.rows[0]);
}

/** CAS takeover of a provably dead claim: new token, pending cleared, age reset. */
export async function takeoverClaimSlot(
  slot: ClaimSlot,
  input: { expectedToken: string | null; expectedPendingSig: string | null; nowUnix: number; amount?: number | string; toPubkey?: string }
): Promise<{ ok: true; token: string } | { ok: false }> {
  const token = newClaimToken();
  const amount = input.amount != null && input.amount !== "all" ? String(Math.floor(Number(input.amount))) : null;
  if (!hasDatabase()) {
    const k = slotKey(slot);
    const s = mem.slots.get(k);
    if (!s || s.txSig || s.claimToken !== input.expectedToken || (s.pendingTxSig ?? null) !== input.expectedPendingSig) return { ok: false };
    mem.slots.set(k, {
      ...s,
      claimToken: token,
      pendingTxSig: null,
      pendingLvbh: null,
      pendingAtUnix: null,
      createdAtUnix: Math.floor(input.nowUnix),
      amount: amount ?? s.amount,
      toPubkey: input.toPubkey ?? s.toPubkey,
    });
    return { ok: true, token };
  }
  await ensurePayoutClaimSchema();
  const spec = SPECS[slot.table];
  // A dead claim moved nothing, so its amount / destination may be refreshed (e.g. the unlock amount was recomputed).
  const sets: string[] = [];
  const extraParams: string[] = [];
  let p = 5;
  if (amount != null && slot.table !== "vote_reward_distribution_claims") {
    sets.push(`amount_lamports=$${p++}`);
    extraParams.push(amount);
  }
  if (input.toPubkey && (slot.table === "reward_milestone_payout_claims" || slot.table === "payout_intents")) {
    sets.push(`to_pubkey=$${p++}`);
    extraParams.push(input.toPubkey);
  }
  const w = keyWhere(slot, p);
  const res = await getPool().query(
    `update ${slot.table} set claim_token=$1, pending_tx_sig=null, pending_lvbh=null, pending_at_unix=null, ${spec.created}=$2${sets.length ? ", " + sets.join(", ") : ""}
     where ${w.sql} and ${emptyTxSig()} and claim_token is not distinct from $3 and pending_tx_sig is not distinct from $4
     returning 1`,
    [token, String(Math.floor(input.nowUnix)), input.expectedToken, input.expectedPendingSig, ...extraParams, ...w.params]
  );
  return res.rows[0] ? { ok: true, token } : { ok: false };
}

export type SlotResolution =
  | { kind: "paid"; signature: string; recovered: boolean }
  | { kind: "in_flight"; signature: string | null }
  | { kind: "dead"; reason: "failed" | "expired" | "unsent" }
  | { kind: "legacy" };

/** Grace for a claim that holds a token but never recorded a signature (the holder may still be signing). */
const UNSENT_GRACE_SECONDS = 120;

/** Decides, from the chain, what an existing claim row means. Never decides by age when a signature was recorded. */
export async function resolveClaimSlot(connection: Connection, state: ClaimSlotState, nowUnix: number): Promise<SlotResolution> {
  if (state.txSig) return { kind: "paid", signature: state.txSig, recovered: false };
  if (state.pendingTxSig) {
    const o = await getSignatureOutcome(connection, state.pendingTxSig, state.pendingLvbh);
    if (o.outcome === "confirmed") return { kind: "paid", signature: state.pendingTxSig, recovered: true };
    if (o.outcome === "failed") return { kind: "dead", reason: "failed" };
    if (o.outcome === "expired") return { kind: "dead", reason: "expired" };
    return { kind: "in_flight", signature: state.pendingTxSig };
  }
  if (!state.claimToken) return { kind: "legacy" };
  // A token without a signature: the holder never reached onPrepared. Once it is old enough a takeover is safe because
  // the holder's own setClaimSlotPending is a CAS on its token and will fail (it then never broadcasts).
  const age = nowUnix - Number(state.createdAtUnix || 0);
  return age > UNSENT_GRACE_SECONDS ? { kind: "dead", reason: "unsent" } : { kind: "in_flight", signature: null };
}

/** onPrepared hook bound to a claim slot. */
export function pendingRecorder(slot: ClaimSlot, token: string) {
  return async (info: { signature: string; lastValidBlockHeight: number; previousSignature: string | null }) =>
    setClaimSlotPending(slot, { token, signature: info.signature, lastValidBlockHeight: info.lastValidBlockHeight, previousSignature: info.previousSignature });
}

/** Errors thrown before anything was broadcast, or proven to have moved nothing. */
export function isNoEffectError(e: unknown): boolean {
  if (!isTxSendError(e)) return true;
  return e.noEffect === true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Escrow sweep accounting ledger (exactly-once accounting of swept fees)
// ---------------------------------------------------------------------------------------------------------------------

/** Returns true only the first time a sweep signature is accounted. */
export async function recordSweepAccounting(input: { signature: string; commitmentId: string; source: string; lamports: number }): Promise<boolean> {
  const sig = String(input.signature).trim();
  if (!sig) return false;
  if (!hasDatabase()) {
    if (mem.ledger.has(sig)) return false;
    mem.ledger.add(sig);
    return true;
  }
  await ensurePayoutClaimSchema();
  const res = await getPool().query(
    `insert into escrow_sweep_ledger (signature, commitment_id, source, lamports, created_at_unix) values ($1,$2,$3,$4,$5)
     on conflict (signature) do nothing returning signature`,
    [sig, input.commitmentId, input.source, String(Math.max(0, Math.floor(input.lamports))), String(Math.floor(Date.now() / 1000))]
  );
  return Boolean(res.rows[0]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared response helpers for payout routes
// ---------------------------------------------------------------------------------------------------------------------

export type RouteResult = { status: number; body: Record<string, unknown> };

function txErrorResult(e: unknown, extra: Record<string, unknown>): RouteResult {
  if (isTxSendError(e)) {
    if (e.code === "TX_UNCERTAIN") {
      return {
        status: 202,
        body: {
          ok: false,
          pending: true,
          signature: e.signature,
          error: "Payout transaction sent but not confirmed yet",
          hint: "It may still land. Retry this request in a minute - it will report the result of the same transaction and never pays twice.",
          ...extra,
        },
      };
    }
    return {
      status: 502,
      body: { error: getSafeErrorMessage(e), code: e.code, signature: e.signature, hint: "No funds moved. You can retry.", ...extra },
    };
  }
  const status = Number((e as any)?.status);
  if (Number.isFinite(status) && status >= 400 && status < 600) {
    // Errors thrown on purpose with a status (validation, rent floor, fee payer) keep their message.
    return { status, body: { error: redactSensitive(String((e as any)?.message ?? "Request failed")), ...((e as any)?.body ?? {}), ...extra } };
  }
  return { status: 500, body: { error: getSafeErrorMessage(e), ...extra } };
}

export function toResponse(r: RouteResult): NextResponse {
  return NextResponse.json(r.body, { status: r.status });
}

// ---------------------------------------------------------------------------------------------------------------------
// Milestone payout (creator claim + admin release share this)
// ---------------------------------------------------------------------------------------------------------------------

function computeUnlockedLamports(milestones: RewardMilestone[]): number {
  return milestones.reduce((acc, m) => (m.status === "claimable" || m.status === "released" ? acc + Number(m.unlockLamports || 0) : acc), 0);
}

/** Marks a milestone released with `signature` (CAS on the stored milestones so concurrent edits are not lost). */
async function finalizeMilestoneReleased(input: {
  commitmentId: string;
  milestoneId: string;
  signature: string;
  nowUnix: number;
  voteCounts: Awaited<ReturnType<typeof getRewardMilestoneVoteCounts>>;
  connection: Connection;
  escrowPk: PublicKey;
}): Promise<CommitmentRecord> {
  let last: CommitmentRecord | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const latest = await getCommitment(input.commitmentId);
    if (!latest) throw new Error("Commitment not found");
    last = latest;
    const stored: RewardMilestone[] = Array.isArray(latest.milestones) ? (latest.milestones.slice() as RewardMilestone[]) : [];
    const idx = stored.findIndex((m) => m.id === input.milestoneId);
    if (idx < 0) throw new Error("Milestone not found");
    if (stored[idx].status === "released" && stored[idx].releasedTxSig) return latest;

    const normalized = normalizeRewardMilestonesClaimable({
      milestones: stored,
      nowUnix: input.nowUnix,
      approvalCounts: input.voteCounts.approvalCounts,
      rejectCounts: input.voteCounts.rejectCounts,
      approvalThreshold: getRewardApprovalThreshold(),
    }).milestones.slice();
    normalized[idx] = { ...normalized[idx], status: "released", releasedAtUnix: normalized[idx].releasedAtUnix ?? input.nowUnix, releasedTxSig: input.signature };

    let balanceAfter = 0;
    try {
      balanceAfter = await getBalanceLamports(input.connection, input.escrowPk);
    } catch {
      balanceAfter = Math.max(0, Number(latest.totalFundedLamports ?? 0) - sumReleasedLamports(normalized));
    }
    const allReleased = normalized.length > 0 && normalized.every((x) => x.status === "released");
    const updated = await updateRewardTotalsAndMilestones({
      id: input.commitmentId,
      milestones: normalized,
      expectedMilestones: stored,
      unlockedLamports: computeUnlockedLamports(normalized),
      totalFundedLamports: Math.max(0, balanceAfter + sumReleasedLamports(normalized)),
      status: allReleased ? "completed" : "active",
    });
    const check = (updated.milestones ?? []).find((m: RewardMilestone) => m.id === input.milestoneId);
    if (check?.status === "released" && check.releasedTxSig === input.signature) return updated;
  }
  if (last) return last;
  throw new Error("Could not record milestone release");
}

export async function runMilestonePayout(input: {
  commitmentId: string;
  milestoneId: string;
  auditPrefix: string;
  /** Only the admin reconcile path may scan history for legacy rows without a recorded signature. */
}): Promise<RouteResult> {
  const id = input.commitmentId;
  const milestoneId = input.milestoneId;
  const audit = (suffix: string, fields: Record<string, unknown>) => auditLog(`${input.auditPrefix}_${suffix}`, { commitmentId: id, milestoneId, ...fields });

  const record = await getCommitment(id);
  if (!record) return { status: 404, body: { error: "Not found" } };
  if (record.kind !== "creator_reward") return { status: 400, body: { error: "Not a reward commitment" } };
  if (record.status === "failed") return { status: 409, body: { error: "Commitment is failed" } };
  if (!record.creatorPubkey) return { status: 409, body: { error: "Missing creator pubkey" } };

  const connection = getConnection();
  const escrowPk = new PublicKey(record.escrowPubkey);
  const to = new PublicKey(record.creatorPubkey);
  const chainNow = await getChainUnixTime(connection);
  const nowUnix = Math.max(chainNow, Math.floor(Date.now() / 1000));

  const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
  const idx = milestones.findIndex((m) => m.id === milestoneId);
  if (idx < 0) return { status: 404, body: { error: "Milestone not found" } };

  const voteCounts = await getRewardMilestoneVoteCounts(id);
  const effective = normalizeRewardMilestonesClaimable({
    milestones,
    nowUnix: chainNow,
    approvalCounts: voteCounts.approvalCounts,
    rejectCounts: voteCounts.rejectCounts,
    approvalThreshold: getRewardApprovalThreshold(),
  }).milestones;
  const m = effective[idx];

  const slot: ClaimSlot = { table: "reward_milestone_payout_claims", k1: id, k2: milestoneId };
  const finalize = async (signature: string) =>
    finalizeMilestoneReleased({ commitmentId: id, milestoneId, signature, nowUnix: chainNow, voteCounts, connection, escrowPk });

  // 1) An existing claim row is resolved from the chain first (this also completes a payout whose response was lost).
  let token: string | null = null;
  const existing = await readClaimSlot(slot);
  if (existing) {
    const res = await resolveClaimSlot(connection, existing, nowUnix);
    if (res.kind === "paid") {
      if (!existing.txSig) await markClaimSlotPaid(slot, { signature: res.signature });
      const updated = await finalize(res.signature);
      await audit("ok", { signature: res.signature, recovered: res.recovered, idempotent: true });
      return { status: 200, body: { ok: true, nowUnix: chainNow, signature: res.signature, commitment: publicView(updated), idempotent: true, recovered: res.recovered } };
    }
    if (res.kind === "in_flight") {
      return { status: 409, body: { error: "Payout already in progress", pending: true, signature: res.signature, hint: "Retry in a minute; the pending transaction is checked on-chain before anything new is sent." } };
    }
    if (res.kind === "legacy") {
      return {
        status: 409,
        body: {
          error: "A payout claim without a recorded transaction exists",
          hint: "An admin must reconcile it (POST …/reconcile) - it is never retried automatically because the original transfer may have landed.",
          existing,
        },
      };
    }
    // dead: provably nothing paid - take it over below (after the funding checks), refreshing amount/destination.
  }

  if (m.status === "released") return { status: 409, body: { error: "Already released", commitment: publicView(record) } };
  if (m.status !== "claimable") return { status: 400, body: { error: "Milestone not claimable", nowUnix: chainNow, milestone: m, commitment: publicView(record) } };

  const unlockLamports = Number(m.unlockLamports);
  if (!Number.isFinite(unlockLamports) || unlockLamports <= 0) return { status: 409, body: { error: "Invalid milestone unlock amount" } };

  // 2) Funding: never touch lamports reserved for failure distributions, never strand the escrow below rent.
  const escrowRef = getEscrowSignerRef(record);
  const signer = payoutSignerFromEscrowRef({ escrowPubkey: escrowPk, ref: escrowRef });
  const [reservedLamports, rentMin] = await Promise.all([getMilestoneFailureReservedLamports(id), getRentExemptMinLamports(connection, 0)]);
  let balanceLamports = await getBalanceLamports(connection, escrowPk);

  if (balanceLamports - reservedLamports < unlockLamports) {
    try {
      await closeNativeWsolTokenAccounts({
        connection,
        owner: escrowPk,
        destination: escrowPk,
        signer: escrowRef.kind === "privy" ? { kind: "privy", walletId: escrowRef.walletId } : { kind: "keypair", keypair: keypairFromBase58Secret(escrowRef.escrowSecretKeyB58) },
      });
      balanceLamports = await getBalanceLamports(connection, escrowPk);
    } catch {
      // best effort
    }
  }

  const availableLamports = Math.max(0, balanceLamports - reservedLamports);
  if (availableLamports < unlockLamports) {
    return { status: 400, body: { error: "Escrow underfunded for this release", balanceLamports, reservedLamports, availableLamports, requiredLamports: unlockLamports, commitment: publicView(record) } };
  }
  const remaining = balanceLamports - unlockLamports;
  let payAll = false;
  if (remaining > 0 && remaining < rentMin) {
    if (reservedLamports > 0) {
      return { status: 409, body: { error: "Payout would leave reserved funds below the rent-exempt minimum", balanceLamports, reservedLamports, rentExemptMinLamports: rentMin } };
    }
    payAll = true; // the dust can't stay behind on-chain: it goes to the creator with this last payout
  }

  // 3) Acquire (or take over a provably dead) claim.
  if (existing) {
    const t = await takeoverClaimSlot(slot, { expectedToken: existing.claimToken, expectedPendingSig: existing.pendingTxSig, nowUnix, amount: unlockLamports, toPubkey: to.toBase58() });
    if (!t.ok) return { status: 409, body: { error: "Payout already in progress", hint: "Another request took over this payout; retry shortly." } };
    token = t.token;
  } else {
    const a = await acquireClaimSlot(slot, { createdAtUnix: nowUnix, amount: unlockLamports, toPubkey: to.toBase58() });
    if (!a.acquired) return { status: 409, body: { error: "Payout already in progress", pending: true, signature: a.state.pendingTxSig } };
    token = a.token;
  }

  // 4) Send (signature recorded on the claim before broadcast).
  try {
    const { signature, amountLamports } = await transferLamportsFromSigner({
      connection,
      signer,
      to,
      lamports: payAll ? "all" : unlockLamports,
      onPrepared: pendingRecorder(slot, token),
    });
    await markClaimSlotPaid(slot, { signature });
    const updated = await finalize(signature);
    await audit("ok", { signature, amountLamports });
    return { status: 200, body: { ok: true, nowUnix: chainNow, signature, amountLamports, commitment: publicView(updated) } };
  } catch (e) {
    if (isNoEffectError(e)) {
      await releaseClaimSlot(slot, { token }).catch(() => false);
    }
    await audit("error", { error: getSafeErrorMessage(e), code: (e as any)?.code ?? null, signature: (e as any)?.signature ?? null, clearedClaim: isNoEffectError(e) });
    return txErrorResult(e, {});
  }
}

/**
 * Admin reconcile of a milestone payout claim: resolves recorded signatures from the chain; for legacy rows (no
 * recorded signature) it scans history for an unambiguous matching transfer; forceReset only clears a claim whose
 * recorded transaction is provably dead (or a legacy row with no on-chain match).
 */
export async function reconcileMilestonePayout(input: { commitmentId: string; milestoneId: string; forceReset: boolean }): Promise<RouteResult> {
  const id = input.commitmentId;
  const milestoneId = input.milestoneId;
  const record = await getCommitment(id);
  if (!record) return { status: 404, body: { error: "Not found" } };
  if (record.kind !== "creator_reward") return { status: 400, body: { error: "Not a reward commitment" } };
  const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones as RewardMilestone[]) : [];
  if (!milestones.some((m) => m.id === milestoneId)) return { status: 404, body: { error: "Milestone not found" } };

  const connection = getConnection();
  const escrowPk = new PublicKey(record.escrowPubkey);
  const nowUnix = await getChainUnixTime(connection);
  const slot: ClaimSlot = { table: "reward_milestone_payout_claims", k1: id, k2: milestoneId };
  const claim = await readClaimSlot(slot);
  if (!claim) return { status: 404, body: { error: "No payout claim record exists for this milestone" } };

  const voteCounts = await getRewardMilestoneVoteCounts(id);
  const finalize = (signature: string) => finalizeMilestoneReleased({ commitmentId: id, milestoneId, signature, nowUnix, voteCounts, connection, escrowPk });

  const res = await resolveClaimSlot(connection, claim, Math.max(nowUnix, Math.floor(Date.now() / 1000)));
  if (res.kind === "paid") {
    if (!claim.txSig) await markClaimSlotPaid(slot, { signature: res.signature });
    const updated = await finalize(res.signature);
    await auditLog("admin_reward_milestone_reconcile_ok", { commitmentId: id, milestoneId, mode: claim.txSig ? "already_has_txSig" : "pending_sig_confirmed", txSig: res.signature });
    return { status: 200, body: { ok: true, mode: claim.txSig ? "already_has_txSig" : "pending_sig_confirmed", txSig: res.signature, commitment: publicView(updated) } };
  }
  if (res.kind === "in_flight") {
    return { status: 409, body: { error: "The recorded payout transaction is still pending", signature: res.signature, hint: "Wait until it confirms or its blockhash expires, then reconcile again." } };
  }
  if (res.kind === "dead") {
    if (!input.forceReset) {
      return { status: 409, body: { error: `The recorded payout transaction did not land (${res.reason})`, hint: "Re-run with { forceReset: true } to clear the claim, or simply retry the payout (it takes over dead claims automatically).", claim } };
    }
    const ok = await releaseClaimSlot(slot, { token: claim.claimToken, expectedPendingSig: claim.pendingTxSig });
    await auditLog("admin_reward_milestone_reconcile_reset", { commitmentId: id, milestoneId, reason: res.reason, ok });
    return ok ? { status: 200, body: { ok: true, mode: "reset", commitment: publicView(record) } } : { status: 409, body: { error: "Claim changed while resetting; reconcile again" } };
  }

  // legacy: no signature was ever recorded. Look for exactly one matching transfer that isn't another milestone's.
  const otherSigs = milestones.map((m) => String(m.releasedTxSig ?? "").trim()).filter(Boolean);
  const lamports = Number(claim.amount);
  const toPk = new PublicKey(String(claim.toPubkey ?? record.creatorPubkey));
  const foundSig = await findSystemTransferSignature({
    connection,
    fromPubkey: escrowPk,
    toPubkey: toPk,
    lamports,
    minBlockTimeUnix: Math.max(0, Number(claim.createdAtUnix ?? 0) - 300),
    maxTransactionsToInspect: 300,
    excludeSignatures: otherSigs,
    onAmbiguous: "null",
  });
  if (foundSig) {
    await markClaimSlotPaid(slot, { signature: foundSig });
    const updated = await finalize(foundSig);
    await auditLog("admin_reward_milestone_reconcile_ok", { commitmentId: id, milestoneId, mode: "found_on_chain", txSig: foundSig });
    return { status: 200, body: { ok: true, mode: "found_on_chain", txSig: foundSig, commitment: publicView(updated) } };
  }
  if (!input.forceReset) {
    await auditLog("admin_reward_milestone_reconcile_no_match", { commitmentId: id, milestoneId, amountLamports: lamports, toPubkey: claim.toPubkey });
    return {
      status: 409,
      body: {
        error: "No unambiguous matching transfer found on-chain for this payout claim",
        hint: "If you are sure the transfer never happened and want to unblock retries, re-run with { forceReset: true } to clear the in-progress claim record.",
        claim,
      },
    };
  }
  const ok = await releaseClaimSlot(slot, { token: null, expectedPendingSig: null });
  await auditLog("admin_reward_milestone_reconcile_reset", { commitmentId: id, milestoneId, legacy: true, ok });
  return ok ? { status: 200, body: { ok: true, mode: "reset", commitment: publicView(record) } } : { status: 409, body: { error: "Claim changed while resetting; reconcile again" } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Failure-distribution voter claims (commitment-level and milestone-level)
// ---------------------------------------------------------------------------------------------------------------------

export async function runFailureDistributionClaim(input: {
  table: "failure_distribution_claims" | "milestone_failure_distribution_claims";
  distributionId: string;
  walletPubkey: string;
  amountLamports: number;
  commitment: CommitmentRecord;
  nowUnix: number;
  /** Lamports reserved in the escrow for other unpaid claims of this commitment (excluding this one). */
  reservedOthersLamports: number;
}): Promise<RouteResult> {
  const { distributionId, walletPubkey, amountLamports, commitment } = input;
  const slot: ClaimSlot = { table: input.table, k1: distributionId, k2: walletPubkey };
  const connection = getConnection();
  const fromPubkey = new PublicKey(commitment.escrowPubkey);
  const to = new PublicKey(walletPubkey);
  const nowUnix = Math.max(input.nowUnix, Math.floor(Date.now() / 1000));

  const existing = await readClaimSlot(slot);
  let token: string | null = null;
  if (existing) {
    if (Number(existing.amount) !== amountLamports) {
      return { status: 409, body: { error: "Existing claim has mismatched amount", existing, expectedAmountLamports: amountLamports } };
    }
    const res = await resolveClaimSlot(connection, existing, nowUnix);
    if (res.kind === "paid") {
      if (!existing.txSig) await markClaimSlotPaid(slot, { signature: res.signature });
      return { status: 200, body: { ok: true, idempotent: true, recovered: res.recovered, nowUnix: input.nowUnix, signature: res.signature, amountLamports, distributionId } };
    }
    if (res.kind === "in_flight") return { status: 409, body: { error: "Claim already in progress", pending: true, signature: res.signature } };
    if (res.kind === "legacy") return { status: 409, body: { error: "Already claimed", hint: "A claim without a recorded transaction exists; contact support to reconcile it." } };
  }

  const [balance, rentMin] = await Promise.all([getBalanceLamports(connection, fromPubkey), getRentExemptMinLamports(connection, 0)]);
  const reservedOthers = Math.max(0, Math.floor(input.reservedOthersLamports));
  if (balance - reservedOthers < amountLamports) {
    return { status: 409, body: { error: "Escrow underfunded for this claim", balanceLamports: balance, requiredLamports: amountLamports } };
  }
  const remaining = balance - amountLamports;
  let payAll = false;
  if (remaining > 0 && remaining < rentMin) {
    if (reservedOthers > 0) return { status: 409, body: { error: "Escrow can't pay this claim without dropping below the rent-exempt minimum" } };
    payAll = true;
  }

  if (existing) {
    const t = await takeoverClaimSlot(slot, { expectedToken: existing.claimToken, expectedPendingSig: existing.pendingTxSig, nowUnix });
    if (!t.ok) return { status: 409, body: { error: "Claim already in progress" } };
    token = t.token;
  } else {
    const a = await acquireClaimSlot(slot, { createdAtUnix: nowUnix, amount: amountLamports });
    if (!a.acquired) return { status: 409, body: { error: "Claim already in progress", pending: true, signature: a.state.pendingTxSig } };
    token = a.token;
  }

  const signer = payoutSignerFromEscrowRef({ escrowPubkey: fromPubkey, ref: getEscrowSignerRef(commitment) });
  try {
    const { signature, amountLamports: paid } = await transferLamportsFromSigner({
      connection,
      signer,
      to,
      lamports: payAll ? "all" : amountLamports,
      onPrepared: pendingRecorder(slot, token),
    });
    await markClaimSlotPaid(slot, { signature });
    return { status: 200, body: { ok: true, nowUnix: input.nowUnix, signature, amountLamports, paidLamports: paid, distributionId } };
  } catch (e) {
    if (isNoEffectError(e)) await releaseClaimSlot(slot, { token }).catch(() => false);
    return txErrorResult(e, { distributionId });
  }
}

/** Signed-message check shared by the failure-claim routes (400 on malformed signatures instead of a 500). */
export function verifyWalletMessageSignature(input: { message: string; signatureB58: string; walletPubkey: PublicKey }): boolean {
  let sig: Uint8Array;
  try {
    sig = bs58.decode(input.signatureB58);
  } catch {
    throw Object.assign(new Error("Invalid signature encoding"), { status: 400 });
  }
  if (sig.length !== 64) throw Object.assign(new Error("Invalid signature length"), { status: 400 });
  return nacl.sign.detached.verify(new TextEncoder().encode(input.message), sig, input.walletPubkey.toBytes());
}

// ---------------------------------------------------------------------------------------------------------------------
// Generic payout intents (personal commitment success / failure / deadline sweep)
// ---------------------------------------------------------------------------------------------------------------------

export function intentSlot(intentKey: string): ClaimSlot {
  return { table: "payout_intents", k1: intentKey, k2: null };
}

export type IntentRunResult =
  | { kind: "paid"; signature: string; amountLamports: number | null; idempotent: boolean }
  | { kind: "in_flight"; signature: string | null }
  | { kind: "no_effect_error"; error: unknown }
  | { kind: "uncertain"; error: unknown };

/**
 * Pays `to` everything in the escrow exactly once for `intentKey`. Re-running after a lost response / timeout
 * resolves the recorded signature instead of sending again.
 */
export async function runTransferAllIntent(input: {
  intentKey: string;
  kind: string;
  connection: Connection;
  commitment: CommitmentRecord;
  to: PublicKey;
}): Promise<IntentRunResult> {
  const slot = intentSlot(input.intentKey);
  const nowUnix = Math.floor(Date.now() / 1000);
  const existing = await readClaimSlot(slot);
  let token: string;
  if (existing) {
    if (existing.toPubkey && existing.toPubkey !== input.to.toBase58()) throw Object.assign(new Error("Existing payout intent has a different destination"), { status: 409 });
    const res = await resolveClaimSlot(input.connection, existing, nowUnix);
    if (res.kind === "paid") {
      if (!existing.txSig) await markClaimSlotPaid(slot, { signature: res.signature });
      return { kind: "paid", signature: res.signature, amountLamports: null, idempotent: true };
    }
    if (res.kind === "in_flight") return { kind: "in_flight", signature: res.signature };
    if (res.kind === "legacy") throw Object.assign(new Error("Payout intent in unknown state"), { status: 409 });
    const t = await takeoverClaimSlot(slot, { expectedToken: existing.claimToken, expectedPendingSig: existing.pendingTxSig, nowUnix });
    if (!t.ok) return { kind: "in_flight", signature: existing.pendingTxSig };
    token = t.token;
  } else {
    const a = await acquireClaimSlot(slot, { createdAtUnix: nowUnix, amount: "all", toPubkey: input.to.toBase58(), kind: input.kind });
    if (!a.acquired) return { kind: "in_flight", signature: a.state.pendingTxSig };
    token = a.token;
  }

  const fromPubkey = new PublicKey(input.commitment.escrowPubkey);
  const signer = payoutSignerFromEscrowRef({ escrowPubkey: fromPubkey, ref: getEscrowSignerRef(input.commitment) });
  try {
    const { signature, amountLamports } = await transferLamportsFromSigner({
      connection: input.connection,
      signer,
      to: input.to,
      lamports: "all",
      onPrepared: pendingRecorder(slot, token),
    });
    await markClaimSlotPaid(slot, { signature, amountPaid: amountLamports });
    return { kind: "paid", signature, amountLamports, idempotent: false };
  } catch (e) {
    if (isNoEffectError(e)) {
      await releaseClaimSlot(slot, { token }).catch(() => false);
      return { kind: "no_effect_error", error: e };
    }
    return { kind: "uncertain", error: e };
  }
}

/**
 * Settles a personal commitment exactly once: success pays everything to the authority, failure pays everything to
 * the creator-chosen destinationOnFail (M11). Re-running after a timeout / lost response resolves the recorded
 * transaction from the chain instead of sending again; a commitment left in "resolving" is settled the same way.
 */
export async function settlePersonalCommitment(input: { commitmentId: string; outcome: "success" | "failure" }): Promise<RouteResult> {
  const id = input.commitmentId;
  const outcome = input.outcome;
  const current = await getCommitment(id);
  if (!current) return { status: 404, body: { error: "Not found" } };
  if (current.kind !== "personal") {
    return outcome === "success"
      ? { status: 400, body: { error: "This endpoint is only for personal commitments" } }
      : {
          status: 400,
          body: {
            error: "Creator reward commitments do not use commitment-level failure payouts",
            hint: "Failing payouts are processed per milestone (admin-approved) via /milestones/[milestoneId]/failure-distribution/create.",
          },
        };
  }

  let to: PublicKey;
  try {
    to = new PublicKey(outcome === "success" ? current.authority : current.destinationOnFail);
  } catch {
    return { status: 409, body: { error: outcome === "success" ? "Commitment authority is not a valid address" : "destinationOnFail is not a valid address" } };
  }

  const connection = getConnection();
  const nowUnix = await getChainUnixTime(connection);
  const otherOutcome = outcome === "success" ? "failure" : "success";
  const myKey = `commitment:${id}:${outcome}`;
  const otherKey = `commitment:${id}:${otherOutcome}`;
  const tooEarlyOrLate = outcome === "success" ? nowUnix > current.deadlineUnix : nowUnix <= current.deadlineUnix;
  const release = async () => {
    if (outcome === "success") await releaseResolutionClaim(id);
    else await releaseFailureSettlementClaim({ id, restoreStatus: "created" });
  };

  let claimed: CommitmentRecord;
  if (current.status === "resolving") {
    // A previous attempt was interrupted. Never start a new payout while the other outcome's payout may have landed.
    const other = await readClaimSlot(intentSlot(otherKey));
    if (other) {
      const r = await resolveClaimSlot(connection, other, Math.floor(Date.now() / 1000));
      if (r.kind === "paid" || r.kind === "in_flight" || r.kind === "legacy") {
        return { status: 409, body: { error: `Commitment is being settled as ${otherOutcome}`, signature: (r as any).signature ?? null, hint: `Call the ${otherOutcome} endpoint to finish it.` } };
      }
    }
    if (tooEarlyOrLate) {
      // Outside this outcome's time window we may only finish a payout that was already sent, never start one.
      const mine = await readClaimSlot(intentSlot(myKey));
      const r = mine ? await resolveClaimSlot(connection, mine, Math.floor(Date.now() / 1000)) : null;
      if (!r || (r.kind !== "paid" && r.kind !== "in_flight")) {
        return { status: 409, body: { error: "Commitment is already resolving", commitment: publicView(current), hint: `Call the ${otherOutcome} endpoint to settle it.` } };
      }
    }
    claimed = current;
  } else {
    const c = outcome === "success" ? await claimForResolution(id) : await claimForFailureSettlement(id);
    if (!c) return { status: 409, body: { error: "Already resolving/resolved", commitment: publicView(current) } };
    if (tooEarlyOrLate) {
      await release();
      return { status: 400, body: { error: outcome === "success" ? "Too late (deadline passed)" : "Too early (deadline not yet passed)" } };
    }
    claimed = c;
  }

  const r = await runTransferAllIntent({ intentKey: myKey, kind: outcome, connection, commitment: claimed, to });
  if (r.kind === "paid") {
    const updated =
      outcome === "success"
        ? await finalizeResolution({ id, status: "resolved_success", resolvedAtUnix: nowUnix, resolvedTxSig: r.signature })
        : await finalizeCommitmentStatus({ id, status: "resolved_failure", resolvedAtUnix: nowUnix, resolvedTxSig: r.signature });
    await auditLog(`admin_commitment_${outcome}_ok`, { commitmentId: id, signature: r.signature, amountLamports: r.amountLamports, to: to.toBase58(), idempotent: r.idempotent });
    return { status: 200, body: { ok: true, nowUnix, signature: r.signature, amountLamports: r.amountLamports, destination: to.toBase58(), idempotent: r.idempotent, commitment: publicView(updated) } };
  }
  if (r.kind === "in_flight") {
    return { status: 409, body: { error: "Settlement payout already in progress", pending: true, signature: r.signature } };
  }
  if (r.kind === "no_effect_error") {
    await release();
    await auditLog(`admin_commitment_${outcome}_error`, { commitmentId: id, error: getSafeErrorMessage(r.error), clearedClaim: true });
    return txErrorResult(r.error, {});
  }
  await auditLog(`admin_commitment_${outcome}_error`, { commitmentId: id, error: getSafeErrorMessage(r.error), pending: true });
  return txErrorResult(r.error, {});
}

// ---------------------------------------------------------------------------------------------------------------------
// Vote-reward claims (user pays the fee, faucet co-signs)
// ---------------------------------------------------------------------------------------------------------------------

function isVoteRewardPayoutsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_VOTE_REWARD_PAYOUTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

type FaucetSigner = { kind: "privy"; walletId: string; owner: PublicKey } | { kind: "keypair"; keypair: import("@solana/web3.js").Keypair };

export function getVoteRewardFaucetSigner(input: { faucetOwnerPubkey: PublicKey }): FaucetSigner {
  const privyWalletId = String(process.env.CTS_VOTE_REWARD_FAUCET_PRIVY_WALLET_ID ?? "").trim();
  if (privyWalletId) return { kind: "privy", walletId: privyWalletId, owner: input.faucetOwnerPubkey };
  const secret = String(process.env.CTS_VOTE_REWARD_FAUCET_OWNER_SECRET_KEY ?? "").trim();
  if (!secret) throw new Error("CTS_VOTE_REWARD_FAUCET_OWNER_SECRET_KEY (or CTS_VOTE_REWARD_FAUCET_PRIVY_WALLET_ID) is required");
  const kp = keypairFromBase58Secret(secret);
  if (!kp.publicKey.equals(input.faucetOwnerPubkey)) throw new Error("Faucet owner secret key does not match CTS_VOTE_REWARD_FAUCET_OWNER_PUBKEY");
  return { kind: "keypair", keypair: kp };
}

/** The exact (non compute-budget) instructions of a vote-reward claim: ATA create (user pays) + TransferChecked. */
export function buildVoteRewardClaimInstructions(input: {
  wallet: PublicKey;
  faucetOwner: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  amountRaw: bigint;
  decimals: number;
}): TransactionInstruction[] {
  const sourceAta = getAssociatedTokenAddress({ owner: input.faucetOwner, mint: input.mint, tokenProgram: input.tokenProgram });
  const { ix: createIx, ata: destinationAta } = buildCreateAssociatedTokenAccountIdempotentInstruction({
    payer: input.wallet,
    owner: input.wallet,
    mint: input.mint,
    tokenProgram: input.tokenProgram,
  });
  const transferIx = buildSplTokenTransferInstruction({
    sourceAta,
    destinationAta,
    owner: input.faucetOwner,
    amountRaw: input.amountRaw,
    tokenProgram: input.tokenProgram,
    mint: input.mint,
    decimals: input.decimals,
  });
  return [createIx, transferIx];
}

const VOTE_CLAIM_COMPUTE_UNITS = 100_000;

/** Unsigned claim transaction for the user to sign (fee payer = user), with a priority fee the user pays. */
export async function prepareVoteRewardClaimTransaction(input: {
  connection: Connection;
  wallet: PublicKey;
  instructions: TransactionInstruction[];
}): Promise<{ transactionBase64: string; blockhash: string; lastValidBlockHeight: number; requiredLamports: number; balanceLamports: number }> {
  const { connection, wallet } = input;
  const latest = await withRetry(() => connection.getLatestBlockhash("confirmed"));
  const pf = await buildPriorityFeeInstructions({ connection, payer: wallet, instructions: input.instructions, fallbackUnits: VOTE_CLAIM_COMPUTE_UNITS, simulate: false });
  const tx = new Transaction({ feePayer: wallet, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight });
  tx.add(...pf.instructions, ...input.instructions);

  const c = getServerCommitment();
  const fee = await withRetry(() => connection.getFeeForMessage(tx.compileMessage(), c));
  const feeLamports = Math.max(Number(fee.value ?? 0), 10_000 + pf.priorityFeeLamports);
  const destinationAta = input.instructions[0].keys[1].pubkey;
  const ataInfo = await withRetry(() => connection.getAccountInfo(destinationAta, c));
  const ataRentLamports = ataInfo ? 0 : await getRentExemptMinLamports(connection, 165);
  const requiredLamports = Math.max(0, feeLamports + ataRentLamports);
  const balanceLamports = await withRetry(() => connection.getBalance(wallet, c));

  const txBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return { transactionBase64: Buffer.from(Uint8Array.from(txBytes)).toString("base64"), blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, requiredLamports, balanceLamports };
}

/**
 * Validates a user-signed claim transaction: user signature valid, exact expected instructions (H4), blockhash still
 * valid. Returns the user's signature (= tx id) and an upper bound for its lastValidBlockHeight.
 */
export async function checkSignedVoteRewardTransaction(input: {
  connection: Connection;
  tx: Transaction;
  wallet: PublicKey;
  expectedInstructions: TransactionInstruction[];
}): Promise<{ ok: true; txSig: string; lvbhBound: number } | { ok: false; status: number; error: string }> {
  const { tx, wallet } = input;
  const userSigEntry = tx.signatures.find((s) => s.publicKey.equals(wallet));
  const userSigBytes = userSigEntry?.signature ?? null;
  if (!userSigBytes) return { ok: false, status: 400, error: "Missing user signature" };
  if (!nacl.sign.detached.verify(new Uint8Array(tx.serializeMessage()), new Uint8Array(userSigBytes), wallet.toBytes())) {
    return { ok: false, status: 401, error: "Invalid transaction signature" };
  }
  const v = verifyExactUserTransaction({ tx, feePayer: wallet, expectedInstructions: input.expectedInstructions });
  if (!v.ok) return { ok: false, status: 400, error: v.reason };
  const bound = await getBlockhashExpiryBound(input.connection, String(tx.recentBlockhash));
  if (bound == null) return { ok: false, status: 400, error: "Claim transaction expired - prepare it again" };
  return { ok: true, txSig: bs58.encode(userSigBytes), lvbhBound: bound };
}

/**
 * Resolves this wallet's unpaid vote-reward claim rows from the chain (inside the caller's transaction that holds the
 * wallet advisory lock): confirmed → tx_sig set; failed/expired → rows released; pending → reported.
 */
export async function resolveVoteRewardWalletPending(
  client: PoolClient,
  connection: Connection,
  walletPubkey: string
): Promise<{ inFlight: Array<{ signature: string | null; distributionIds: string[] }>; legacy: string[] }> {
  await ensurePayoutClaimSchema();
  const res = await client.query(
    `select distribution_id, claimed_at_unix, pending_tx_sig, pending_lvbh, claim_token
     from vote_reward_distribution_claims where wallet_pubkey=$1 and (tx_sig is null or tx_sig='')`,
    [walletPubkey]
  );
  const groups = new Map<string, { lvbh: number | null; ids: string[] }>();
  const legacy: string[] = [];
  for (const r of res.rows ?? []) {
    const sig = cleanSig(r.pending_tx_sig);
    const id = String(r.distribution_id);
    if (!sig) {
      legacy.push(id);
      continue;
    }
    const g = groups.get(sig) ?? { lvbh: r.pending_lvbh != null ? Number(r.pending_lvbh) : null, ids: [] };
    g.ids.push(id);
    groups.set(sig, g);
  }
  const inFlight: Array<{ signature: string | null; distributionIds: string[] }> = [];
  for (const [sig, g] of Array.from(groups.entries())) {
    const o = await getSignatureOutcome(connection, sig, g.lvbh);
    if (o.outcome === "confirmed") {
      await client.query(
        `update vote_reward_distribution_claims set tx_sig=$2 where wallet_pubkey=$1 and pending_tx_sig=$2 and (tx_sig is null or tx_sig='')`,
        [walletPubkey, sig]
      );
    } else if (o.outcome === "failed" || o.outcome === "expired") {
      await client.query(
        `delete from vote_reward_distribution_claims where wallet_pubkey=$1 and pending_tx_sig=$2 and (tx_sig is null or tx_sig='')`,
        [walletPubkey, sig]
      );
    } else {
      inFlight.push({ signature: sig, distributionIds: g.ids });
    }
  }
  return { inFlight, legacy };
}

/** Inserts the claim rows for one signed transaction (pending signature recorded atomically with the claim). */
export async function insertVoteRewardPendingClaims(
  client: PoolClient,
  input: { walletPubkey: string; distributionIds: string[]; amountsRaw: string[]; claimedAtUnix: number; txSig: string; lvbhBound: number }
): Promise<string[]> {
  await ensurePayoutClaimSchema();
  const token = newClaimToken();
  const inserted = await client.query(
    `insert into vote_reward_distribution_claims (distribution_id, wallet_pubkey, claimed_at_unix, amount_raw, tx_sig, claim_token, pending_tx_sig, pending_lvbh, pending_at_unix)
     select t.distribution_id, $3, $4, t.amount_raw, '', $5, $6, $7, $4
     from unnest($1::text[], $2::bigint[]) as t(distribution_id, amount_raw)
     on conflict (distribution_id, wallet_pubkey) do nothing
     returning distribution_id`,
    [input.distributionIds, input.amountsRaw, input.walletPubkey, String(input.claimedAtUnix), token, input.txSig, String(input.lvbhBound)]
  );
  return (inserted.rows ?? []).map((r: any) => String(r?.distribution_id ?? "")).filter(Boolean);
}

/**
 * Faucet co-signs the user's transaction (Privy or local key), checks the signature didn't change, broadcasts the
 * same bytes until final and settles the claim rows: paid → tx_sig; no effect → rows released; uncertain → kept.
 */
export async function submitVoteRewardClaim(input: {
  connection: Connection;
  tx: Transaction;
  faucetOwner: PublicKey;
  walletPubkey: string;
  txSig: string;
  lvbhBound: number;
}): Promise<RouteResult> {
  const { connection, walletPubkey, txSig } = input;
  const pool = getPool();
  const settle = async (mode: "paid" | "release") => {
    if (mode === "paid") {
      await withRetry(() =>
        pool.query(`update vote_reward_distribution_claims set tx_sig=$2 where wallet_pubkey=$1 and pending_tx_sig=$2 and (tx_sig is null or tx_sig='')`, [walletPubkey, txSig])
      );
    } else {
      await withRetry(() =>
        pool.query(`delete from vote_reward_distribution_claims where wallet_pubkey=$1 and pending_tx_sig=$2 and (tx_sig is null or tx_sig='')`, [walletPubkey, txSig])
      );
    }
  };

  let raw: Buffer;
  try {
    const signer = getVoteRewardFaucetSigner({ faucetOwnerPubkey: input.faucetOwner });
    if (signer.kind === "privy") {
      raw = await privySignTransactionVerified({ walletId: signer.walletId, tx: input.tx });
    } else {
      input.tx.partialSign(signer.keypair);
      if (!input.tx.verifySignatures(true)) throw new Error("Transaction is missing required signatures");
      raw = input.tx.serialize();
    }
    const sentSig = signatureFromRawTransaction(raw);
    if (sentSig !== txSig) throw new Error("Transaction signature mismatch");
  } catch (e) {
    // Nothing was broadcast: release so the user can prepare a new claim.
    await settle("release").catch(() => null);
    throw e;
  }

  try {
    const final = await broadcastUntilFinal({ connection, raw, signature: txSig, lastValidBlockHeight: input.lvbhBound });
    if (final === "confirmed") {
      await settle("paid");
      return { status: 200, body: { ok: true, signature: txSig } };
    }
    await settle("release");
    return { status: 409, body: { error: "Claim transaction expired before it landed - nothing was transferred. Please claim again.", code: "TX_EXPIRED", signature: txSig } };
  } catch (e) {
    if (isTxSendError(e) && e.noEffect) {
      await settle("release").catch(() => null);
      return { status: 409, body: { error: getSafeErrorMessage(e), code: e.code, signature: txSig, hint: "Nothing was transferred. You can claim again." } };
    }
    if (isTxSendError(e) && e.code === "TX_UNCERTAIN") {
      return {
        status: 202,
        body: { ok: false, pending: true, code: "confirmation_timeout", error: "Transaction confirmation timeout", signature: txSig, hint: "Your transaction may still confirm. Check your wallet activity; claiming again later reports the final result." },
      };
    }
    throw e;
  }
}

/**
 * Shared implementation of /api/vote-reward/claim-all (one commitment) and /claim-all-global (every commitment).
 */
export async function handleVoteRewardClaimAll(req: Request, scope: { global: boolean }): Promise<NextResponse> {
  const label = scope.global ? "claim_all_global" : "claim_all";
  try {
    const rl = await checkRateLimit(req, { keyPrefix: scope.global ? "vote-reward:claim-all-global" : "vote-reward:claim-all", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }
    if (!isVoteRewardPayoutsEnabled()) {
      return NextResponse.json({ error: "Vote reward payouts are disabled", hint: "Set CTS_ENABLE_VOTE_REWARD_PAYOUTS=1 (or true) to enable vote reward claims." }, { status: 503 });
    }
    if (!hasDatabase()) {
      return NextResponse.json({ error: `Database is required for ${scope.global ? "claim-all-global" : "claim-all"}` }, { status: 503 });
    }

    const body = (await req.json().catch(() => null)) as any;
    const walletPubkey = typeof body?.walletPubkey === "string" ? body.walletPubkey.trim() : "";
    const commitmentId = typeof body?.commitmentId === "string" ? body.commitmentId.trim() : "";
    const action = typeof body?.action === "string" ? body.action.trim() : "prepare";
    const signedTransactionBase64 = typeof body?.signedTransactionBase64 === "string" ? body.signedTransactionBase64.trim() : "";

    if (!walletPubkey) return NextResponse.json({ error: "walletPubkey required" }, { status: 400 });
    if (!scope.global && !commitmentId) return NextResponse.json({ error: "commitmentId required" }, { status: 400 });

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);
    const pk = new PublicKey(walletPubkey);
    await ensurePayoutClaimSchema();

    let signedTx: Transaction | null = null;
    if (action === "finalize") {
      if (!signedTransactionBase64) return NextResponse.json({ error: "signedTransactionBase64 required" }, { status: 400 });
      try {
        signedTx = Transaction.from(Buffer.from(signedTransactionBase64, "base64"));
      } catch {
        return NextResponse.json({ error: "Invalid transaction encoding" }, { status: 400 });
      }
      if (!signedTx.feePayer || !signedTx.feePayer.equals(pk)) return NextResponse.json({ error: "Transaction fee payer does not match wallet" }, { status: 400 });
    } else if (action !== "prepare") {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    const client = await getPool().connect();
    let submit: { tx: Transaction; faucetOwner: PublicKey; txSig: string; lvbhBound: number; distributions: number; amountRaw: bigint } | null = null;
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`vote_reward_claim_wallet:${walletPubkey}`]);

      const pending = await resolveVoteRewardWalletPending(client, connection, walletPubkey);
      if (pending.inFlight.length || pending.legacy.length) {
        await client.query("commit");
        const sameTx = signedTx ? pending.inFlight.find((p) => p.signature && signedTx && p.signature === bs58.encode(Uint8Array.from(signedTx.signatures[0]?.signature ?? []))) : null;
        if (sameTx) {
          return NextResponse.json({ ok: false, pending: true, code: "confirmation_timeout", signature: sameTx.signature, error: "Transaction confirmation timeout", hint: "Your claim transaction is still pending; try again shortly." }, { status: 202 });
        }
        return NextResponse.json(
          {
            error: "Found pending vote reward claims",
            hint: pending.legacy.length && !pending.inFlight.length ? "A previous claim has no recorded transaction; contact support." : "A claim is already in progress. Wait a moment and try again.",
            signatures: pending.inFlight.map((p) => p.signature).filter(Boolean),
          },
          { status: 409 }
        );
      }

      const res = await client.query(
        `select d.id as distribution_id, d.mint_pubkey, d.token_program_pubkey, d.faucet_owner_pubkey, a.amount_raw::text as alloc_amount_raw
         from vote_reward_distribution_allocations a
         join vote_reward_distributions d on d.id=a.distribution_id
         left join vote_reward_distribution_claims c on c.distribution_id=a.distribution_id and c.wallet_pubkey=a.wallet_pubkey
         where a.wallet_pubkey=$1 and c.distribution_id is null ${scope.global ? "" : "and d.commitment_id=$2"}
         order by d.created_at_unix asc, d.id asc`,
        scope.global ? [walletPubkey] : [walletPubkey, commitmentId]
      );
      const rows = (res.rows ?? []).filter((r: any) => {
        try {
          return BigInt(String(r?.alloc_amount_raw ?? "0")) > 0n;
        } catch {
          return false;
        }
      });
      if (!rows.length) {
        await client.query("commit");
        return NextResponse.json({ ok: true, action, nowUnix, claimed: 0, amountRaw: "0", signature: "", ...(scope.global ? { transfers: [] } : {}) });
      }

      const mintPubkey = String(rows[0].mint_pubkey);
      const tokenProgramPubkey = String(rows[0].token_program_pubkey);
      const faucetOwnerPubkey = String(rows[0].faucet_owner_pubkey);
      const ids: string[] = [];
      const amounts: string[] = [];
      let totalAmountRaw = 0n;
      for (const r of rows) {
        if (String(r.mint_pubkey) !== mintPubkey) throw Object.assign(new Error("Multiple mints in claim-all result"), { status: 409 });
        if (String(r.token_program_pubkey) !== tokenProgramPubkey) throw Object.assign(new Error("Multiple token programs in claim-all result"), { status: 409 });
        if (String(r.faucet_owner_pubkey) !== faucetOwnerPubkey) throw Object.assign(new Error("Multiple faucet owners in claim-all result"), { status: 409 });
        const amt = BigInt(String(r.alloc_amount_raw));
        ids.push(String(r.distribution_id));
        amounts.push(amt.toString());
        totalAmountRaw += amt;
      }

      const faucetOwner = new PublicKey(faucetOwnerPubkey);
      const mint = new PublicKey(mintPubkey);
      const tokenProgram = new PublicKey(tokenProgramPubkey);
      const decimals = await getMintDecimals({ connection, mint });
      const instructions = buildVoteRewardClaimInstructions({ wallet: pk, faucetOwner, mint, tokenProgram, amountRaw: totalAmountRaw, decimals });

      if (action === "prepare") {
        await client.query("commit");
        const prepared = await prepareVoteRewardClaimTransaction({ connection, wallet: pk, instructions });
        if (prepared.balanceLamports < prepared.requiredLamports) {
          return NextResponse.json(
            { error: "Insufficient SOL to cover claim transaction fees", code: "insufficient_sol", balanceLamports: prepared.balanceLamports, requiredLamports: prepared.requiredLamports, hint: "Send SOL to this wallet before claiming, then try again." },
            { status: 409 }
          );
        }
        await auditLog(`vote_reward_${label}_prepare_ok`, { walletPubkey, commitmentId: commitmentId || null, distributions: ids.length, amountRaw: totalAmountRaw.toString(), requiredLamports: prepared.requiredLamports });
        return NextResponse.json({
          ok: true,
          action: "prepare",
          nowUnix,
          walletPubkey,
          ...(scope.global ? {} : { commitmentId }),
          amountRaw: totalAmountRaw.toString(),
          distributions: ids.length,
          mintPubkey,
          tokenProgramPubkey,
          faucetOwnerPubkey,
          requiredLamports: prepared.requiredLamports,
          transactionBase64: prepared.transactionBase64,
          blockhash: prepared.blockhash,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
        });
      }

      const tx = signedTx as Transaction;
      const check = await checkSignedVoteRewardTransaction({ connection, tx, wallet: pk, expectedInstructions: instructions });
      if (!check.ok) {
        await client.query("commit"); // keep the pending-claim resolution done above
        return NextResponse.json(
          { error: check.error, hint: check.status === 400 ? "The claimable amount may have changed or the transaction expired. Prepare the claim again." : undefined },
          { status: check.status }
        );
      }

      const lockedIds = await insertVoteRewardPendingClaims(client, { walletPubkey, distributionIds: ids, amountsRaw: amounts, claimedAtUnix: nowUnix, txSig: check.txSig, lvbhBound: check.lvbhBound });
      if (lockedIds.length !== ids.length) {
        // The signed transfer covers every distribution; locking only some of them would overpay.
        await client.query("rollback");
        return NextResponse.json({ error: "Claimable distributions changed while claiming - prepare the claim again", code: "lock_mismatch" }, { status: 409 });
      }
      await client.query("commit");
      submit = { tx, faucetOwner, txSig: check.txSig, lvbhBound: check.lvbhBound, distributions: ids.length, amountRaw: totalAmountRaw };
    } catch (e) {
      try {
        await client.query("rollback");
      } catch {
        // ignore
      }
      throw e;
    } finally {
      client.release();
    }

    const result = await submitVoteRewardClaim({ connection, tx: submit.tx, faucetOwner: submit.faucetOwner, walletPubkey, txSig: submit.txSig, lvbhBound: submit.lvbhBound });
    if (result.status === 200) {
      await auditLog(`vote_reward_${label}_finalize_ok`, { walletPubkey, commitmentId: commitmentId || null, distributions: submit.distributions, txSig: submit.txSig });
      return NextResponse.json({ ok: true, action: "finalize", nowUnix, signature: submit.txSig, distributions: submit.distributions, amountRaw: submit.amountRaw.toString() });
    }
    return NextResponse.json({ action: "finalize", nowUnix, ...result.body }, { status: result.status });
  } catch (e) {
    await auditLog(`vote_reward_${label}_error`, { error: getSafeErrorMessage(e) }).catch(() => null);
    return apiError(e, `vote-reward/${scope.global ? "claim-all-global" : "claim-all"}`, { code: `${label}_failed` });
  }
}
