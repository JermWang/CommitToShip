import crypto from "crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

import { getPool, hasDatabase } from "./db";
import { fetchCloseBalances } from "./voteCloseRecheck";

export type CommitmentKind = "personal" | "creator_reward";

export type CreatorFeeMode = "managed" | "assisted";

export type CommitmentStatus =
  | "created"
  | "resolving"
  | "resolved_success"
  | "resolved_failure"
  | "active"
  | "completed"
  | "failed"
  | "archived";

export type RewardMilestoneStatus = "locked" | "approved" | "claimable" | "released" | "failed";

export type RewardMilestone = {
  id: string;
  title: string;
  unlockLamports: number;
  unlockPercent?: number;
  dueAtUnix?: number;
  status: RewardMilestoneStatus;
  completedAtUnix?: number;
  reviewOpenedAtUnix?: number;
  approvedAtUnix?: number;
  failedAtUnix?: number;
  claimableAtUnix?: number;
  becameClaimableAtUnix?: number;
  releasedAtUnix?: number;
  releasedTxSig?: string;
  autoKind?: "market_cap";
  marketCapThresholdUsd?: number;
  marketCapChainId?: "solana";
  requireNoMintAuthority?: boolean;
  autoConfirmedAtUnix?: number;
  autoEvidence?: unknown;
  /** When market-cap tracking began; only price snapshots after this can satisfy the milestone. */
  autoTrackingStartedAtUnix?: number;
};

export function getEffectiveRewardMilestoneUnlockLamports(input: { milestone: RewardMilestone; totalFundedLamports: number }): number {
  const explicit = Number(input.milestone.unlockLamports ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);

  const pct = Number(input.milestone.unlockPercent ?? 0);
  const total = Number(input.totalFundedLamports ?? 0);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  if (!Number.isFinite(total) || total <= 0) return 0;

  return Math.floor((total * pct) / 100);
}

export async function getVoteRewardDistribution(input: {
  commitmentId: string;
  milestoneId: string;
}): Promise<VoteRewardDistributionRecord | null> {
  await ensureSchema();
  ensureMockSeeded();

  const commitmentId = String(input.commitmentId);
  const milestoneId = String(input.milestoneId);

  if (!hasDatabase()) {
    return mem.voteRewardDistributionsByCommitmentMilestone.get(voteRewardKey({ commitmentId, milestoneId })) ?? null;
  }

  const pool = getPool();
  const res = await pool.query(
    "select id, commitment_id, milestone_id, created_at_unix, mint_pubkey, token_program_pubkey, pool_amount_raw, faucet_owner_pubkey, status from vote_reward_distributions where commitment_id=$1 and milestone_id=$2",
    [commitmentId, milestoneId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    commitmentId: String(row.commitment_id),
    milestoneId: String(row.milestone_id),
    createdAtUnix: Number(row.created_at_unix),
    mintPubkey: String(row.mint_pubkey),
    tokenProgramPubkey: String(row.token_program_pubkey),
    poolAmountRaw: String(row.pool_amount_raw),
    faucetOwnerPubkey: String(row.faucet_owner_pubkey),
    status: String(row.status) as VoteRewardDistributionStatus,
  };
}

export async function tryAcquireVoteRewardDistributionCreate(input: {
  distribution: VoteRewardDistributionRecord;
}): Promise<{ acquired: true } | { acquired: false; existing: VoteRewardDistributionRecord }> {
  await ensureSchema();
  ensureMockSeeded();

  const commitmentId = String(input.distribution.commitmentId);
  const milestoneId = String(input.distribution.milestoneId);

  if (!hasDatabase()) {
    const k = voteRewardKey({ commitmentId, milestoneId });
    const existing = mem.voteRewardDistributionsByCommitmentMilestone.get(k);
    if (existing) return { acquired: false, existing };
    mem.voteRewardDistributionsByCommitmentMilestone.set(k, input.distribution);
    return { acquired: true };
  }

  const pool = getPool();
  const res = await pool.query(
    `insert into vote_reward_distributions (
      id, commitment_id, milestone_id, created_at_unix, mint_pubkey, token_program_pubkey, pool_amount_raw, faucet_owner_pubkey, status
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    on conflict (commitment_id, milestone_id) do nothing
    returning id`,
    [
      input.distribution.id,
      commitmentId,
      milestoneId,
      String(input.distribution.createdAtUnix),
      input.distribution.mintPubkey,
      input.distribution.tokenProgramPubkey,
      String(input.distribution.poolAmountRaw),
      input.distribution.faucetOwnerPubkey,
      input.distribution.status,
    ]
  );
  if (res.rows[0]) return { acquired: true };

  const existing = await getVoteRewardDistribution({ commitmentId, milestoneId });
  if (!existing) throw new Error("Failed to acquire vote reward distribution");
  return { acquired: false, existing };
}

export async function insertVoteRewardDistributionAllocations(input: {
  distributionId: string;
  allocations: VoteRewardDistributionAllocation[];
}): Promise<void> {
  await ensureSchema();
  ensureMockSeeded();

  if (!hasDatabase()) {
    const byWallet = new Map<string, VoteRewardDistributionAllocation>();
    for (const a of input.allocations) byWallet.set(a.walletPubkey, a);
    mem.voteRewardAllocationsByDistributionId.set(input.distributionId, byWallet);
    return;
  }

  const pool = getPool();
  for (const a of input.allocations) {
    await pool.query(
      `insert into vote_reward_distribution_allocations (distribution_id, wallet_pubkey, amount_raw, weight)
       values ($1,$2,$3,$4)
       on conflict (distribution_id, wallet_pubkey) do nothing`,
      [a.distributionId, a.walletPubkey, String(a.amountRaw), a.weight]
    );
  }
}

export async function getVoteRewardAllocation(input: {
  distributionId: string;
  walletPubkey: string;
}): Promise<VoteRewardDistributionAllocation | null> {
  await ensureSchema();
  ensureMockSeeded();

  if (!hasDatabase()) {
    const byWallet = mem.voteRewardAllocationsByDistributionId.get(input.distributionId);
    return byWallet?.get(input.walletPubkey) ?? null;
  }

  const pool = getPool();
  const res = await pool.query(
    `select distribution_id, wallet_pubkey, amount_raw, weight
     from vote_reward_distribution_allocations where distribution_id=$1 and wallet_pubkey=$2`,
    [input.distributionId, input.walletPubkey]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    distributionId: String(row.distribution_id),
    walletPubkey: String(row.wallet_pubkey),
    amountRaw: String(row.amount_raw),
    weight: Number(row.weight),
  };
}

export async function tryAcquireVoteRewardDistributionClaim(input: {
  distributionId: string;
  walletPubkey: string;
  claimedAtUnix: number;
  amountRaw: string;
}): Promise<{ acquired: true } | { acquired: false; existing: VoteRewardDistributionClaim }> {
  await ensureSchema();
  ensureMockSeeded();

  const rec: VoteRewardDistributionClaim = {
    distributionId: input.distributionId,
    walletPubkey: input.walletPubkey,
    claimedAtUnix: Math.floor(input.claimedAtUnix),
    amountRaw: String(input.amountRaw),
    txSig: null,
  };

  if (!hasDatabase()) {
    let byWallet = mem.voteRewardClaimsByDistributionId.get(rec.distributionId);
    if (!byWallet) {
      byWallet = new Map();
      mem.voteRewardClaimsByDistributionId.set(rec.distributionId, byWallet);
    }
    const existing = byWallet.get(rec.walletPubkey);
    if (existing) return { acquired: false, existing };
    byWallet.set(rec.walletPubkey, rec);
    return { acquired: true };
  }

  const pool = getPool();
  const res = await pool.query(
    `insert into vote_reward_distribution_claims (distribution_id, wallet_pubkey, claimed_at_unix, amount_raw, tx_sig)
     values ($1,$2,$3,$4,'')
     on conflict (distribution_id, wallet_pubkey) do nothing
     returning distribution_id`,
    [rec.distributionId, rec.walletPubkey, String(rec.claimedAtUnix), String(rec.amountRaw)]
  );

  if (res.rows[0]) return { acquired: true };

  const existingRes = await pool.query(
    "select distribution_id, wallet_pubkey, claimed_at_unix, amount_raw, tx_sig from vote_reward_distribution_claims where distribution_id=$1 and wallet_pubkey=$2",
    [rec.distributionId, rec.walletPubkey]
  );
  const row = existingRes.rows[0];
  const txSigRaw = row ? String(row.tx_sig ?? "") : "";
  const txSig = txSigRaw.trim().length ? txSigRaw.trim() : null;
  const existing: VoteRewardDistributionClaim = {
    distributionId: rec.distributionId,
    walletPubkey: rec.walletPubkey,
    claimedAtUnix: row ? Number(row.claimed_at_unix) : rec.claimedAtUnix,
    amountRaw: row ? String(row.amount_raw) : rec.amountRaw,
    txSig,
  };
  return { acquired: false, existing };
}

export async function setVoteRewardDistributionClaimTxSig(input: {
  distributionId: string;
  walletPubkey: string;
  txSig: string;
}): Promise<void> {
  await ensureSchema();
  ensureMockSeeded();

  if (!hasDatabase()) {
    const byWallet = mem.voteRewardClaimsByDistributionId.get(input.distributionId);
    const existing = byWallet?.get(input.walletPubkey);
    if (existing) {
      byWallet?.set(input.walletPubkey, { ...existing, txSig: input.txSig });
    }
    return;
  }

  const pool = getPool();
  await pool.query(
    "update vote_reward_distribution_claims set tx_sig=$3 where distribution_id=$1 and wallet_pubkey=$2 and (tx_sig is null or tx_sig='')",
    [input.distributionId, input.walletPubkey, input.txSig]
  );
}

/**
 * Creates a vote reward distribution together with ALL of its allocations in one transaction (no allocation can
 * exist before the distribution is final). The pool cap is enforced in SQL inside the same transaction: the sum of
 * the allocations must not exceed the distribution's pool_amount_raw, nor `maxPoolAmountRaw` when given; otherwise
 * everything is rolled back. Exactly one concurrent caller creates it; the others get `existing`.
 */
export async function createVoteRewardDistributionWithAllocations(input: {
  distribution: VoteRewardDistributionRecord;
  allocations: VoteRewardDistributionAllocation[];
  maxPoolAmountRaw?: string | null;
}): Promise<{ created: true } | { created: false; existing: VoteRewardDistributionRecord }> {
  await ensureSchema();
  ensureMockSeeded();

  const d = input.distribution;
  const maxPool = input.maxPoolAmountRaw == null || String(input.maxPoolAmountRaw).trim() === "" ? null : BigInt(String(input.maxPoolAmountRaw));
  let sum = 0n;
  for (const a of input.allocations) {
    const amt = BigInt(String(a.amountRaw));
    if (amt <= 0n) throw new Error("Vote reward allocation must be positive");
    if (a.distributionId !== d.id) throw new Error("Vote reward allocation distribution mismatch");
    sum += amt;
  }
  if (sum > BigInt(String(d.poolAmountRaw))) throw new Error("Vote reward allocations exceed the distribution pool");
  if (maxPool != null && sum > maxPool) throw new Error("Vote reward allocations exceed CTS_VOTE_REWARD_MAX_POOL_UI_AMOUNT");

  if (!hasDatabase()) {
    const k = voteRewardKey({ commitmentId: d.commitmentId, milestoneId: d.milestoneId });
    const existing = mem.voteRewardDistributionsByCommitmentMilestone.get(k);
    if (existing) return { created: false, existing };
    mem.voteRewardDistributionsByCommitmentMilestone.set(k, d);
    const byWallet = new Map<string, VoteRewardDistributionAllocation>();
    for (const a of input.allocations) byWallet.set(a.walletPubkey, a);
    mem.voteRewardAllocationsByDistributionId.set(d.id, byWallet);
    return { created: true };
  }

  const client = await getPool().connect();
  let committed = false;
  let released = false;
  try {
    await client.query("begin");
    const ins = await client.query(
      `insert into vote_reward_distributions (
        id, commitment_id, milestone_id, created_at_unix, mint_pubkey, token_program_pubkey, pool_amount_raw, faucet_owner_pubkey, status
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (commitment_id, milestone_id) do nothing
      returning id`,
      [d.id, d.commitmentId, d.milestoneId, String(d.createdAtUnix), d.mintPubkey, d.tokenProgramPubkey, String(d.poolAmountRaw), d.faucetOwnerPubkey, d.status]
    );
    if (!ins.rows[0]) {
      await client.query("rollback");
      committed = true;
      // Give the connection back BEFORE reading through the pool: concurrent losers holding their clients while
      // waiting for another one would starve the pool.
      client.release();
      released = true;
      const existing = await getVoteRewardDistribution({ commitmentId: d.commitmentId, milestoneId: d.milestoneId });
      if (!existing) throw new Error("Failed to acquire vote reward distribution");
      return { created: false, existing };
    }

    if (input.allocations.length) {
      await client.query(
        `insert into vote_reward_distribution_allocations (distribution_id, wallet_pubkey, amount_raw, weight)
         select $1, w, a::bigint, x from unnest($2::text[], $3::text[], $4::double precision[]) as t(w, a, x)`,
        [d.id, input.allocations.map((a) => a.walletPubkey), input.allocations.map((a) => String(a.amountRaw)), input.allocations.map((a) => Number(a.weight) || 0)]
      );
    }

    // Cap enforced by the database, inside the same transaction.
    const capCheck = await client.query(
      `select coalesce(sum(a.amount_raw), 0) <= d.pool_amount_raw and ($2::numeric is null or coalesce(sum(a.amount_raw), 0) <= $2::numeric) as ok
       from vote_reward_distributions d
       left join vote_reward_distribution_allocations a on a.distribution_id = d.id
       where d.id = $1
       group by d.pool_amount_raw`,
      [d.id, maxPool == null ? null : maxPool.toString()]
    );
    if (capCheck.rows[0]?.ok !== true) throw new Error("Vote reward allocations exceed the pool cap");

    await client.query("commit");
    committed = true;
    return { created: true };
  } catch (e) {
    if (!committed) {
      try {
        await client.query("rollback");
      } catch {
        // ignore
      }
    }
    throw e;
  } finally {
    if (!released) client.release();
  }
}

/**
 * Single-use nonce (request id / signature) for signed requests. Returns false if it was already used in `scope`.
 * Old entries are pruned opportunistically (anything older than 7 days can no longer pass a timestamp check).
 */
export async function tryConsumeSignedRequestNonce(input: { scope: string; nonce: string; nowUnix?: number }): Promise<boolean> {
  await ensureSchema();
  const scope = String(input.scope ?? "").trim();
  const nonce = String(input.nonce ?? "").trim();
  if (!scope || !nonce) throw new Error("scope and nonce are required");
  const now = Math.floor(Number(input.nowUnix ?? nowUnix()));

  if (!hasDatabase()) {
    const g = globalThis as any;
    const set: Set<string> = g.__cts_signed_request_nonces ?? (g.__cts_signed_request_nonces = new Set<string>());
    const k = `${scope}\u0000${nonce}`;
    if (set.has(k)) return false;
    set.add(k);
    return true;
  }

  const pool = getPool();
  const res = await pool.query(
    "insert into signed_request_nonces (scope, nonce, created_at_unix) values ($1,$2,$3) on conflict (scope, nonce) do nothing returning nonce",
    [scope, nonce, String(now)]
  );
  if (Math.random() < 0.02) {
    pool.query("delete from signed_request_nonces where created_at_unix < $1", [String(now - 7 * 86400)]).catch(() => null);
  }
  return Boolean(res.rows[0]);
}

/** Sum of the unlock percentages a milestone list allocates (explicit lamports are converted against totalFunded). */
export function allocatedPercentFromMilestones(input: { milestones: RewardMilestone[]; totalFundedLamports: number }): number {
  const total = Number(input.totalFundedLamports ?? 0);
  return input.milestones.reduce((acc, m) => {
    const explicitLamports = Number(m.unlockLamports ?? 0);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(explicitLamports) && explicitLamports > 0) {
      return acc + (explicitLamports / total) * 100;
    }
    return acc + (Number(m.unlockPercent ?? 0) || 0);
  }, 0);
}

export type CommitmentRecord = {
  id: string;
  statement?: string;
  authority: string;
  destinationOnFail: string;
  amountLamports: number;
  deadlineUnix: number;
  escrowPubkey: string;
  escrowSecretKey: string;
  kind: CommitmentKind;
  creatorPubkey?: string;
  creatorFeeMode?: CreatorFeeMode;
  tokenMint?: string;
  totalFundedLamports: number;
  unlockedLamports: number;
  milestones?: RewardMilestone[];
  status: CommitmentStatus;
  createdAtUnix: number;
  resolvedAtUnix?: number;
  resolvedTxSig?: string;
};

export type RewardMilestoneApprovalCounts = Record<string, number>;

export type RewardMilestoneVote = "approve" | "reject";

export type RewardMilestoneVoteCounts = {
  approvalCounts: RewardMilestoneApprovalCounts;
  rejectCounts: RewardMilestoneApprovalCounts;
  totalCounts: RewardMilestoneApprovalCounts;
  /** Milestones whose vote window closed but whose close-time holder re-check has not completed yet. */
  pendingCloseRecheck?: Record<string, boolean>;
};

type InMemoryRewardSignals = Map<
  string,
  Map<string, Map<string, { createdAtUnix: number; weightUsd: number; vote: RewardMilestoneVote }>>
>;

export type RewardVoterSnapshot = {
  commitmentId: string;
  milestoneId: string;
  signerPubkey: string;
  createdAtUnix: number;
  projectMint: string;
  projectUiAmount: number;
  projectPriceUsd?: number;
  projectValueUsd?: number;
  shipUiAmount: number;
  shipMultiplierBps: number;
};

export type RewardMilestonePayoutClaim = {
  commitmentId: string;
  milestoneId: string;
  createdAtUnix: number;
  toPubkey: string;
  amountLamports: number;
  txSig?: string | null;
};

export type FailureDistributionStatus = "open" | "completed";

export type FailureDistributionRecord = {
  id: string;
  commitmentId: string;
  createdAtUnix: number;
  buybackLamports: number;
  voterPotLamports: number;
  shipBuybackTreasuryPubkey: string;
  buybackTxSig: string;
  voterPotTxSig?: string;
  status: FailureDistributionStatus;
};

export type FailureDistributionAllocation = {
  distributionId: string;
  walletPubkey: string;
  amountLamports: number;
  weight: number;
};

export type FailureDistributionClaim = {
  distributionId: string;
  walletPubkey: string;
  claimedAtUnix: number;
  amountLamports: number;
  txSig?: string | null;
};

export type VoteRewardDistributionStatus = "open" | "completed";

export type VoteRewardDistributionRecord = {
  id: string;
  commitmentId: string;
  milestoneId: string;
  createdAtUnix: number;
  mintPubkey: string;
  tokenProgramPubkey: string;
  poolAmountRaw: string;
  faucetOwnerPubkey: string;
  status: VoteRewardDistributionStatus;
};

export type VoteRewardDistributionAllocation = {
  distributionId: string;
  walletPubkey: string;
  amountRaw: string;
  weight: number;
};

export type VoteRewardDistributionClaim = {
  distributionId: string;
  walletPubkey: string;
  claimedAtUnix: number;
  amountRaw: string;
  txSig?: string | null;
};

 export type MilestoneFailureDistributionStatus = "open" | "completed";

 export type MilestoneFailureDistributionRecord = {
  id: string;
  commitmentId: string;
  milestoneId: string;
  createdAtUnix: number;
  forfeitedLamports: number;
  buybackLamports: number;
  voteRewardLamports: number;
  voterPotLamports: number;
  shipBuybackTreasuryPubkey: string;
  voteRewardTreasuryPubkey?: string;
  buybackTxSig: string;
  voteRewardTxSig?: string;
  voterPotTxSig?: string;
  status: MilestoneFailureDistributionStatus;
 };

 export type MilestoneFailureDistributionAllocation = {
  distributionId: string;
  walletPubkey: string;
  amountLamports: number;
  weight: number;
 };

 export type MilestoneFailureDistributionClaim = {
  distributionId: string;
  walletPubkey: string;
  claimedAtUnix: number;
  amountLamports: number;
  txSig?: string | null;
 };

const mem = {
  commitments: new Map<string, CommitmentRecord>(),
  rewardSignals: new Map() as InMemoryRewardSignals,
  rewardVoterSnapshots: new Map<string, Map<string, Map<string, RewardVoterSnapshot>>>(),
  rewardMilestonePayoutClaims: new Map<string, RewardMilestonePayoutClaim>(),
  failureDistributionsByCommitmentId: new Map<string, FailureDistributionRecord>(),
  failureAllocationsByDistributionId: new Map<string, Map<string, FailureDistributionAllocation>>(),
  failureClaimsByDistributionId: new Map<string, Map<string, FailureDistributionClaim>>(),
  milestoneFailureDistributionsByCommitmentMilestone: new Map<string, MilestoneFailureDistributionRecord>(),
  milestoneFailureAllocationsByDistributionId: new Map<string, Map<string, MilestoneFailureDistributionAllocation>>(),
  milestoneFailureClaimsByDistributionId: new Map<string, Map<string, MilestoneFailureDistributionClaim>>(),
  voteRewardDistributionsByCommitmentMilestone: new Map<string, VoteRewardDistributionRecord>(),
  voteRewardAllocationsByDistributionId: new Map<string, Map<string, VoteRewardDistributionAllocation>>(),
  voteRewardClaimsByDistributionId: new Map<string, Map<string, VoteRewardDistributionClaim>>(),
};

function ensureMockSeeded(): void {
  if (hasDatabase()) return;
  if (mem.commitments.size > 0) return;

  const now = nowUnix();

  const seededBytes = (label: string, length: number) => {
    const out = new Uint8Array(length);
    let offset = 0;
    let i = 0;
    while (offset < length) {
      const h = crypto.createHash("sha256");
      h.update(`cts_mock:${label}:${i++}`, "utf8");
      const chunk = new Uint8Array(h.digest());
      const take = Math.min(chunk.length, length - offset);
      out.set(chunk.slice(0, take), offset);
      offset += take;
    }
    return out;
  };

  const makeId = (label: string) => {
    const h = crypto.createHash("sha256");
    h.update(`cts_mock_id:${label}`, "utf8");
    return h.digest("hex").slice(0, 32);
  };

  const makeKeypair = (label: string) => {
    const seed = seededBytes(`kp:${label}`, 32);
    return Keypair.fromSeed(seed);
  };

  const makeSig = (label: string) => bs58.encode(seededBytes(`sig:${label}`, 64));

  const makeCommitmentKeypair = (label: string) => {
    const escrow = makeKeypair(`escrow:${label}`);
    return {
      escrowPubkey: escrow.publicKey.toBase58(),
      escrowSecretKeyB58: bs58.encode(escrow.secretKey),
    };
  };

  const makeWallet = (label: string) => makeKeypair(`wallet:${label}`).publicKey.toBase58();

  const personal1 = (() => {
    const { escrowPubkey, escrowSecretKeyB58 } = makeCommitmentKeypair("personal1");
    const authority = makeWallet("personal1:authority");
    const destinationOnFail = makeWallet("personal1:destinationOnFail");
    const id = makeId("personal1");
    const createdAtUnix = now - 36 * 60 * 60;
    return {
      ...createCommitmentRecord({
        id,
        statement: "Ship v1 onboarding + landing polish",
        authority,
        destinationOnFail,
        amountLamports: Math.floor(0.5 * 1_000_000_000),
        deadlineUnix: now + 3 * 24 * 60 * 60,
        escrowPubkey,
        escrowSecretKeyB58,
      }),
      createdAtUnix,
      status: "created" as const,
    } satisfies CommitmentRecord;
  })();

  const personal2 = (() => {
    const { escrowPubkey, escrowSecretKeyB58 } = makeCommitmentKeypair("personal2");
    const authority = makeWallet("personal2:authority");
    const destinationOnFail = makeWallet("personal2:destinationOnFail");
    const id = makeId("personal2");
    const createdAtUnix = now - 6 * 24 * 60 * 60;
    const resolvedAtUnix = now - 4 * 60 * 60;
    return {
      ...createCommitmentRecord({
        id,
        statement: "Publish audit report + fix P0 bugs",
        authority,
        destinationOnFail,
        amountLamports: Math.floor(1.25 * 1_000_000_000),
        deadlineUnix: now + 24 * 60 * 60,
        escrowPubkey,
        escrowSecretKeyB58,
      }),
      createdAtUnix,
      status: "resolved_success" as const,
      resolvedAtUnix,
      resolvedTxSig: makeSig("personal2:resolved_success"),
    } satisfies CommitmentRecord;
  })();

  const personal3 = (() => {
    const { escrowPubkey, escrowSecretKeyB58 } = makeCommitmentKeypair("personal3");
    const authority = makeWallet("personal3:authority");
    const destinationOnFail = makeWallet("personal3:destinationOnFail");
    const id = makeId("personal3");
    const createdAtUnix = now - 12 * 24 * 60 * 60;
    const deadlineUnix = now - 3 * 24 * 60 * 60;
    const resolvedAtUnix = now - 2 * 24 * 60 * 60;
    return {
      ...createCommitmentRecord({
        id,
        statement: "Open-source core escrow contracts",
        authority,
        destinationOnFail,
        amountLamports: Math.floor(0.75 * 1_000_000_000),
        deadlineUnix,
        escrowPubkey,
        escrowSecretKeyB58,
      }),
      createdAtUnix,
      deadlineUnix,
      status: "resolved_failure" as const,
      resolvedAtUnix,
      resolvedTxSig: makeSig("personal3:resolved_failure"),
    } satisfies CommitmentRecord;
  })();

  const reward1 = (() => {
    const { escrowPubkey, escrowSecretKeyB58 } = makeCommitmentKeypair("reward1");
    const creatorPubkey = makeWallet("reward1:creator");
    const tokenMint = makeWallet("reward1:tokenMint");
    const id = makeId("reward1");
    const createdAtUnix = now - 10 * 24 * 60 * 60;

    const m1Id = makeId("reward1:m1");
    const m2Id = makeId("reward1:m2");
    const m3Id = makeId("reward1:m3");
    const m4Id = makeId("reward1:m4");

    const base = createRewardCommitmentRecord({
      id,
      statement: "Weekly dev-fee unlocks for shipping v2",
      creatorPubkey,
      escrowPubkey,
      escrowSecretKeyB58,
      tokenMint,
      milestones: [
        { id: m1Id, title: "Ship v2 alpha build", unlockLamports: Math.floor(1.0 * 1_000_000_000) },
        { id: m2Id, title: "Ship v2 beta + docs", unlockLamports: Math.floor(1.5 * 1_000_000_000) },
        { id: m3Id, title: "Public mainnet release", unlockLamports: Math.floor(2.0 * 1_000_000_000) },
        { id: m4Id, title: "Post-launch stability week", unlockLamports: Math.floor(0.75 * 1_000_000_000) },
      ],
    });

    const milestones = base.milestones;
    if (!milestones || milestones.length < 4) {
      throw new Error("Invalid seed reward commitment (missing milestones)");
    }

    const m1 = milestones[0];
    const m2 = milestones[1];
    const m3 = milestones[2];
    const m4 = milestones[3];

    const m1Completed = now - 8 * 24 * 60 * 60;
    const m1Claimable = m1Completed + 48 * 60 * 60;
    const m1Released = now - 6 * 24 * 60 * 60;

    const m2Completed = now - 4 * 24 * 60 * 60;
    const m2Claimable = m2Completed + 48 * 60 * 60;
    const m2BecameClaimable = now - 2 * 24 * 60 * 60;

    const m3Completed = now - 12 * 60 * 60;
    const m3Claimable = m3Completed + 48 * 60 * 60;

    const m4Completed = null;

    return {
      ...base,
      createdAtUnix,
      status: "active" as const,
      totalFundedLamports: Math.floor(5.25 * 1_000_000_000),
      unlockedLamports: Math.floor(2.5 * 1_000_000_000),
      milestones: [
        {
          ...m1,
          status: "released" as const,
          completedAtUnix: m1Completed,
          claimableAtUnix: m1Claimable,
          becameClaimableAtUnix: m1Claimable,
          releasedAtUnix: m1Released,
          releasedTxSig: makeSig("reward1:m1:released"),
        },
        {
          ...m2,
          status: "claimable" as const,
          completedAtUnix: m2Completed,
          claimableAtUnix: m2Claimable,
          becameClaimableAtUnix: m2BecameClaimable,
        },
        {
          ...m3,
          status: "locked" as const,
          completedAtUnix: m3Completed,
          claimableAtUnix: m3Claimable,
        },
        {
          ...m4,
          status: "locked" as const,
          completedAtUnix: m4Completed ?? undefined,
          claimableAtUnix: undefined,
        },
      ],
    } satisfies CommitmentRecord;
  })();

  const reward2 = (() => {
    const { escrowPubkey, escrowSecretKeyB58 } = makeCommitmentKeypair("reward2");
    const creatorPubkey = makeWallet("reward2:creator");
    const tokenMint = makeWallet("reward2:tokenMint");
    const id = makeId("reward2");
    const createdAtUnix = now - 22 * 24 * 60 * 60;
    const releasedAtUnix = now - 7 * 24 * 60 * 60;

    const base = createRewardCommitmentRecord({
      id,
      statement: "Milestone rewards for shipping creator tools",
      creatorPubkey,
      escrowPubkey,
      escrowSecretKeyB58,
      tokenMint,
      milestones: [
        { id: makeId("reward2:m1"), title: "Ship creator dashboard", unlockLamports: Math.floor(3 * 1_000_000_000) },
        { id: makeId("reward2:m2"), title: "Ship analytics + alerts", unlockLamports: Math.floor(4 * 1_000_000_000) },
        { id: makeId("reward2:m3"), title: "Ship gasless voting UX", unlockLamports: Math.floor(3 * 1_000_000_000) },
      ],
    });

    return {
      ...base,
      createdAtUnix,
      status: "completed" as const,
      totalFundedLamports: Math.floor(10 * 1_000_000_000),
      unlockedLamports: Math.floor(10 * 1_000_000_000),
      milestones: (base.milestones ?? []).map((m, idx) => {
        const completedAtUnix = releasedAtUnix - (idx + 2) * 24 * 60 * 60;
        const claimableAtUnix = completedAtUnix + 48 * 60 * 60;
        return {
          ...m,
          status: "released" as const,
          completedAtUnix,
          claimableAtUnix,
          becameClaimableAtUnix: claimableAtUnix,
          releasedAtUnix: releasedAtUnix - idx * 12 * 60 * 60,
          releasedTxSig: makeSig(`reward2:m${idx + 1}:released`),
        };
      }),
    } satisfies CommitmentRecord;
  })();

  const reward3 = (() => {
    const { escrowPubkey, escrowSecretKeyB58 } = makeCommitmentKeypair("reward3");
    const creatorPubkey = makeWallet("reward3:creator");
    const tokenMint = makeWallet("reward3:tokenMint");
    const id = makeId("reward3");
    const createdAtUnix = now - 2 * 24 * 60 * 60;

    const base = createRewardCommitmentRecord({
      id,
      statement: "Dev-fee escrow for the next 30 days",
      creatorPubkey,
      escrowPubkey,
      escrowSecretKeyB58,
      tokenMint,
      milestones: [
        { id: makeId("reward3:m1"), title: "Ship patch release", unlockLamports: Math.floor(0.4 * 1_000_000_000) },
        { id: makeId("reward3:m2"), title: "Ship marketing push", unlockLamports: Math.floor(0.6 * 1_000_000_000) },
      ],
    });

    return {
      ...base,
      createdAtUnix,
      status: "active" as const,
      totalFundedLamports: Math.floor(1.1 * 1_000_000_000),
      unlockedLamports: 0,
    } satisfies CommitmentRecord;
  })();

  for (const c of [personal1, reward1, personal2, reward3, personal3, reward2]) {
    mem.commitments.set(c.id, c);
  }

  const seedSignals = (commitmentId: string, milestoneId: string, count: number) => {
    let byMilestone = mem.rewardSignals.get(commitmentId);
    if (!byMilestone) {
      byMilestone = new Map();
      mem.rewardSignals.set(commitmentId, byMilestone);
    }
    let bySigner = byMilestone.get(milestoneId);
    if (!bySigner) {
      bySigner = new Map();
      byMilestone.set(milestoneId, bySigner);
    }
    const minUsd = 20;
    while (bySigner.size < count) {
      const idx = bySigner.size + 1;
      const pk = makeKeypair(`signal:${commitmentId}:${milestoneId}:${idx}`).publicKey.toBase58();
      bySigner.set(pk, { createdAtUnix: nowUnix(), weightUsd: minUsd, vote: "approve" });
    }
  };

  const r1 = reward1;
  const r1Milestones = r1.milestones ?? [];
  if (r1Milestones[0]) seedSignals(r1.id, r1Milestones[0].id, 11);
  if (r1Milestones[1]) seedSignals(r1.id, r1Milestones[1].id, 7);
  if (r1Milestones[2]) seedSignals(r1.id, r1Milestones[2].id, 2);
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function sha256Bytes(input: string): Uint8Array {
  const h = crypto.createHash("sha256");
  h.update(input, "utf8");
  return new Uint8Array(h.digest());
}

function encryptSecret(plainB58: string): string {
  if (String(plainB58 ?? "").trim().startsWith("privy:")) {
    return String(plainB58).trim();
  }

  const secret = process.env.ESCROW_DB_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("ESCROW_DB_SECRET is required in production");
    }
    return plainB58;
  }

  const key = sha256Bytes(secret);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const msg = new TextEncoder().encode(plainB58);
  const box = nacl.secretbox(msg, nonce, key);

  const packed = new Uint8Array(nonce.length + box.length);
  packed.set(nonce, 0);
  packed.set(box, nonce.length);
  return `enc:${Buffer.from(packed).toString("base64")}`;
}

function decryptSecret(stored: string): string {
  const trimmed = String(stored ?? "").trim();
  if (trimmed.startsWith("privy:")) return trimmed;
  if (!trimmed.startsWith("enc:")) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Escrow secret is not encrypted (missing enc: prefix)");
    }
    return trimmed;
  }

  const secret = process.env.ESCROW_DB_SECRET;
  if (!secret) throw new Error("ESCROW_DB_SECRET is required to decrypt escrow secrets");

  const key = sha256Bytes(secret);
  const packed = Buffer.from(trimmed.slice("enc:".length), "base64");
  const nonce = new Uint8Array(packed.subarray(0, nacl.secretbox.nonceLength));
  const box = new Uint8Array(packed.subarray(nacl.secretbox.nonceLength));
  const opened = nacl.secretbox.open(box, nonce, key);
  if (!opened) throw new Error("Failed to decrypt escrow secret");
  return new TextDecoder().decode(opened);
}

let ensuredSchema: Promise<void> | null = null;

/** Public entry point so routes that query these tables directly never depend on boot-time warm-up. */
export async function ensureEscrowSchema(): Promise<void> {
  await ensureSchema();
}

async function ensureSchema(): Promise<void> {
  if (!hasDatabase()) return;
  if (ensuredSchema) return ensuredSchema;

  ensuredSchema = (async () => {
    const pool = getPool();
    await pool.query(`
    create table if not exists commitments (
      id text primary key,
      statement text null,
      authority text not null,
      destination_on_fail text not null,
      amount_lamports bigint not null,
      deadline_unix bigint not null,
      escrow_pubkey text not null,
      escrow_secret_key text not null,
      kind text not null default 'personal',
      creator_pubkey text null,
      creator_fee_mode text null,
      token_mint text null,
      total_funded_lamports bigint not null default 0,
      unlocked_lamports bigint not null default 0,
      milestones_json text null,
      status text not null,
      created_at_unix bigint not null,
      resolved_at_unix bigint null,
      resolved_tx_sig text null
    );
    create index if not exists commitments_status_idx on commitments(status);
    create index if not exists commitments_deadline_idx on commitments(deadline_unix);
    create index if not exists commitments_kind_idx on commitments(kind);
  `);

    await pool.query(`alter table commitments add column if not exists statement text null;`);
    await pool.query(`alter table commitments add column if not exists kind text not null default 'personal';`);
    await pool.query(`alter table commitments add column if not exists creator_pubkey text null;`);
    await pool.query(`alter table commitments add column if not exists creator_fee_mode text null;`);
    await pool.query(`alter table commitments add column if not exists token_mint text null;`);
    await pool.query(`alter table commitments add column if not exists total_funded_lamports bigint not null default 0;`);
    await pool.query(`alter table commitments add column if not exists unlocked_lamports bigint not null default 0;`);
    await pool.query(`alter table commitments add column if not exists milestones_json text null;`);

    await pool.query(`
    create table if not exists reward_milestone_signals (
      commitment_id text not null,
      milestone_id text not null,
      signer_pubkey text not null,
      vote text not null default 'approve',
      created_at_unix bigint not null,
      project_price_usd double precision not null default 0,
      project_value_usd double precision not null default 0,
      primary key (commitment_id, milestone_id, signer_pubkey)
    );
    create index if not exists reward_milestone_signals_commitment_idx on reward_milestone_signals(commitment_id);
    create index if not exists reward_milestone_signals_milestone_idx on reward_milestone_signals(commitment_id, milestone_id);
  `);

    await pool.query(`alter table reward_milestone_signals add column if not exists vote text not null default 'approve';`);
    await pool.query(`alter table reward_milestone_signals add column if not exists project_price_usd double precision not null default 0;`);
    await pool.query(`alter table reward_milestone_signals add column if not exists project_value_usd double precision not null default 0;`);
    // Close-time holder re-check (a vote only counts if the wallet still holds the minimum when the window closes).
    await pool.query(`
    alter table reward_milestone_signals add column if not exists vote_amount_raw text null;
    alter table reward_milestone_signals add column if not exists token_decimals integer null;
    alter table reward_milestone_signals add column if not exists min_amount_raw text null;
    alter table reward_milestone_signals add column if not exists close_checked_at_unix bigint null;
    alter table reward_milestone_signals add column if not exists close_amount_raw text null;
    alter table reward_milestone_signals add column if not exists close_eligible boolean null;
    alter table reward_milestone_signals add column if not exists close_slot bigint null;
  `);

    // Single-use request ids / signatures (replay protection for signed requests).
    await pool.query(`
    create table if not exists signed_request_nonces (
      scope text not null,
      nonce text not null,
      created_at_unix bigint not null,
      primary key (scope, nonce)
    );
    create index if not exists signed_request_nonces_created_idx on signed_request_nonces(created_at_unix);
  `);

    await pool.query(`
    create table if not exists reward_voter_snapshots (
      commitment_id text not null,
      milestone_id text not null,
      signer_pubkey text not null,
      created_at_unix bigint not null,
      project_mint text not null,
      project_ui_amount double precision not null,
      project_price_usd double precision not null default 0,
      project_value_usd double precision not null default 0,
      ship_ui_amount double precision not null default 0,
      ship_multiplier_bps integer not null default 10000,
      primary key (commitment_id, milestone_id, signer_pubkey)
    );
    create index if not exists reward_voter_snapshots_commitment_idx on reward_voter_snapshots(commitment_id);
  `);

    await pool.query(`alter table reward_voter_snapshots add column if not exists project_price_usd double precision not null default 0;`);
    await pool.query(`alter table reward_voter_snapshots add column if not exists project_value_usd double precision not null default 0;`);

    await pool.query(`
    create table if not exists failure_distributions (
      id text primary key,
      commitment_id text not null unique,
      created_at_unix bigint not null,
      buyback_lamports bigint not null,
      voter_pot_lamports bigint not null,
      ship_buyback_treasury_pubkey text not null,
      buyback_tx_sig text not null,
      voter_pot_tx_sig text null,
      status text not null
    );
    create index if not exists failure_distributions_commitment_idx on failure_distributions(commitment_id);
  `);

    await pool.query(`
    create table if not exists failure_distribution_allocations (
      distribution_id text not null,
      wallet_pubkey text not null,
      amount_lamports bigint not null,
      weight double precision not null,
      primary key (distribution_id, wallet_pubkey)
    );
    create index if not exists failure_distribution_allocations_distribution_idx on failure_distribution_allocations(distribution_id);
  `);

    await pool.query(`
    create table if not exists failure_distribution_claims (
      distribution_id text not null,
      wallet_pubkey text not null,
      claimed_at_unix bigint not null,
      amount_lamports bigint not null,
      tx_sig text null,
      primary key (distribution_id, wallet_pubkey)
    );
    create index if not exists failure_distribution_claims_distribution_idx on failure_distribution_claims(distribution_id);
  `);

    await pool.query(`
    create table if not exists milestone_failure_distributions (
      id text primary key,
      commitment_id text not null,
      milestone_id text not null,
      created_at_unix bigint not null,
      forfeited_lamports bigint not null,
      buyback_lamports bigint not null,
      voter_pot_lamports bigint not null,
      ship_buyback_treasury_pubkey text not null,
      buyback_tx_sig text not null,
      voter_pot_tx_sig text null,
      status text not null,
      unique (commitment_id, milestone_id)
    );
    create index if not exists milestone_failure_distributions_commitment_idx on milestone_failure_distributions(commitment_id);
    create index if not exists milestone_failure_distributions_commitment_milestone_idx on milestone_failure_distributions(commitment_id, milestone_id);
  `);

    try {
      await pool.query("alter table milestone_failure_distributions add column if not exists vote_reward_lamports bigint not null default 0");
    } catch {}
    try {
      await pool.query("alter table milestone_failure_distributions add column if not exists vote_reward_treasury_pubkey text null");
    } catch {}
    try {
      await pool.query("alter table milestone_failure_distributions add column if not exists vote_reward_tx_sig text null");
    } catch {}

    await pool.query(`
    create table if not exists milestone_failure_distribution_allocations (
      distribution_id text not null,
      wallet_pubkey text not null,
      amount_lamports bigint not null,
      weight double precision not null,
      primary key (distribution_id, wallet_pubkey)
    );
    create index if not exists milestone_failure_distribution_allocations_distribution_idx on milestone_failure_distribution_allocations(distribution_id);
  `);

    await pool.query(`
    create table if not exists milestone_failure_distribution_claims (
      distribution_id text not null,
      wallet_pubkey text not null,
      claimed_at_unix bigint not null,
      amount_lamports bigint not null,
      tx_sig text null,
      primary key (distribution_id, wallet_pubkey)
    );
    create index if not exists milestone_failure_distribution_claims_distribution_idx on milestone_failure_distribution_claims(distribution_id);
  `);

    await pool.query(`
    create table if not exists reward_milestone_payout_claims (
      commitment_id text not null,
      milestone_id text not null,
      created_at_unix bigint not null,
      to_pubkey text not null,
      amount_lamports bigint not null,
      tx_sig text null,
      primary key (commitment_id, milestone_id)
    );
    create index if not exists reward_milestone_payout_claims_commitment_idx on reward_milestone_payout_claims(commitment_id);
  `);

    await pool.query(`
    create table if not exists vote_reward_distributions (
      id text primary key,
      commitment_id text not null,
      milestone_id text not null,
      created_at_unix bigint not null,
      mint_pubkey text not null,
      token_program_pubkey text not null,
      pool_amount_raw bigint not null,
      faucet_owner_pubkey text not null,
      status text not null,
      unique (commitment_id, milestone_id)
    );
    create index if not exists vote_reward_distributions_commitment_idx on vote_reward_distributions(commitment_id);
    create index if not exists vote_reward_distributions_commitment_milestone_idx on vote_reward_distributions(commitment_id, milestone_id);
  `);

    await pool.query(`
    create table if not exists vote_reward_distribution_allocations (
      distribution_id text not null,
      wallet_pubkey text not null,
      amount_raw bigint not null,
      weight double precision not null,
      primary key (distribution_id, wallet_pubkey)
    );
    create index if not exists vote_reward_distribution_allocations_distribution_idx on vote_reward_distribution_allocations(distribution_id);
  `);

    await pool.query(`
    create table if not exists vote_reward_distribution_claims (
      distribution_id text not null,
      wallet_pubkey text not null,
      claimed_at_unix bigint not null,
      amount_raw bigint not null,
      tx_sig text null,
      primary key (distribution_id, wallet_pubkey)
    );
    create index if not exists vote_reward_distribution_claims_distribution_idx on vote_reward_distribution_claims(distribution_id);
  `);

    try {
      await pool.query("alter table failure_distribution_claims alter column tx_sig drop not null");
    } catch {}
  })().catch((e) => {
    ensuredSchema = null;
    throw e;
  });

  return ensuredSchema;
}

function parseMilestonesJson(raw: any): RewardMilestone[] | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (!t.length) return undefined;
  try {
    const parsed = JSON.parse(t);
    if (!Array.isArray(parsed)) return undefined;
    return parsed as RewardMilestone[];
  } catch {
    return undefined;
  }
}

function rowToRecord(row: any): CommitmentRecord {
  return {
    id: row.id,
    statement: row.statement ?? undefined,
    authority: row.authority,
    destinationOnFail: row.destination_on_fail,
    amountLamports: Number(row.amount_lamports),
    deadlineUnix: Number(row.deadline_unix),
    escrowPubkey: row.escrow_pubkey,
    escrowSecretKey: row.escrow_secret_key,
    kind: (row.kind ?? "personal") as CommitmentKind,
    creatorPubkey: row.creator_pubkey ?? undefined,
    creatorFeeMode: row.creator_fee_mode == null ? undefined : (String(row.creator_fee_mode) as CreatorFeeMode),
    tokenMint: row.token_mint ?? undefined,
    totalFundedLamports: Number(row.total_funded_lamports ?? 0),
    unlockedLamports: Number(row.unlocked_lamports ?? 0),
    milestones: parseMilestonesJson(row.milestones_json),
    status: row.status,
    createdAtUnix: Number(row.created_at_unix),
    resolvedAtUnix: row.resolved_at_unix == null ? undefined : Number(row.resolved_at_unix),
    resolvedTxSig: row.resolved_tx_sig ?? undefined,
  };
}

export function createCommitmentRecord(input: {
  id: string;
  statement?: string;
  authority: string;
  destinationOnFail: string;
  amountLamports: number;
  deadlineUnix: number;
  escrowPubkey: string;
  escrowSecretKeyB58: string;
}): CommitmentRecord {
  return {
    id: input.id,
    statement: input.statement,
    authority: input.authority,
    destinationOnFail: input.destinationOnFail,
    amountLamports: input.amountLamports,
    deadlineUnix: input.deadlineUnix,
    escrowPubkey: input.escrowPubkey,
    escrowSecretKey: encryptSecret(input.escrowSecretKeyB58),
    kind: "personal",
    creatorPubkey: undefined,
    totalFundedLamports: 0,
    unlockedLamports: 0,
    milestones: undefined,
    status: "created",
    createdAtUnix: nowUnix(),
  };
}

export function createRewardCommitmentRecord(input: {
  id: string;
  statement?: string;
  creatorPubkey: string;
  escrowPubkey: string;
  escrowSecretKeyB58: string;
  milestones: Array<{ id: string; title: string; unlockLamports?: number; unlockPercent?: number; dueAtUnix?: number }>;
  tokenMint?: string;
  creatorFeeMode?: CreatorFeeMode;
}): CommitmentRecord {
  return {
    id: input.id,
    statement: input.statement,
    authority: input.creatorPubkey,
    destinationOnFail: input.escrowPubkey,
    amountLamports: 0,
    deadlineUnix: nowUnix(),
    escrowPubkey: input.escrowPubkey,
    escrowSecretKey: encryptSecret(input.escrowSecretKeyB58),
    kind: "creator_reward",
    creatorPubkey: input.creatorPubkey,
    creatorFeeMode: input.creatorFeeMode ?? "assisted",
    tokenMint: input.tokenMint,
    totalFundedLamports: 0,
    unlockedLamports: 0,
    milestones: input.milestones.map((m) => ({
      id: m.id,
      title: m.title,
      unlockLamports: m.unlockLamports ?? 0,
      unlockPercent: m.unlockPercent,
      dueAtUnix: m.dueAtUnix,
      status: "locked" as const,
    })),
    status: "active",
    createdAtUnix: nowUnix(),
  };
}

export function publicView(r: CommitmentRecord): Omit<CommitmentRecord, "escrowSecretKey"> {
  const { escrowSecretKey: _ignored, ...rest } = r;
  if (r.kind === "creator_reward") {
    return {
      ...rest,
      destinationOnFail: r.escrowPubkey,
    };
  }
  return rest;
}

export function getEscrowSecretKeyB58(r: CommitmentRecord): string {
  const raw = decryptSecret(r.escrowSecretKey);
  if (raw.startsWith("privy:")) {
    throw new Error("Escrow key is managed by Privy");
  }
  return raw;
}

export type EscrowSignerRef =
  | { kind: "local"; escrowSecretKeyB58: string }
  | { kind: "privy"; walletId: string };

export function getEscrowSignerRef(r: CommitmentRecord): EscrowSignerRef {
  const raw = decryptSecret(r.escrowSecretKey);
  const trimmed = String(raw ?? "").trim();

  if (trimmed.startsWith("privy:")) {
    const walletId = trimmed.slice("privy:".length).trim();
    if (!walletId) throw new Error("Invalid Privy escrow reference");
    return { kind: "privy", walletId };
  }

  validateEscrowSecretKeyB58(trimmed);
  return { kind: "local", escrowSecretKeyB58: trimmed };
}

export async function insertCommitment(r: CommitmentRecord): Promise<void> {
  await ensureSchema();

  if (!hasDatabase()) {
    mem.commitments.set(r.id, r);
    return;
  }

  const pool = getPool();
  await pool.query(
    `insert into commitments (
      id, statement, authority, destination_on_fail, amount_lamports, deadline_unix,
      escrow_pubkey, escrow_secret_key,
      kind, creator_pubkey, creator_fee_mode, token_mint, total_funded_lamports, unlocked_lamports, milestones_json,
      status, created_at_unix, resolved_at_unix, resolved_tx_sig
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      r.id,
      r.statement ?? null,
      r.authority,
      r.destinationOnFail,
      String(r.amountLamports),
      String(r.deadlineUnix),
      r.escrowPubkey,
      r.escrowSecretKey,
      r.kind,
      r.creatorPubkey ?? null,
      r.creatorFeeMode ?? null,
      r.tokenMint ?? null,
      String(r.totalFundedLamports ?? 0),
      String(r.unlockedLamports ?? 0),
      r.milestones ? JSON.stringify(r.milestones) : null,
      r.status,
      String(r.createdAtUnix),
      r.resolvedAtUnix == null ? null : String(r.resolvedAtUnix),
      r.resolvedTxSig ?? null,
    ]
  );
}

export function sumReleasedLamports(milestones: RewardMilestone[] | undefined): number {
  if (!milestones || milestones.length === 0) return 0;
  return milestones.reduce((acc, m) => (m.status === "released" ? acc + Number(m.unlockLamports || 0) : acc), 0);
}

function rewardMilestonePayoutKey(input: { commitmentId: string; milestoneId: string }): string {
  return `${input.commitmentId}:${input.milestoneId}`;
}

export async function tryAcquireRewardMilestonePayoutClaim(input: {
  commitmentId: string;
  milestoneId: string;
  createdAtUnix: number;
  toPubkey: string;
  amountLamports: number;
}): Promise<{ acquired: true } | { acquired: false; existing: RewardMilestonePayoutClaim }> {
  await ensureSchema();
  ensureMockSeeded();

  const rec: RewardMilestonePayoutClaim = {
    commitmentId: input.commitmentId,
    milestoneId: input.milestoneId,
    createdAtUnix: Math.floor(input.createdAtUnix),
    toPubkey: String(input.toPubkey),
    amountLamports: Math.floor(input.amountLamports),
    txSig: null,
  };

  if (!hasDatabase()) {
    const k = rewardMilestonePayoutKey(input);
    const existing = mem.rewardMilestonePayoutClaims.get(k);
    if (existing) return { acquired: false, existing };
    mem.rewardMilestonePayoutClaims.set(k, rec);
    return { acquired: true };
  }

  const pool = getPool();
  const res = await pool.query(
    `insert into reward_milestone_payout_claims (commitment_id, milestone_id, created_at_unix, to_pubkey, amount_lamports, tx_sig)
     values ($1,$2,$3,$4,$5,null)
     on conflict (commitment_id, milestone_id) do nothing
     returning commitment_id`,
    [rec.commitmentId, rec.milestoneId, String(rec.createdAtUnix), rec.toPubkey, String(rec.amountLamports)]
  );

  if (res.rows[0]) return { acquired: true };

  const existingRes = await pool.query(
    "select commitment_id, milestone_id, created_at_unix, to_pubkey, amount_lamports, tx_sig from reward_milestone_payout_claims where commitment_id=$1 and milestone_id=$2",
    [rec.commitmentId, rec.milestoneId]
  );
  const row = existingRes.rows[0];
  const existing: RewardMilestonePayoutClaim = {
    commitmentId: rec.commitmentId,
    milestoneId: rec.milestoneId,
    createdAtUnix: row ? Number(row.created_at_unix) : rec.createdAtUnix,
    toPubkey: row ? String(row.to_pubkey) : rec.toPubkey,
    amountLamports: row ? Number(row.amount_lamports) : rec.amountLamports,
    txSig: row ? (row.tx_sig ?? null) : null,
  };
  return { acquired: false, existing };
}

export async function setRewardMilestonePayoutClaimTxSig(input: {
  commitmentId: string;
  milestoneId: string;
  txSig: string;
}): Promise<void> {
  await ensureSchema();
  ensureMockSeeded();

  if (!hasDatabase()) {
    const k = rewardMilestonePayoutKey(input);
    const existing = mem.rewardMilestonePayoutClaims.get(k);
    if (existing) mem.rewardMilestonePayoutClaims.set(k, { ...existing, txSig: input.txSig });
    return;
  }

  const pool = getPool();
  await pool.query(
    "update reward_milestone_payout_claims set tx_sig=$3 where commitment_id=$1 and milestone_id=$2 and tx_sig is null",
    [input.commitmentId, input.milestoneId, input.txSig]
  );
}

export async function getRewardMilestonePayoutClaim(input: {
  commitmentId: string;
  milestoneId: string;
}): Promise<RewardMilestonePayoutClaim | null> {
  await ensureSchema();
  ensureMockSeeded();

  const commitmentId = String(input.commitmentId);
  const milestoneId = String(input.milestoneId);

  if (!hasDatabase()) {
    const k = rewardMilestonePayoutKey({ commitmentId, milestoneId });
    return mem.rewardMilestonePayoutClaims.get(k) ?? null;
  }

  const pool = getPool();
  const res = await pool.query(
    "select commitment_id, milestone_id, created_at_unix, to_pubkey, amount_lamports, tx_sig from reward_milestone_payout_claims where commitment_id=$1 and milestone_id=$2",
    [commitmentId, milestoneId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    commitmentId,
    milestoneId,
    createdAtUnix: Number(row.created_at_unix),
    toPubkey: String(row.to_pubkey),
    amountLamports: Number(row.amount_lamports),
    txSig: row.tx_sig ?? null,
  };
}

export async function deleteRewardMilestonePayoutClaim(input: {
  commitmentId: string;
  milestoneId: string;
}): Promise<void> {
  await ensureSchema();
  ensureMockSeeded();

  const commitmentId = String(input.commitmentId);
  const milestoneId = String(input.milestoneId);

  if (!hasDatabase()) {
    const k = rewardMilestonePayoutKey({ commitmentId, milestoneId });
    mem.rewardMilestonePayoutClaims.delete(k);
    return;
  }

  const pool = getPool();
  await pool.query(
    "delete from reward_milestone_payout_claims where commitment_id=$1 and milestone_id=$2",
    [commitmentId, milestoneId]
  );
}

export async function upsertRewardMilestoneSignal(input: {
  commitmentId: string;
  milestoneId: string;
  signerPubkey: string;
  vote?: RewardMilestoneVote;
  createdAtUnix: number;
  projectPriceUsd: number;
  projectValueUsd: number;
  /** Raw project-token balance at vote time (all token accounts). */
  voteAmountRaw?: string | null;
  tokenDecimals?: number | null;
  /** Minimum raw balance the wallet must still hold when the vote window closes (≈ $20 at the vote-time price). */
  minAmountRaw?: string | null;
}): Promise<{ inserted: boolean }> {
  await ensureSchema();

  ensureMockSeeded();

  if (!hasDatabase()) {
    let byMilestone = mem.rewardSignals.get(input.commitmentId);
    if (!byMilestone) {
      byMilestone = new Map();
      mem.rewardSignals.set(input.commitmentId, byMilestone);
    }
    let bySigner = byMilestone.get(input.milestoneId);
    if (!bySigner) {
      bySigner = new Map();
      byMilestone.set(input.milestoneId, bySigner);
    }
    const before = bySigner.size;
    if (!bySigner.has(input.signerPubkey)) {
      const weight = Number(input.projectValueUsd);
      const minUsd = 20;
      bySigner.set(input.signerPubkey, {
        createdAtUnix: Math.floor(input.createdAtUnix),
        weightUsd: Number.isFinite(weight) && weight > 0 ? weight : minUsd,
        vote: input.vote === "reject" ? "reject" : "approve",
      });
    }
    return { inserted: bySigner.size !== before };
  }

  const pool = getPool();
  const res = await pool.query(
    `insert into reward_milestone_signals (
       commitment_id, milestone_id, signer_pubkey, vote, created_at_unix, project_price_usd, project_value_usd,
       vote_amount_raw, token_decimals, min_amount_raw
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (commitment_id, milestone_id, signer_pubkey) do nothing
     returning commitment_id`,
    [
      input.commitmentId,
      input.milestoneId,
      input.signerPubkey,
      input.vote === "reject" ? "reject" : "approve",
      String(input.createdAtUnix),
      Number(input.projectPriceUsd ?? 0),
      Number(input.projectValueUsd ?? 0),
      input.voteAmountRaw == null ? null : String(input.voteAmountRaw),
      input.tokenDecimals == null || !Number.isFinite(Number(input.tokenDecimals)) ? null : Math.floor(Number(input.tokenDecimals)),
      input.minAmountRaw == null ? null : String(input.minAmountRaw),
    ]
  );
  return { inserted: Boolean(res.rows[0]) };
}

export async function upsertRewardVoterSnapshot(input: RewardVoterSnapshot): Promise<{ inserted: boolean }> {
  await ensureSchema();

  ensureMockSeeded();

  if (!hasDatabase()) {
    let byMilestone = mem.rewardVoterSnapshots.get(input.commitmentId);
    if (!byMilestone) {
      byMilestone = new Map();
      mem.rewardVoterSnapshots.set(input.commitmentId, byMilestone);
    }
    let bySigner = byMilestone.get(input.milestoneId);
    if (!bySigner) {
      bySigner = new Map();
      byMilestone.set(input.milestoneId, bySigner);
    }
    const before = bySigner.size;
    if (!bySigner.has(input.signerPubkey)) {
      bySigner.set(input.signerPubkey, input);
    }
    return { inserted: bySigner.size !== before };
  }

  const pool = getPool();
  const res = await pool.query(
    `insert into reward_voter_snapshots (
      commitment_id, milestone_id, signer_pubkey, created_at_unix,
      project_mint, project_ui_amount, project_price_usd, project_value_usd, ship_ui_amount, ship_multiplier_bps
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    on conflict (commitment_id, milestone_id, signer_pubkey) do nothing
    returning commitment_id`,
    [
      input.commitmentId,
      input.milestoneId,
      input.signerPubkey,
      String(input.createdAtUnix),
      input.projectMint,
      input.projectUiAmount,
      Number(input.projectPriceUsd ?? 0),
      Number(input.projectValueUsd ?? 0),
      input.shipUiAmount,
      Math.floor(input.shipMultiplierBps),
    ]
  );
  return { inserted: Boolean(res.rows[0]) };
}

export async function listRewardVoterSnapshots(commitmentId: string): Promise<RewardVoterSnapshot[]> {
  await ensureSchema();
  ensureMockSeeded();

  if (!hasDatabase()) {
    const out: RewardVoterSnapshot[] = [];
    const byMilestone = mem.rewardVoterSnapshots.get(commitmentId);
    if (!byMilestone) return out;
    for (const bySigner of byMilestone.values()) {
      for (const v of bySigner.values()) out.push(v);
    }
    return out;
  }

  const pool = getPool();
  const res = await pool.query(
    `select commitment_id, milestone_id, signer_pubkey, created_at_unix, project_mint, project_ui_amount, project_price_usd, project_value_usd, ship_ui_amount, ship_multiplier_bps
     from reward_voter_snapshots where commitment_id=$1`,
    [commitmentId]
  );

  return res.rows.map((r) => ({
    commitmentId: String(r.commitment_id),
    milestoneId: String(r.milestone_id),
    signerPubkey: String(r.signer_pubkey),
    createdAtUnix: Number(r.created_at_unix),
    projectMint: String(r.project_mint),
    projectUiAmount: Number(r.project_ui_amount),
    projectPriceUsd: r.project_price_usd == null ? undefined : Number(r.project_price_usd),
    projectValueUsd: r.project_value_usd == null ? undefined : Number(r.project_value_usd),
    shipUiAmount: Number(r.ship_ui_amount),
    shipMultiplierBps: Number(r.ship_multiplier_bps),
  }));
}

 export async function listRewardVoterSnapshotsByMilestone(input: {
  commitmentId: string;
  milestoneId: string;
 }): Promise<RewardVoterSnapshot[]> {
  await ensureSchema();
  ensureMockSeeded();

  const commitmentId = String(input.commitmentId);
  const milestoneId = String(input.milestoneId);

  if (!hasDatabase()) {
    const out: RewardVoterSnapshot[] = [];
    const byMilestone = mem.rewardVoterSnapshots.get(commitmentId);
    const bySigner = byMilestone?.get(milestoneId);
    if (!bySigner) return out;
    for (const v of bySigner.values()) out.push(v);
    return out;
  }

  const pool = getPool();
  const res = await pool.query(
    `select commitment_id, milestone_id, signer_pubkey, created_at_unix, project_mint, project_ui_amount, project_price_usd, project_value_usd, ship_ui_amount, ship_multiplier_bps
     from reward_voter_snapshots where commitment_id=$1 and milestone_id=$2`,
    [commitmentId, milestoneId]
  );

  return res.rows.map((r) => ({
    commitmentId: String(r.commitment_id),
    milestoneId: String(r.milestone_id),
    signerPubkey: String(r.signer_pubkey),
    createdAtUnix: Number(r.created_at_unix),
    projectMint: String(r.project_mint),
    projectUiAmount: Number(r.project_ui_amount),
    projectPriceUsd: r.project_price_usd == null ? undefined : Number(r.project_price_usd),
    projectValueUsd: r.project_value_usd == null ? undefined : Number(r.project_value_usd),
    shipUiAmount: Number(r.ship_ui_amount),
    shipMultiplierBps: Number(r.ship_multiplier_bps),
  }));
 }

export async function getRewardMilestoneSignalFirstSeenUnixBySigner(input: {
  commitmentId: string;
  signerPubkeys: string[];
}): Promise<Map<string, number>> {
  await ensureSchema();
  ensureMockSeeded();

  const commitmentId = String(input.commitmentId);
  const signerPubkeys = Array.isArray(input.signerPubkeys) ? input.signerPubkeys.map((s) => String(s)).filter(Boolean) : [];
  const out = new Map<string, number>();

  if (!commitmentId || signerPubkeys.length === 0) return out;

  if (!hasDatabase()) {
    const signerSet = new Set(signerPubkeys);
    const byMilestone = mem.rewardSignals.get(commitmentId);
    if (!byMilestone) return out;
    for (const bySigner of byMilestone.values()) {
      for (const [signer, v] of bySigner.entries()) {
        if (!signerSet.has(signer)) continue;
        const createdAtUnix = Number((v as any)?.createdAtUnix ?? 0);
        if (!Number.isFinite(createdAtUnix) || createdAtUnix <= 0) continue;
        const prev = out.get(signer);
        if (prev == null || createdAtUnix < prev) out.set(signer, createdAtUnix);
      }
    }
    return out;
  }

  const pool = getPool();
  const res = await pool.query(
    "select signer_pubkey, min(created_at_unix) as first_seen from reward_milestone_signals where commitment_id=$1 and signer_pubkey = any($2) group by signer_pubkey",
    [commitmentId, signerPubkeys]
  );
  for (const row of res.rows ?? []) {
    const signer = String(row.signer_pubkey ?? "").trim();
    const firstSeen = Number(row.first_seen ?? 0);
    if (!signer) continue;
    if (!Number.isFinite(firstSeen) || firstSeen <= 0) continue;
    out.set(signer, firstSeen);
  }
  return out;
}

export async function countRewardMilestoneSignalsBySigner(input: {
  commitmentId: string;
  milestoneIds: string[];
  signerPubkeys: string[];
}): Promise<Map<string, number>> {
  await ensureSchema();
  ensureMockSeeded();

  const commitmentId = String(input.commitmentId);
  const milestoneIds = Array.isArray(input.milestoneIds) ? input.milestoneIds.map((s) => String(s)).filter(Boolean) : [];
  const signerPubkeys = Array.isArray(input.signerPubkeys) ? input.signerPubkeys.map((s) => String(s)).filter(Boolean) : [];
  const out = new Map<string, number>();

  if (!commitmentId || milestoneIds.length === 0 || signerPubkeys.length === 0) return out;

  if (!hasDatabase()) {
    const signerSet = new Set(signerPubkeys);
    const byMilestone = mem.rewardSignals.get(commitmentId);
    if (!byMilestone) return out;
    for (const milestoneId of milestoneIds) {
      const bySigner = byMilestone.get(milestoneId);
      if (!bySigner) continue;
      for (const signer of bySigner.keys()) {
        if (!signerSet.has(signer)) continue;
        out.set(signer, Number(out.get(signer) ?? 0) + 1);
      }
    }
    return out;
  }

  const pool = getPool();
  const res = await pool.query(
    "select signer_pubkey, count(*)::bigint as cnt from reward_milestone_signals where commitment_id=$1 and milestone_id = any($2) and signer_pubkey = any($3) group by signer_pubkey",
    [commitmentId, milestoneIds, signerPubkeys]
  );
  for (const row of res.rows ?? []) {
    const signer = String(row.signer_pubkey ?? "").trim();
    const cnt = Number(row.cnt ?? 0);
    if (!signer) continue;
    if (!Number.isFinite(cnt) || cnt <= 0) continue;
    out.set(signer, Math.floor(cnt));
  }
  return out;
}

 function milestoneFailureKey(input: { commitmentId: string; milestoneId: string }): string {
  return `${input.commitmentId}:${input.milestoneId}`;
}

function voteRewardKey(input: { commitmentId: string; milestoneId: string }): string {
  return `${input.commitmentId}:${input.milestoneId}`;
}

export async function getMilestoneFailureDistribution(input: {
  commitmentId: string;
  milestoneId: string;
}): Promise<MilestoneFailureDistributionRecord | null> {
  await ensureSchema();
  ensureMockSeeded();

  const commitmentId = String(input.commitmentId);
  const milestoneId = String(input.milestoneId);

  if (!hasDatabase()) {
    return mem.milestoneFailureDistributionsByCommitmentMilestone.get(milestoneFailureKey({ commitmentId, milestoneId })) ?? null;
  }

  const pool = getPool();
  const res = await pool.query(
    "select * from milestone_failure_distributions where commitment_id=$1 and milestone_id=$2",
    [commitmentId, milestoneId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    commitmentId: String(row.commitment_id),
    milestoneId: String(row.milestone_id),
    createdAtUnix: Number(row.created_at_unix),
    forfeitedLamports: Number(row.forfeited_lamports),
    buybackLamports: Number(row.buyback_lamports),
    voteRewardLamports: Number(row.vote_reward_lamports ?? 0),
    voterPotLamports: Number(row.voter_pot_lamports),
    shipBuybackTreasuryPubkey: String(row.ship_buyback_treasury_pubkey),
    voteRewardTreasuryPubkey: row.vote_reward_treasury_pubkey == null ? undefined : String(row.vote_reward_treasury_pubkey),
    // In-flight step reservations ("sending:...") are internal; readers see them as not-yet-sent.
    buybackTxSig: isFailureDistributionStepMarker(row.buyback_tx_sig) ? "pending" : String(row.buyback_tx_sig),
    voteRewardTxSig: row.vote_reward_tx_sig == null || isFailureDistributionStepMarker(row.vote_reward_tx_sig) ? undefined : String(row.vote_reward_tx_sig),
    voterPotTxSig: row.voter_pot_tx_sig == null || isFailureDistributionStepMarker(row.voter_pot_tx_sig) ? undefined : String(row.voter_pot_tx_sig),
    status: String(row.status) as MilestoneFailureDistributionStatus,
  };
}

export async function listMilestoneFailureDistributionsByCommitmentId(commitmentId: string): Promise<MilestoneFailureDistributionRecord[]> {
  await ensureSchema();
  ensureMockSeeded();

  const id = String(commitmentId);
  if (!id) return [];

  if (!hasDatabase()) {
    return Array.from(mem.milestoneFailureDistributionsByCommitmentMilestone.values()).filter((d) => d.commitmentId === id);
  }

  const pool = getPool();
  const res = await pool.query(
    `select id, commitment_id, milestone_id, created_at_unix, forfeited_lamports, buyback_lamports, voter_pot_lamports,
            ship_buyback_treasury_pubkey, vote_reward_lamports, vote_reward_treasury_pubkey, buyback_tx_sig, vote_reward_tx_sig, voter_pot_tx_sig, status
     from milestone_failure_distributions where commitment_id=$1`,
    [id]
  );

  return (res.rows ?? []).map((row: any) => ({
    id: String(row.id),
    commitmentId: String(row.commitment_id),
    milestoneId: String(row.milestone_id),
    createdAtUnix: Number(row.created_at_unix),
    forfeitedLamports: Number(row.forfeited_lamports),
    buybackLamports: Number(row.buyback_lamports),
    voteRewardLamports: Number(row.vote_reward_lamports ?? 0),
    voterPotLamports: Number(row.voter_pot_lamports),
    shipBuybackTreasuryPubkey: String(row.ship_buyback_treasury_pubkey),
    voteRewardTreasuryPubkey: row.vote_reward_treasury_pubkey == null ? undefined : String(row.vote_reward_treasury_pubkey),
    // In-flight step reservations ("sending:...") are internal; readers see them as not-yet-sent.
    buybackTxSig: isFailureDistributionStepMarker(row.buyback_tx_sig) ? "pending" : String(row.buyback_tx_sig),
    voteRewardTxSig: row.vote_reward_tx_sig == null || isFailureDistributionStepMarker(row.vote_reward_tx_sig) ? undefined : String(row.vote_reward_tx_sig),
    voterPotTxSig: row.voter_pot_tx_sig == null || isFailureDistributionStepMarker(row.voter_pot_tx_sig) ? undefined : String(row.voter_pot_tx_sig),
    status: String(row.status) as MilestoneFailureDistributionStatus,
  }));
}

export async function listMilestoneFailureDistributionClaims(input: { distributionId: string }): Promise<MilestoneFailureDistributionClaim[]> {
  await ensureSchema();
  ensureMockSeeded();

  const distributionId = String(input.distributionId);
  if (!distributionId) return [];

  if (!hasDatabase()) {
    const byWallet = mem.milestoneFailureClaimsByDistributionId.get(distributionId);
    return byWallet ? Array.from(byWallet.values()) : [];
  }

  const pool = getPool();
  const res = await pool.query(
    "select distribution_id, wallet_pubkey, claimed_at_unix, amount_lamports, tx_sig from milestone_failure_distribution_claims where distribution_id=$1",
    [distributionId]
  );

  return (res.rows ?? []).map((row: any) => {
    const txSigRaw = String(row.tx_sig ?? "");
    const txSig = txSigRaw.trim().length ? txSigRaw.trim() : null;
    return {
      distributionId: String(row.distribution_id),
      walletPubkey: String(row.wallet_pubkey),
      claimedAtUnix: Number(row.claimed_at_unix),
      amountLamports: Number(row.amount_lamports),
      txSig,
    } as MilestoneFailureDistributionClaim;
  });
}

export async function tryAcquireMilestoneFailureDistributionCreate(input: {
  distribution: MilestoneFailureDistributionRecord;
}): Promise<{ acquired: true } | { acquired: false; existing: MilestoneFailureDistributionRecord }> {
  await ensureSchema();
  ensureMockSeeded();

  const commitmentId = String(input.distribution.commitmentId);
  const milestoneId = String(input.distribution.milestoneId);

  if (!hasDatabase()) {
    const k = milestoneFailureKey({ commitmentId, milestoneId });
    const existing = mem.milestoneFailureDistributionsByCommitmentMilestone.get(k);
    if (existing) return { acquired: false, existing };
    mem.milestoneFailureDistributionsByCommitmentMilestone.set(k, input.distribution);
    return { acquired: true };
  }

  const pool = getPool();
  const res = await pool.query(
    `insert into milestone_failure_distributions (
      id, commitment_id, milestone_id, created_at_unix, forfeited_lamports, buyback_lamports, vote_reward_lamports, voter_pot_lamports,
      ship_buyback_treasury_pubkey, vote_reward_treasury_pubkey, buyback_tx_sig, vote_reward_tx_sig, voter_pot_tx_sig, status
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    on conflict (commitment_id, milestone_id) do nothing
    returning id`,
    [
      input.distribution.id,
      commitmentId,
      milestoneId,
      String(input.distribution.createdAtUnix),
      String(input.distribution.forfeitedLamports),
      String(input.distribution.buybackLamports),
      String(input.distribution.voteRewardLamports),
      String(input.distribution.voterPotLamports),
      input.distribution.shipBuybackTreasuryPubkey,
      input.distribution.voteRewardTreasuryPubkey ?? null,
      input.distribution.buybackTxSig,
      input.distribution.voteRewardTxSig ?? null,
      input.distribution.voterPotTxSig ?? null,
      input.distribution.status,
    ]
  );
  if (res.rows[0]) return { acquired: true };

  const existing = await getMilestoneFailureDistribution({ commitmentId, milestoneId });
  if (!existing) throw new Error("Failed to acquire milestone failure distribution");
  return { acquired: false, existing };
 }

 export async function insertMilestoneFailureDistributionAllocations(input: {
  distributionId: string;
  allocations: MilestoneFailureDistributionAllocation[];
 }): Promise<void> {
  await ensureSchema();
  ensureMockSeeded();

  if (!hasDatabase()) {
    const byWallet = new Map<string, MilestoneFailureDistributionAllocation>();
    for (const a of input.allocations) byWallet.set(a.walletPubkey, a);
    mem.milestoneFailureAllocationsByDistributionId.set(input.distributionId, byWallet);
    return;
  }

  const pool = getPool();
  for (const a of input.allocations) {
    await pool.query(
      `insert into milestone_failure_distribution_allocations (distribution_id, wallet_pubkey, amount_lamports, weight)
       values ($1,$2,$3,$4)
       on conflict (distribution_id, wallet_pubkey) do nothing`,
      [a.distributionId, a.walletPubkey, String(a.amountLamports), a.weight]
    );
  }
 }

 export async function setMilestoneFailureDistributionTxSigs(input: {
  distributionId: string;
  buybackTxSig?: string | null;
  voteRewardTxSig?: string | null;
  voterPotTxSig?: string | null;
 }): Promise<void> {
  await ensureSchema();
  ensureMockSeeded();

  const distributionId = String(input.distributionId);
  if (!distributionId) return;

  if (!hasDatabase()) {
    for (const [k, d] of mem.milestoneFailureDistributionsByCommitmentMilestone.entries()) {
      if (d.id !== distributionId) continue;
      mem.milestoneFailureDistributionsByCommitmentMilestone.set(k, {
        ...d,
        buybackTxSig: input.buybackTxSig ?? d.buybackTxSig,
        voteRewardTxSig: input.voteRewardTxSig ?? d.voteRewardTxSig,
        voterPotTxSig: input.voterPotTxSig ?? d.voterPotTxSig,
      });
      break;
    }
    return;
  }

  const pool = getPool();

  if (input.buybackTxSig != null) {
    await pool.query(
      "update milestone_failure_distributions set buyback_tx_sig=$2 where id=$1 and (buyback_tx_sig is null or buyback_tx_sig='' or buyback_tx_sig='pending')",
      [distributionId, String(input.buybackTxSig)]
    );
  }

  if (input.voteRewardTxSig != null) {
    await pool.query(
      "update milestone_failure_distributions set vote_reward_tx_sig=$2 where id=$1 and (vote_reward_tx_sig is null or vote_reward_tx_sig='')",
      [distributionId, String(input.voteRewardTxSig)]
    );
  }

  if (input.voterPotTxSig != null) {
    await pool.query(
      "update milestone_failure_distributions set voter_pot_tx_sig=$2 where id=$1 and (voter_pot_tx_sig is null or voter_pot_tx_sig='')",
      [distributionId, String(input.voterPotTxSig)]
    );
  }
 }

 export async function createMilestoneFailureDistribution(input: {
  distribution: MilestoneFailureDistributionRecord;
  allocations: MilestoneFailureDistributionAllocation[];
 }): Promise<void> {
  await ensureSchema();

  if (!hasDatabase()) {
    mem.milestoneFailureDistributionsByCommitmentMilestone.set(
      milestoneFailureKey({ commitmentId: input.distribution.commitmentId, milestoneId: input.distribution.milestoneId }),
      input.distribution
    );
    const byWallet = new Map<string, MilestoneFailureDistributionAllocation>();
    for (const a of input.allocations) byWallet.set(a.walletPubkey, a);
    mem.milestoneFailureAllocationsByDistributionId.set(input.distribution.id, byWallet);
    return;
  }

  const pool = getPool();
  await pool.query(
    `insert into milestone_failure_distributions (
      id, commitment_id, milestone_id, created_at_unix, forfeited_lamports, buyback_lamports, vote_reward_lamports, voter_pot_lamports,
      ship_buyback_treasury_pubkey, vote_reward_treasury_pubkey, buyback_tx_sig, vote_reward_tx_sig, voter_pot_tx_sig, status
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      input.distribution.id,
      input.distribution.commitmentId,
      input.distribution.milestoneId,
      String(input.distribution.createdAtUnix),
      String(input.distribution.forfeitedLamports),
      String(input.distribution.buybackLamports),
      String(input.distribution.voteRewardLamports),
      String(input.distribution.voterPotLamports),
      input.distribution.shipBuybackTreasuryPubkey,
      input.distribution.voteRewardTreasuryPubkey ?? null,
      input.distribution.buybackTxSig,
      input.distribution.voteRewardTxSig ?? null,
      input.distribution.voterPotTxSig ?? null,
      input.distribution.status,
    ]
  );

  for (const a of input.allocations) {
    await pool.query(
      `insert into milestone_failure_distribution_allocations (distribution_id, wallet_pubkey, amount_lamports, weight)
       values ($1,$2,$3,$4)
       on conflict (distribution_id, wallet_pubkey) do nothing`,
      [a.distributionId, a.walletPubkey, String(a.amountLamports), a.weight]
    );
  }
 }

/**
 * Creates a milestone failure distribution and all of its voter allocations in one transaction, so allocations are
 * fixed at creation time and a concurrent/retried call can never add a second, different allocation set.
 * Exactly one concurrent caller gets `created: true`; the others get the stored record.
 */
export async function createMilestoneFailureDistributionWithAllocations(input: {
  distribution: MilestoneFailureDistributionRecord;
  allocations: MilestoneFailureDistributionAllocation[];
}): Promise<{ created: true } | { created: false; existing: MilestoneFailureDistributionRecord }> {
  await ensureSchema();
  ensureMockSeeded();

  const d = input.distribution;
  let sum = 0;
  for (const a of input.allocations) {
    if (a.distributionId !== d.id) throw new Error("Allocation distribution mismatch");
    if (!Number.isSafeInteger(a.amountLamports) || a.amountLamports <= 0) throw new Error("Allocation must be a positive integer");
    sum += a.amountLamports;
  }
  if (sum > d.voterPotLamports) throw new Error("Allocations exceed the voter pot");

  if (!hasDatabase()) {
    const k = milestoneFailureKey({ commitmentId: d.commitmentId, milestoneId: d.milestoneId });
    const existing = mem.milestoneFailureDistributionsByCommitmentMilestone.get(k);
    if (existing) return { created: false, existing };
    mem.milestoneFailureDistributionsByCommitmentMilestone.set(k, d);
    const byWallet = new Map<string, MilestoneFailureDistributionAllocation>();
    for (const a of input.allocations) byWallet.set(a.walletPubkey, a);
    mem.milestoneFailureAllocationsByDistributionId.set(d.id, byWallet);
    return { created: true };
  }

  const client = await getPool().connect();
  let done = false;
  let released = false;
  try {
    await client.query("begin");
    const ins = await client.query(
      `insert into milestone_failure_distributions (
        id, commitment_id, milestone_id, created_at_unix, forfeited_lamports, buyback_lamports, vote_reward_lamports, voter_pot_lamports,
        ship_buyback_treasury_pubkey, vote_reward_treasury_pubkey, buyback_tx_sig, vote_reward_tx_sig, voter_pot_tx_sig, status
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      on conflict (commitment_id, milestone_id) do nothing
      returning id`,
      [
        d.id,
        d.commitmentId,
        d.milestoneId,
        String(d.createdAtUnix),
        String(d.forfeitedLamports),
        String(d.buybackLamports),
        String(d.voteRewardLamports),
        String(d.voterPotLamports),
        d.shipBuybackTreasuryPubkey,
        d.voteRewardTreasuryPubkey ?? null,
        d.buybackTxSig,
        d.voteRewardTxSig ?? null,
        d.voterPotTxSig ?? null,
        d.status,
      ]
    );
    if (!ins.rows[0]) {
      await client.query("rollback");
      done = true;
      // Release before reading through the pool (see createVoteRewardDistributionWithAllocations).
      client.release();
      released = true;
      const existing = await getMilestoneFailureDistribution({ commitmentId: d.commitmentId, milestoneId: d.milestoneId });
      if (!existing) throw new Error("Failed to acquire milestone failure distribution");
      return { created: false, existing };
    }
    if (input.allocations.length) {
      await client.query(
        `insert into milestone_failure_distribution_allocations (distribution_id, wallet_pubkey, amount_lamports, weight)
         select $1, w, a::bigint, x from unnest($2::text[], $3::text[], $4::double precision[]) as t(w, a, x)`,
        [d.id, input.allocations.map((a) => a.walletPubkey), input.allocations.map((a) => String(a.amountLamports)), input.allocations.map((a) => Number(a.weight) || 0)]
      );
    }
    await client.query("commit");
    done = true;
    return { created: true };
  } catch (e) {
    if (!done) {
      try {
        await client.query("rollback");
      } catch {
        // ignore
      }
    }
    throw e;
  } finally {
    if (!released) client.release();
  }
}

export type MilestoneFailureDistributionStep = "buyback" | "vote_reward" | "voter_pot";

function failureStepColumn(step: MilestoneFailureDistributionStep): "buyback_tx_sig" | "vote_reward_tx_sig" | "voter_pot_tx_sig" {
  if (step === "buyback") return "buyback_tx_sig";
  if (step === "vote_reward") return "vote_reward_tx_sig";
  return "voter_pot_tx_sig";
}

function failureStepField(step: MilestoneFailureDistributionStep): "buybackTxSig" | "voteRewardTxSig" | "voterPotTxSig" {
  if (step === "buyback") return "buybackTxSig";
  if (step === "vote_reward") return "voteRewardTxSig";
  return "voterPotTxSig";
}

/**
 * Step reservation values stored in the <step>_tx_sig column while a transfer is in flight:
 *   sending:<unix>:<nonce>                      reserved, nothing signed/broadcast yet
 *   sending:<unix>:<nonce>:<signature>:<lvbh>   signed; signature persisted BEFORE the first broadcast (onPrepared)
 * Anything else that is not unset ('', 'pending', 'none', null) is the final transaction signature.
 */
export function isFailureDistributionStepMarker(v: string | null | undefined): boolean {
  return String(v ?? "").startsWith("sending:");
}

export function parseFailureDistributionStepMarker(
  v: string | null | undefined
): { base: string; reservedAtUnix: number; signature: string | null; lastValidBlockHeight: number | null } | null {
  const s = String(v ?? "");
  if (!s.startsWith("sending:")) return null;
  const parts = s.split(":");
  const reservedAtUnix = Number(parts[1]);
  const base = parts.slice(0, 3).join(":");
  const signature = parts[3] ? String(parts[3]) : null;
  const lvbh = parts[4] != null ? Number(parts[4]) : NaN;
  return {
    base,
    reservedAtUnix: Number.isFinite(reservedAtUnix) ? reservedAtUnix : 0,
    signature,
    lastValidBlockHeight: Number.isFinite(lvbh) && lvbh > 0 ? lvbh : null,
  };
}

function isUnsetFailureStepValue(v: string | null | undefined): boolean {
  const t = String(v ?? "").trim();
  return !t || t === "pending" || t === "none";
}

async function memUpdateFailureStep(
  distributionId: string,
  step: MilestoneFailureDistributionStep,
  fn: (cur: string | undefined) => string | undefined | false
): Promise<boolean> {
  for (const [k, d] of Array.from(mem.milestoneFailureDistributionsByCommitmentMilestone.entries())) {
    if (d.id !== distributionId) continue;
    const field = failureStepField(step);
    const next = fn((d as any)[field]);
    if (next === false) return false;
    mem.milestoneFailureDistributionsByCommitmentMilestone.set(k, { ...d, [field]: next } as any);
    return true;
  }
  return false;
}

/** Current raw value of one step column (null when the distribution does not exist). */
export async function getMilestoneFailureDistributionStepValue(input: {
  distributionId: string;
  step: MilestoneFailureDistributionStep;
}): Promise<string | null> {
  await ensureSchema();
  ensureMockSeeded();
  if (!hasDatabase()) {
    for (const d of Array.from(mem.milestoneFailureDistributionsByCommitmentMilestone.values())) {
      if (d.id === input.distributionId) return ((d as any)[failureStepField(input.step)] as string | undefined) ?? null;
    }
    return null;
  }
  const col = failureStepColumn(input.step);
  const res = await getPool().query(`select ${col} as v from milestone_failure_distributions where id=$1`, [input.distributionId]);
  const v = res.rows[0]?.v;
  return v == null ? null : String(v);
}

/**
 * Atomically reserves one transfer step of a milestone failure distribution with a conditional UPDATE:
 *   - normally only when the step is unset ('' / 'pending' / 'none' / null);
 *   - with `takeoverFrom`, only when the column still holds exactly that (stale or provably dead) reservation.
 * Only the caller that wins may send the transfer.
 */
export async function tryClaimMilestoneFailureDistributionStep(input: {
  distributionId: string;
  step: MilestoneFailureDistributionStep;
  nowUnix: number;
  takeoverFrom?: string | null;
}): Promise<{ claimed: true; marker: string } | { claimed: false }> {
  await ensureSchema();
  ensureMockSeeded();

  const marker = `sending:${Math.floor(input.nowUnix)}:${crypto.randomBytes(6).toString("hex")}`;
  const takeoverFrom = input.takeoverFrom == null ? null : String(input.takeoverFrom);
  if (takeoverFrom != null && !isFailureDistributionStepMarker(takeoverFrom)) throw new Error("takeoverFrom must be a step reservation");

  if (!hasDatabase()) {
    const ok = await memUpdateFailureStep(input.distributionId, input.step, (cur) => {
      if (takeoverFrom != null ? cur !== takeoverFrom : !isUnsetFailureStepValue(cur)) return false;
      return marker;
    });
    return ok ? { claimed: true, marker } : { claimed: false };
  }

  const col = failureStepColumn(input.step);
  const res =
    takeoverFrom != null
      ? await getPool().query(`update milestone_failure_distributions set ${col}=$2 where id=$1 and ${col}=$3 returning id`, [
          input.distributionId,
          marker,
          takeoverFrom,
        ])
      : await getPool().query(
          `update milestone_failure_distributions set ${col}=$2 where id=$1 and (${col} is null or ${col} in ('', 'pending', 'none')) returning id`,
          [input.distributionId, marker]
        );
  return res.rows[0] ? { claimed: true, marker } : { claimed: false };
}

/**
 * onPrepared hook target: records the signature (and its lastValidBlockHeight) of a reserved step BEFORE the
 * transaction is broadcast. Compare-and-set on our reservation; returns false if we no longer hold it (abort send).
 */
export async function prepareMilestoneFailureDistributionStep(input: {
  distributionId: string;
  step: MilestoneFailureDistributionStep;
  marker: string;
  signature: string;
  lastValidBlockHeight: number;
}): Promise<boolean> {
  await ensureSchema();
  ensureMockSeeded();
  const next = `${input.marker}:${input.signature}:${Math.floor(Number(input.lastValidBlockHeight) || 0)}`;

  if (!hasDatabase()) {
    return memUpdateFailureStep(input.distributionId, input.step, (cur) =>
      cur === input.marker || String(cur ?? "").startsWith(`${input.marker}:`) ? next : false
    );
  }
  const col = failureStepColumn(input.step);
  const res = await getPool().query(
    `update milestone_failure_distributions set ${col}=$3 where id=$1 and (${col}=$2 or left(${col}, length($2) + 1) = $2 || ':') returning id`,
    [input.distributionId, input.marker, next]
  );
  return Boolean(res.rows[0]);
}

/** Records the final signature of a reserved step - only while the reservation is still ours (CAS on the marker). */
export async function completeMilestoneFailureDistributionStep(input: {
  distributionId: string;
  step: MilestoneFailureDistributionStep;
  marker: string;
  txSig: string;
}): Promise<boolean> {
  await ensureSchema();
  ensureMockSeeded();
  const base = parseFailureDistributionStepMarker(input.marker)?.base ?? input.marker;

  if (!hasDatabase()) {
    return memUpdateFailureStep(input.distributionId, input.step, (cur) =>
      cur === base || String(cur ?? "").startsWith(`${base}:`) ? input.txSig : false
    );
  }
  const col = failureStepColumn(input.step);
  const res = await getPool().query(
    `update milestone_failure_distributions set ${col}=$3 where id=$1 and (${col}=$2 or left(${col}, length($2) + 1) = $2 || ':') returning id`,
    [input.distributionId, base, input.txSig]
  );
  return Boolean(res.rows[0]);
}

/** Gives a reservation back (only when it is proven that nothing was sent), so the step can be retried right away. */
export async function releaseMilestoneFailureDistributionStep(input: {
  distributionId: string;
  step: MilestoneFailureDistributionStep;
  marker: string;
}): Promise<boolean> {
  await ensureSchema();
  ensureMockSeeded();
  const base = parseFailureDistributionStepMarker(input.marker)?.base ?? input.marker;

  if (!hasDatabase()) {
    return memUpdateFailureStep(input.distributionId, input.step, (cur) =>
      cur === base || String(cur ?? "").startsWith(`${base}:`) ? "pending" : false
    );
  }
  const col = failureStepColumn(input.step);
  const res = await getPool().query(
    `update milestone_failure_distributions set ${col}='pending' where id=$1 and (${col}=$2 or left(${col}, length($2) + 1) = $2 || ':') returning id`,
    [input.distributionId, base]
  );
  return Boolean(res.rows[0]);
}

 export async function getMilestoneFailureAllocation(input: {
  distributionId: string;
  walletPubkey: string;
 }): Promise<MilestoneFailureDistributionAllocation | null> {
  await ensureSchema();
  ensureMockSeeded();

  if (!hasDatabase()) {
    const byWallet = mem.milestoneFailureAllocationsByDistributionId.get(input.distributionId);
    return byWallet?.get(input.walletPubkey) ?? null;
  }

  const pool = getPool();
  const res = await pool.query(
    `select distribution_id, wallet_pubkey, amount_lamports, weight
     from milestone_failure_distribution_allocations where distribution_id=$1 and wallet_pubkey=$2`,
    [input.distributionId, input.walletPubkey]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    distributionId: String(row.distribution_id),
    walletPubkey: String(row.wallet_pubkey),
    amountLamports: Number(row.amount_lamports),
    weight: Number(row.weight),
  };
 }

 export async function getMilestoneFailureAllocationCount(distributionId: string): Promise<number> {
  await ensureSchema();
  ensureMockSeeded();

  const id = String(distributionId);
  if (!id) return 0;

  if (!hasDatabase()) {
    const byWallet = mem.milestoneFailureAllocationsByDistributionId.get(id);
    return byWallet ? byWallet.size : 0;
  }

  const pool = getPool();
  const res = await pool.query(
    "select count(*)::bigint as cnt from milestone_failure_distribution_allocations where distribution_id=$1",
    [id]
  );
  const n = Number(res.rows[0]?.cnt ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
 }

 export async function tryAcquireMilestoneFailureDistributionClaim(input: {
  distributionId: string;
  walletPubkey: string;
  claimedAtUnix: number;
  amountLamports: number;
 }): Promise<{ acquired: true } | { acquired: false; existing: MilestoneFailureDistributionClaim }> {
  await ensureSchema();
  ensureMockSeeded();

  const rec: MilestoneFailureDistributionClaim = {
    distributionId: input.distributionId,
    walletPubkey: input.walletPubkey,
    claimedAtUnix: Math.floor(input.claimedAtUnix),
    amountLamports: Math.floor(input.amountLamports),
    txSig: null,
  };

  if (!hasDatabase()) {
    let byWallet = mem.milestoneFailureClaimsByDistributionId.get(rec.distributionId);
    if (!byWallet) {
      byWallet = new Map();
      mem.milestoneFailureClaimsByDistributionId.set(rec.distributionId, byWallet);
    }
    const existing = byWallet.get(rec.walletPubkey);
    if (existing) return { acquired: false, existing };
    byWallet.set(rec.walletPubkey, rec);
    return { acquired: true };
  }

  const pool = getPool();
  const res = await pool.query(
    `insert into milestone_failure_distribution_claims (distribution_id, wallet_pubkey, claimed_at_unix, amount_lamports, tx_sig)
     values ($1,$2,$3,$4,'')
     on conflict (distribution_id, wallet_pubkey) do nothing
     returning distribution_id`,
    [rec.distributionId, rec.walletPubkey, String(rec.claimedAtUnix), String(rec.amountLamports)]
  );

  if (res.rows[0]) return { acquired: true };

  const existingRes = await pool.query(
    "select distribution_id, wallet_pubkey, claimed_at_unix, amount_lamports, tx_sig from milestone_failure_distribution_claims where distribution_id=$1 and wallet_pubkey=$2",
    [rec.distributionId, rec.walletPubkey]
  );
  const row = existingRes.rows[0];
  const txSigRaw = row ? String(row.tx_sig ?? "") : "";
  const txSig = txSigRaw.trim().length ? txSigRaw.trim() : null;
  const existing: MilestoneFailureDistributionClaim = {
    distributionId: rec.distributionId,
    walletPubkey: rec.walletPubkey,
    claimedAtUnix: row ? Number(row.claimed_at_unix) : rec.claimedAtUnix,
    amountLamports: row ? Number(row.amount_lamports) : rec.amountLamports,
    txSig,
  };
  return { acquired: false, existing };
 }

 export async function setMilestoneFailureDistributionClaimTxSig(input: {
  distributionId: string;
  walletPubkey: string;
  txSig: string;
 }): Promise<void> {
  await ensureSchema();
  ensureMockSeeded();

  if (!hasDatabase()) {
    const byWallet = mem.milestoneFailureClaimsByDistributionId.get(input.distributionId);
    const existing = byWallet?.get(input.walletPubkey);
    if (existing) {
      byWallet?.set(input.walletPubkey, { ...existing, txSig: input.txSig });
    }
    return;
  }

  const pool = getPool();
  await pool.query(
    "update milestone_failure_distribution_claims set tx_sig=$3 where distribution_id=$1 and wallet_pubkey=$2 and (tx_sig is null or tx_sig='')",
    [input.distributionId, input.walletPubkey, input.txSig]
  );
 }


/** Releases a failure-distribution claim that was reserved but never paid (no tx signature yet), so the voter can retry. */
export async function releaseMilestoneFailureDistributionClaim(input: { distributionId: string; walletPubkey: string }): Promise<void> {
  await ensureSchema();
  ensureMockSeeded();

  if (!hasDatabase()) {
    const byWallet = mem.milestoneFailureClaimsByDistributionId.get(input.distributionId);
    const existing = byWallet?.get(input.walletPubkey);
    if (existing && !existing.txSig) byWallet?.delete(input.walletPubkey);
    return;
  }

  await getPool().query(
    "delete from milestone_failure_distribution_claims where distribution_id=$1 and wallet_pubkey=$2 and (tx_sig is null or tx_sig='')",
    [input.distributionId, input.walletPubkey]
  );
}

/** Same as above for commitment-level failure distributions. */
export async function releaseFailureDistributionClaim(input: { distributionId: string; walletPubkey: string }): Promise<void> {
  await ensureSchema();
  ensureMockSeeded();

  if (!hasDatabase()) {
    const byWallet = (mem as any).failureClaimsByDistributionId?.get(input.distributionId) as Map<string, any> | undefined;
    const existing = byWallet?.get(input.walletPubkey);
    if (existing && !existing.txSig) byWallet?.delete(input.walletPubkey);
    return;
  }

  await getPool().query(
    "delete from failure_distribution_claims where distribution_id=$1 and wallet_pubkey=$2 and (tx_sig is null or tx_sig='')",
    [input.distributionId, input.walletPubkey]
  );
}

 export async function getMilestoneFailureReservedLamports(commitmentId: string): Promise<number> {
  await ensureSchema();
  ensureMockSeeded();

  const id = String(commitmentId);
  if (!id) return 0;

  if (!hasDatabase()) {
    let total = 0;
    let paid = 0;

    for (const d of mem.milestoneFailureDistributionsByCommitmentMilestone.values()) {
      if (d.commitmentId !== id) continue;
      const allocs = mem.milestoneFailureAllocationsByDistributionId.get(d.id);
      if (allocs) {
        for (const a of allocs.values()) total += Number(a.amountLamports ?? 0);
      }
      const claims = mem.milestoneFailureClaimsByDistributionId.get(d.id);
      if (claims) {
        for (const c of claims.values()) {
          const txSig = String(c.txSig ?? "").trim();
          if (txSig) paid += Number(c.amountLamports ?? 0);
        }
      }
    }

    return Math.max(0, Math.floor(total - paid));
  }

  const pool = getPool();
  const totalRes = await pool.query(
    `select coalesce(sum(a.amount_lamports), 0) as total
     from milestone_failure_distribution_allocations a
     join milestone_failure_distributions d on d.id=a.distribution_id
     where d.commitment_id=$1`,
    [id]
  );
  const paidRes = await pool.query(
    `select coalesce(sum(c.amount_lamports), 0) as paid
     from milestone_failure_distribution_claims c
     join milestone_failure_distributions d on d.id=c.distribution_id
     where d.commitment_id=$1 and c.tx_sig is not null and c.tx_sig<>''`,
    [id]
  );

  const total = Number(totalRes.rows[0]?.total ?? 0);
  const paid = Number(paidRes.rows[0]?.paid ?? 0);
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(paid) || paid <= 0) return Math.max(0, Math.floor(total));
  return Math.max(0, Math.floor(total - paid));
 }

export function getRewardVoteCutoffSeconds(): number {
  const raw = Number(process.env.REWARD_VOTE_CUTOFF_SECONDS ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 24 * 60 * 60;
}

/** The holder vote window of a turned-in milestone (same rules the signal route enforces). */
export function getRewardMilestoneVoteWindow(
  m: RewardMilestone,
  cutoffSeconds: number = getRewardVoteCutoffSeconds()
): { startUnix: number; endUnix: number } | null {
  const completedAtUnix = Number(m.completedAtUnix ?? 0);
  if (!Number.isFinite(completedAtUnix) || completedAtUnix <= 0) return null;
  const reviewOpenedAtUnix = Number((m as any).reviewOpenedAtUnix ?? 0);
  const hasReview = Number.isFinite(reviewOpenedAtUnix) && reviewOpenedAtUnix > 0;
  const dueAtUnix = Number(m.dueAtUnix ?? 0);
  const hasDue = Number.isFinite(dueAtUnix) && dueAtUnix > 0;
  const startUnix = hasReview ? Math.floor(reviewOpenedAtUnix) : hasDue ? Math.floor(dueAtUnix) : completedAtUnix;
  const endUnix = hasReview ? startUnix + cutoffSeconds : hasDue ? Math.floor(dueAtUnix) + cutoffSeconds : completedAtUnix + cutoffSeconds;
  if (!Number.isFinite(endUnix) || endUnix <= startUnix) return null;
  return { startUnix, endUnix };
}

function parseBigIntOrNull(v: unknown): bigint | null {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t.length || !/^-?\d+$/.test(t)) return null;
  try {
    return BigInt(t);
  } catch {
    return null;
  }
}

/** approval/reject count objects produced while a close-time re-check was still incomplete, tagged by milestone id. */
const closeRecheckPendingByCounts = new WeakMap<object, Set<string>>();
const closeRecheckInFlight = new Map<string, Promise<{ closed: boolean; complete: boolean; checked: number }>>();

/**
 * Close-time holder re-check for one milestone. After the vote window has closed, every in-window vote that was not
 * re-checked yet gets the voter's current balance read in one batch (see voteCloseRecheck.ts) and is marked eligible
 * only if the wallet still holds >= the minimum recorded at vote time (~$20 at the vote-time price; legacy votes
 * without a recorded minimum need any non-zero balance). Results are persisted in a single statement guarded by
 * `close_checked_at_unix is null`, so concurrent runs cannot mix two snapshots and the first complete one wins.
 * Any RPC failure persists nothing (the milestone stays "pending" and is retried by the next caller / cron).
 */
export async function ensureRewardMilestoneCloseRecheck(input: {
  commitmentId: string;
  milestone: RewardMilestone;
  tokenMint: string;
  nowUnix?: number;
}): Promise<{ closed: boolean; complete: boolean; checked: number }> {
  await ensureSchema();
  ensureMockSeeded();

  const commitmentId = String(input.commitmentId);
  const milestoneId = String(input.milestone?.id ?? "");
  const w = getRewardMilestoneVoteWindow(input.milestone);
  const now = Math.floor(Number(input.nowUnix ?? nowUnix()));
  if (!milestoneId || !w) return { closed: false, complete: false, checked: 0 };
  if (now < w.endUnix) return { closed: false, complete: false, checked: 0 };

  // In-memory (mock/dev) mode has no persisted signal rows to re-check.
  if (!hasDatabase()) return { closed: true, complete: true, checked: 0 };

  const key = `${commitmentId}:${milestoneId}`;
  const inflight = closeRecheckInFlight.get(key);
  if (inflight) return inflight;

  const run = (async () => {
    const pool = getPool();
    const res = await pool.query(
      `select signer_pubkey, min_amount_raw from reward_milestone_signals
       where commitment_id=$1 and milestone_id=$2 and close_checked_at_unix is null
         and created_at_unix >= $3 and created_at_unix < $4`,
      [commitmentId, milestoneId, String(w.startUnix), String(w.endUnix)]
    );
    const rows = res.rows ?? [];
    if (!rows.length) return { closed: true, complete: true, checked: 0 };

    const tokenMint = String(input.tokenMint ?? "").trim();
    if (!tokenMint) throw new Error("Token mint required for the close-time re-check");

    const owners: string[] = [];
    const minByOwner = new Map<string, bigint>();
    for (const r of rows) {
      const owner = String(r.signer_pubkey);
      owners.push(owner);
      const min = parseBigIntOrNull(r.min_amount_raw);
      minByOwner.set(owner, min != null && min > 0n ? min : 1n);
    }

    const { balances, slot } = await fetchCloseBalances({ mint: tokenMint, owners, minAmountRawByOwner: minByOwner });
    for (const o of owners) {
      if (!balances.has(o)) throw new Error("Close-time balance missing for a voter");
    }

    const amounts = owners.map((o) => (balances.get(o) ?? 0n).toString());
    const eligible = owners.map((o) => {
      const amt = balances.get(o) ?? 0n;
      return amt > 0n && amt >= (minByOwner.get(o) ?? 1n);
    });

    await pool.query(
      `update reward_milestone_signals s set
         close_checked_at_unix=$3, close_slot=$4, close_amount_raw=v.amt, close_eligible=v.ok
       from (select unnest($5::text[]) as signer, unnest($6::text[]) as amt, unnest($7::boolean[]) as ok) v
       where s.commitment_id=$1 and s.milestone_id=$2 and s.signer_pubkey=v.signer and s.close_checked_at_unix is null`,
      [commitmentId, milestoneId, String(now), slot == null ? null : String(slot), owners, amounts, eligible]
    );

    return { closed: true, complete: true, checked: owners.length };
  })();

  closeRecheckInFlight.set(key, run);
  try {
    return await run;
  } finally {
    closeRecheckInFlight.delete(key);
  }
}

export type EligibleRewardVoter = {
  signerPubkey: string;
  vote: RewardMilestoneVote;
  createdAtUnix: number;
  /** min(vote-time balance, close-time balance) in raw units (null for legacy rows without raw data). */
  effectiveAmountRaw: bigint | null;
  tokenDecimals: number | null;
  /** The same weight in UI units (legacy rows: the vote-time snapshot). */
  effectiveUiAmount: number;
  /** Deterministic integer weight base: effective balance in micro-units (1e-6 token). */
  weightUnits: bigint;
  shipMultiplierBps: number;
};

/**
 * Voters of a milestone that pass the close-time re-check, weighted by min(voteBalance, closeBalance).
 * Runs the re-check first if needed. `complete: false` means it could not finish (RPC trouble, or the window is still
 * open) - callers that allocate money must refuse to proceed in that case.
 */
export async function listEligibleRewardVotersAtClose(input: {
  record: CommitmentRecord;
  milestoneId: string;
  nowUnix?: number;
}): Promise<{ complete: boolean; voters: EligibleRewardVoter[] }> {
  await ensureSchema();
  ensureMockSeeded();

  const record = input.record;
  const milestoneId = String(input.milestoneId);
  const milestone = (Array.isArray(record.milestones) ? record.milestones : []).find((m) => m.id === milestoneId);
  if (!milestone) return { complete: false, voters: [] };
  const w = getRewardMilestoneVoteWindow(milestone);
  // A milestone that was never turned in has no vote window and therefore no voters.
  if (!w) return { complete: true, voters: [] };

  const now = Math.floor(Number(input.nowUnix ?? nowUnix()));
  if (now < w.endUnix) return { complete: false, voters: [] };

  if (!hasDatabase()) {
    const snaps = mem.rewardVoterSnapshots.get(record.id)?.get(milestoneId);
    const sigs = mem.rewardSignals.get(record.id)?.get(milestoneId);
    const voters: EligibleRewardVoter[] = [];
    for (const [signer, v] of Array.from(sigs?.entries() ?? [])) {
      const snap = snaps?.get(signer);
      const ui = Number(snap?.projectUiAmount ?? 0);
      if (!Number.isFinite(ui) || ui <= 0) continue;
      voters.push({
        signerPubkey: signer,
        vote: v.vote,
        createdAtUnix: v.createdAtUnix,
        effectiveAmountRaw: null,
        tokenDecimals: null,
        effectiveUiAmount: ui,
        weightUnits: BigInt(Math.floor(ui * 1e6)),
        shipMultiplierBps: Number(snap?.shipMultiplierBps ?? 10000),
      });
    }
    return { complete: true, voters };
  }

  const tokenMint = String(record.tokenMint ?? "").trim();
  try {
    const r = await ensureRewardMilestoneCloseRecheck({ commitmentId: record.id, milestone, tokenMint, nowUnix: now });
    if (!r.complete) return { complete: false, voters: [] };
  } catch (e) {
    console.warn("[votes] close-time re-check failed", { commitmentId: record.id, milestoneId, error: (e as Error)?.message ?? String(e) });
    return { complete: false, voters: [] };
  }

  const pool = getPool();
  const res = await pool.query(
    `select s.signer_pubkey, s.vote, s.created_at_unix, s.vote_amount_raw, s.token_decimals, s.close_checked_at_unix,
            s.close_amount_raw, s.close_eligible, v.project_ui_amount, v.ship_multiplier_bps
     from reward_milestone_signals s
     left join reward_voter_snapshots v
       on v.commitment_id=s.commitment_id and v.milestone_id=s.milestone_id and v.signer_pubkey=s.signer_pubkey
     where s.commitment_id=$1 and s.milestone_id=$2 and s.created_at_unix >= $3 and s.created_at_unix < $4
     order by s.signer_pubkey asc`,
    [record.id, milestoneId, String(w.startUnix), String(w.endUnix)]
  );

  const voters: EligibleRewardVoter[] = [];
  for (const r of res.rows ?? []) {
    if (r.close_checked_at_unix == null) return { complete: false, voters: [] };
    if (r.close_eligible !== true) continue;

    const voteRaw = parseBigIntOrNull(r.vote_amount_raw);
    const closeRaw = parseBigIntOrNull(r.close_amount_raw);
    const decimalsRaw = r.token_decimals == null ? null : Number(r.token_decimals);
    const decimals = decimalsRaw != null && Number.isFinite(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 18 ? Math.floor(decimalsRaw) : null;
    const snapUi = Number(r.project_ui_amount ?? 0);

    let effectiveAmountRaw: bigint | null = null;
    let effectiveUiAmount = 0;
    let weightUnits = 0n;
    if (voteRaw != null && closeRaw != null && decimals != null) {
      effectiveAmountRaw = voteRaw < closeRaw ? voteRaw : closeRaw;
      weightUnits = decimals >= 6 ? effectiveAmountRaw / 10n ** BigInt(decimals - 6) : effectiveAmountRaw * 10n ** BigInt(6 - decimals);
      effectiveUiAmount = Number(effectiveAmountRaw) / 10 ** decimals;
    } else {
      // Legacy rows (recorded before raw amounts were stored): use the vote-time snapshot. They still had to pass the
      // close-time "still holds a non-zero balance" check above.
      if (!Number.isFinite(snapUi) || snapUi <= 0) continue;
      effectiveUiAmount = snapUi;
      weightUnits = BigInt(Math.floor(snapUi * 1e6));
    }
    if (weightUnits <= 0n) continue;

    const shipBps = Number(r.ship_multiplier_bps ?? 10000);
    voters.push({
      signerPubkey: String(r.signer_pubkey),
      vote: String(r.vote ?? "approve") === "reject" ? "reject" : "approve",
      createdAtUnix: Number(r.created_at_unix),
      effectiveAmountRaw,
      tokenDecimals: decimals,
      effectiveUiAmount,
      weightUnits,
      shipMultiplierBps: Number.isFinite(shipBps) && shipBps > 0 ? Math.floor(shipBps) : 10000,
    });
  }

  return { complete: true, voters };
}

export async function getRewardMilestoneVoteCounts(commitmentId: string): Promise<RewardMilestoneVoteCounts> {
  await ensureSchema();

  ensureMockSeeded();

  const cutoffSeconds = (() => {
    const raw = Number(process.env.REWARD_VOTE_CUTOFF_SECONDS ?? "");
    if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
    return 24 * 60 * 60;
  })();

  const getVoteWindow = (m: RewardMilestone): { startUnix: number; endUnix: number } | null => {
    const completedAtUnix = Number(m.completedAtUnix ?? 0);
    if (!Number.isFinite(completedAtUnix) || completedAtUnix <= 0) return null;

    const reviewOpenedAtUnix = Number((m as any).reviewOpenedAtUnix ?? 0);
    const hasReview = Number.isFinite(reviewOpenedAtUnix) && reviewOpenedAtUnix > 0;

    const dueAtUnix = Number(m.dueAtUnix ?? 0);
    const hasDue = Number.isFinite(dueAtUnix) && dueAtUnix > 0;

    const startUnix = hasReview ? Math.floor(reviewOpenedAtUnix) : hasDue ? Math.floor(dueAtUnix) : completedAtUnix;
    const endUnix = hasReview ? startUnix + cutoffSeconds : hasDue ? Math.floor(dueAtUnix) + cutoffSeconds : completedAtUnix + cutoffSeconds;
    return { startUnix, endUnix };
  };

  if (!hasDatabase()) {
    const approvalCounts: RewardMilestoneApprovalCounts = {};
    const rejectCounts: RewardMilestoneApprovalCounts = {};
    const totalCounts: RewardMilestoneApprovalCounts = {};
    const record = await getCommitment(commitmentId);
    const milestones: RewardMilestone[] = record?.kind === "creator_reward" && Array.isArray(record.milestones) ? (record.milestones as RewardMilestone[]) : [];
    const milestoneById = new Map<string, RewardMilestone>();
    for (const m of milestones) milestoneById.set(m.id, m);

    const byMilestone = mem.rewardSignals.get(commitmentId);
    if (!byMilestone) return { approvalCounts, rejectCounts, totalCounts };

    for (const [milestoneId, bySigner] of byMilestone.entries()) {
      const m = milestoneById.get(milestoneId);
      if (!m) continue;
      const w = getVoteWindow(m);
      if (!w) continue;

      let approvals = 0;
      let rejects = 0;
      for (const v of bySigner.values()) {
        if (!v) continue;
        const createdAtUnix = Number((v as any).createdAtUnix ?? 0);
        const vote: RewardMilestoneVote = String((v as any).vote ?? "approve") === "reject" ? "reject" : "approve";
        if (!Number.isFinite(createdAtUnix) || createdAtUnix < w.startUnix || createdAtUnix >= w.endUnix) continue;
        if (vote === "reject") rejects += 1;
        else approvals += 1;
      }

      approvalCounts[milestoneId] = approvals;
      rejectCounts[milestoneId] = rejects;
      totalCounts[milestoneId] = approvals + rejects;
    }
    return { approvalCounts, rejectCounts, totalCounts };
  }

  const pool = getPool();

  const record = await getCommitment(commitmentId);
  const milestones: RewardMilestone[] = record?.kind === "creator_reward" && Array.isArray(record.milestones) ? (record.milestones as RewardMilestone[]) : [];
  const milestoneById = new Map<string, RewardMilestone>();
  for (const m of milestones) milestoneById.set(m.id, m);
  const tokenMint = String(record?.tokenMint ?? "").trim();
  const now = nowUnix();

  const load = () =>
    pool.query(
      "select milestone_id, vote, created_at_unix, close_checked_at_unix, close_eligible from reward_milestone_signals where commitment_id=$1",
      [commitmentId]
    );

  let res = await load();

  // Windows that have closed but still hold votes nobody re-checked yet: run the close-time holder re-check now.
  const needsRecheck = new Set<string>();
  for (const row of res.rows) {
    const milestoneId = String(row.milestone_id);
    const m = milestoneById.get(milestoneId);
    if (!m || String((m as any).autoKind ?? "") === "market_cap") continue;
    const w = getVoteWindow(m);
    if (!w || now < w.endUnix) continue;
    const createdAtUnix = Number(row.created_at_unix ?? 0);
    if (!Number.isFinite(createdAtUnix) || createdAtUnix < w.startUnix || createdAtUnix >= w.endUnix) continue;
    if (row.close_checked_at_unix == null) needsRecheck.add(milestoneId);
  }

  const pendingCloseRecheck: Record<string, boolean> = {};
  if (needsRecheck.size) {
    for (const milestoneId of needsRecheck) {
      const m = milestoneById.get(milestoneId) as RewardMilestone;
      try {
        if (!tokenMint) throw new Error("Commitment has no token mint");
        const r = await ensureRewardMilestoneCloseRecheck({ commitmentId, milestone: m, tokenMint, nowUnix: now });
        if (!r.complete) pendingCloseRecheck[milestoneId] = true;
      } catch (e) {
        pendingCloseRecheck[milestoneId] = true;
        console.warn("[votes] close-time re-check pending", { commitmentId, milestoneId, error: (e as Error)?.message ?? String(e) });
      }
    }
    res = await load();
  }

  const approvalCounts: RewardMilestoneApprovalCounts = {};
  const rejectCounts: RewardMilestoneApprovalCounts = {};
  const totalCounts: RewardMilestoneApprovalCounts = {};
  for (const row of res.rows) {
    const milestoneId = String(row.milestone_id);
    const createdAtUnix = Number(row.created_at_unix ?? 0);
    const vote: RewardMilestoneVote = String(row.vote ?? "approve") === "reject" ? "reject" : "approve";
    const m = milestoneById.get(milestoneId);
    if (!m) continue;

    const w = getVoteWindow(m);
    if (!w) continue;
    if (!Number.isFinite(createdAtUnix) || createdAtUnix < w.startUnix || createdAtUnix >= w.endUnix) continue;

    // Once the window has closed a vote only counts if the wallet still held the minimum at close.
    if (now >= w.endUnix) {
      if (row.close_checked_at_unix == null) {
        pendingCloseRecheck[milestoneId] = true;
        continue;
      }
      if (row.close_eligible !== true) continue;
    }

    if (vote === "reject") {
      rejectCounts[milestoneId] = Number(rejectCounts[milestoneId] ?? 0) + 1;
    } else {
      approvalCounts[milestoneId] = Number(approvalCounts[milestoneId] ?? 0) + 1;
    }

    totalCounts[milestoneId] = Number(totalCounts[milestoneId] ?? 0) + 1;
  }

  const pendingIds = new Set(Object.keys(pendingCloseRecheck));
  if (pendingIds.size) {
    // Callers pass approvalCounts/rejectCounts straight into normalizeRewardMilestonesClaimable; tag them so it can
    // hold back the approve/fail transition until the re-check has completed.
    closeRecheckPendingByCounts.set(approvalCounts, pendingIds);
    closeRecheckPendingByCounts.set(rejectCounts, pendingIds);
  }
  return { approvalCounts, rejectCounts, totalCounts, pendingCloseRecheck };
}

export async function getRewardMilestoneApprovalCounts(commitmentId: string): Promise<RewardMilestoneApprovalCounts> {
  const counts = await getRewardMilestoneVoteCounts(commitmentId);
  return counts.approvalCounts;
}

export function getRewardApprovalThreshold(): number {
  const raw = Number(process.env.REWARD_APPROVAL_THRESHOLD ?? "");
  const count = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15;
  return count;
}

export function normalizeRewardMilestonesClaimable(input: {
  milestones: RewardMilestone[];
  nowUnix: number;
  approvalCounts: RewardMilestoneApprovalCounts;
  rejectCounts?: RewardMilestoneApprovalCounts;
  approvalThreshold: number;
  /**
   * Milestones whose close-time holder re-check is still incomplete (from getRewardMilestoneVoteCounts). Their
   * approve/fail decision is held back until the re-check completes. Counts objects returned by
   * getRewardMilestoneVoteCounts carry this automatically, so existing callers do not need to pass it.
   */
  pendingCloseRecheck?: Record<string, boolean>;
}): { milestones: RewardMilestone[]; changed: boolean } {
  const { milestones, nowUnix, approvalCounts, approvalThreshold } = input;
  const rejectCounts = input.rejectCounts ?? {};
  const pendingRecheck = new Set<string>();
  for (const [k, v] of Object.entries(input.pendingCloseRecheck ?? {})) if (v) pendingRecheck.add(k);
  for (const k of Array.from(closeRecheckPendingByCounts.get(approvalCounts) ?? [])) pendingRecheck.add(k);
  for (const k of Array.from(closeRecheckPendingByCounts.get(rejectCounts) ?? [])) pendingRecheck.add(k);

  const claimDelaySeconds = (() => {
    const rawStr = process.env.REWARD_CLAIM_DELAY_SECONDS;
    if (rawStr == null || String(rawStr).trim() === "") return 48 * 60 * 60;
    const raw = Number(rawStr);
    if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
    return 48 * 60 * 60;
  })();

  const cutoffSeconds = (() => {
    const raw = Number(process.env.REWARD_VOTE_CUTOFF_SECONDS ?? "");
    if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
    return 24 * 60 * 60;
  })();

  const deliveryGraceSeconds = (() => {
    const raw = Number(process.env.REWARD_DELIVERY_GRACE_SECONDS ?? "");
    if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
    return 24 * 60 * 60;
  })();

  const getVoteEndUnix = (m: RewardMilestone): number | null => {
    const completedAtUnix = Number(m.completedAtUnix ?? 0);
    if (!Number.isFinite(completedAtUnix) || completedAtUnix <= 0) return null;
    const reviewOpenedAtUnix = Number((m as any).reviewOpenedAtUnix ?? 0);
    if (Number.isFinite(reviewOpenedAtUnix) && reviewOpenedAtUnix > 0) {
      return Math.floor(reviewOpenedAtUnix) + cutoffSeconds;
    }
    const dueAtUnix = Number(m.dueAtUnix ?? 0);
    if (Number.isFinite(dueAtUnix) && dueAtUnix > 0) {
      return Math.floor(dueAtUnix) + cutoffSeconds;
    }
    return completedAtUnix + cutoffSeconds;
  };

  let changed = false;
  const next = milestones.map((m) => {
    if (m.status === "claimable" && m.becameClaimableAtUnix == null) {
      changed = true;
      return {
        ...m,
        becameClaimableAtUnix: m.claimableAtUnix ?? nowUnix,
      };
    }

    if (m.status === "approved") {
      if (m.approvedAtUnix == null) {
        changed = true;
        return { ...m, approvedAtUnix: nowUnix };
      }
      const completedAtUnix = Number(m.completedAtUnix ?? 0);
      const desiredClaimableAtUnix =
        Number.isFinite(completedAtUnix) && completedAtUnix > 0 ? completedAtUnix + claimDelaySeconds : null;

      if (desiredClaimableAtUnix == null) return m;

      const needsClaimableAtUpdate = Number(m.claimableAtUnix ?? 0) !== desiredClaimableAtUnix;
      if (needsClaimableAtUpdate) changed = true;

      if (nowUnix < desiredClaimableAtUnix) {
        if (!needsClaimableAtUpdate) return m;
        return { ...m, claimableAtUnix: desiredClaimableAtUnix };
      }

      changed = true;
      return {
        ...m,
        status: "claimable" as const,
        claimableAtUnix: desiredClaimableAtUnix,
        becameClaimableAtUnix: m.becameClaimableAtUnix ?? nowUnix,
      };
    }

    if (m.status !== "locked") return m;

    const dueAtUnix = Number(m.dueAtUnix ?? 0);
    const hasDue = Number.isFinite(dueAtUnix) && dueAtUnix > 0;
    const graceEndUnix = hasDue ? dueAtUnix + deliveryGraceSeconds : null;

    if (m.completedAtUnix == null) {
      if (graceEndUnix != null && nowUnix >= graceEndUnix) {
        changed = true;
        return {
          ...m,
          status: "failed" as const,
          failedAtUnix: m.failedAtUnix ?? nowUnix,
        };
      }
      return m;
    }

    const completedAtUnix = Number(m.completedAtUnix ?? 0);
    const reviewOpenedAtUnix = Number((m as any).reviewOpenedAtUnix ?? 0);
    const hasReview = Number.isFinite(reviewOpenedAtUnix) && reviewOpenedAtUnix > 0;
    if (!hasReview && graceEndUnix != null && Number.isFinite(completedAtUnix) && completedAtUnix >= graceEndUnix) {
      changed = true;
      return {
        ...m,
        status: "failed" as const,
        failedAtUnix: m.failedAtUnix ?? nowUnix,
      };
    }

    const desiredClaimableAtUnix = Number.isFinite(completedAtUnix) && completedAtUnix > 0 ? completedAtUnix + claimDelaySeconds : null;
    if (desiredClaimableAtUnix == null) return m;

    const voteEndUnix = getVoteEndUnix(m);
    if (voteEndUnix == null) return m;

    const approvals = Number(approvalCounts[m.id] ?? 0);
    const rejects = Number(rejectCounts[m.id] ?? 0);
    const approved = approvals >= approvalThreshold && approvals > rejects;

    const needsClaimableAtUpdate = Number(m.claimableAtUnix ?? 0) !== desiredClaimableAtUnix;
    if (needsClaimableAtUpdate) changed = true;

    // Votes only count once the window has closed AND every voter's holdings were re-checked at close (a wallet that
    // sold or moved its bag before the close does not count). There is deliberately no early approval while the window
    // is open, even with REWARD_CLAIM_DELAY_SECONDS=0: a vote-time balance alone can be recycled across wallets.
    if (nowUnix < voteEndUnix || pendingRecheck.has(m.id)) {
      if (!needsClaimableAtUpdate) return m;
      return { ...m, claimableAtUnix: desiredClaimableAtUnix };
    }

    changed = true;
    if (approved) {
      const nextStatus = nowUnix >= desiredClaimableAtUnix ? ("claimable" as const) : ("approved" as const);
      return {
        ...m,
        status: nextStatus,
        approvedAtUnix: m.approvedAtUnix ?? nowUnix,
        claimableAtUnix: desiredClaimableAtUnix,
        becameClaimableAtUnix: nextStatus === "claimable" ? (m.becameClaimableAtUnix ?? nowUnix) : m.becameClaimableAtUnix,
      };
    }
    return {
      ...m,
      status: "failed" as const,
      failedAtUnix: m.failedAtUnix ?? nowUnix,
      claimableAtUnix: desiredClaimableAtUnix,
    };
  });
  return { milestones: next, changed };
}

// Statuses that only an explicit admin/resolution action may change - background normalization must never revive them.
const TERMINAL_COMMITMENT_STATUSES = new Set<CommitmentStatus>(["failed", "resolving", "resolved_success", "resolved_failure", "archived"]);

/**
 * Persists derived reward totals / milestone states.
 * - Terminal statuses (failed, resolving, resolved_*, archived) are never overwritten here.
 * - Pass `expectedMilestones` (the list you normalized from) to make the write conditional: if someone else changed
 *   the milestones in the meantime the write is skipped and the current record is returned, so a stale read can
 *   never clobber a concurrent completion / release / vote.
 */
export async function updateRewardTotalsAndMilestones(input: {
  id: string;
  totalFundedLamports?: number;
  unlockedLamports?: number;
  milestones?: RewardMilestone[];
  status?: CommitmentStatus;
  expectedMilestones?: RewardMilestone[];
}): Promise<CommitmentRecord> {
  await ensureSchema();

  if (!hasDatabase()) {
    const current = mem.commitments.get(input.id);
    if (!current) throw new Error("Not found");
    const nextStatus =
      TERMINAL_COMMITMENT_STATUSES.has(current.status) && input.status != null && input.status !== current.status
        ? current.status
        : (input.status ?? current.status);
    const updated: CommitmentRecord = {
      ...current,
      totalFundedLamports: input.totalFundedLamports ?? current.totalFundedLamports,
      unlockedLamports: input.unlockedLamports ?? current.unlockedLamports,
      milestones: input.milestones ?? current.milestones,
      status: nextStatus,
    };
    mem.commitments.set(input.id, updated);
    return updated;
  }

  const pool = getPool();

  const current = await getCommitment(input.id);
  if (!current) throw new Error("Not found");
  const desiredStatus =
    TERMINAL_COMMITMENT_STATUSES.has(current.status) && input.status != null && input.status !== current.status ? undefined : input.status;

  const fields: string[] = [];
  const values: any[] = [input.id];
  let idx = 2;

  if (input.totalFundedLamports != null) {
    fields.push(`total_funded_lamports=$${idx++}`);
    values.push(String(input.totalFundedLamports));
  }
  if (input.unlockedLamports != null) {
    fields.push(`unlocked_lamports=$${idx++}`);
    values.push(String(input.unlockedLamports));
  }
  if (input.milestones != null) {
    fields.push(`milestones_json=$${idx++}`);
    values.push(JSON.stringify(input.milestones));
  }
  if (desiredStatus != null) {
    fields.push(`status=$${idx++}`);
    values.push(desiredStatus);
  }

  if (fields.length === 0) {
    const current = await getCommitment(input.id);
    if (!current) throw new Error("Not found");
    return current;
  }

  let where = "id=$1";
  if (input.expectedMilestones && input.milestones != null) {
    // Compare-and-swap on the milestones document (jsonb equality ignores key order / whitespace).
    where += ` and coalesce(milestones_json, '[]')::jsonb = $${idx++}::jsonb`;
    values.push(JSON.stringify(input.expectedMilestones));
  }

  const res = await pool.query(`update commitments set ${fields.join(", ")} where ${where} returning *`, values);
  const row = res.rows[0];
  if (!row) {
    // Either the record is gone, or (CAS) somebody changed it first - in which case theirs wins.
    const latest = await getCommitment(input.id);
    if (!latest) throw new Error("Not found");
    return latest;
  }
  return rowToRecord(row);
}

export async function finalizeCommitmentStatus(input: {
  id: string;
  status: CommitmentStatus;
  resolvedAtUnix?: number;
  resolvedTxSig?: string;
}): Promise<CommitmentRecord> {
  await ensureSchema();

  if (!hasDatabase()) {
    const current = mem.commitments.get(input.id);
    if (!current || current.status !== "resolving") throw new Error("Commitment not in resolving state");
    const next: CommitmentRecord = {
      ...current,
      status: input.status,
      resolvedAtUnix: input.resolvedAtUnix ?? current.resolvedAtUnix,
      resolvedTxSig: input.resolvedTxSig ?? current.resolvedTxSig,
    };
    mem.commitments.set(input.id, next);
    return next;
  }

  const pool = getPool();
  const res = await pool.query(
    "update commitments set status=$2, resolved_at_unix=$3, resolved_tx_sig=$4 where id=$1 and status='resolving' returning *",
    [
      input.id,
      input.status,
      input.resolvedAtUnix == null ? null : String(input.resolvedAtUnix),
      input.resolvedTxSig ?? null,
    ]
  );
  const row = res.rows[0];
  if (!row) throw new Error("Commitment not in resolving state");
  return rowToRecord(row);
}

export async function releaseFailureSettlementClaim(input: { id: string; restoreStatus: CommitmentStatus }): Promise<void> {
  await ensureSchema();

  if (!hasDatabase()) {
    const current = mem.commitments.get(input.id);
    if (current && current.status === "resolving") {
      mem.commitments.set(input.id, { ...current, status: input.restoreStatus });
    }
    return;
  }

  const pool = getPool();
  await pool.query("update commitments set status=$2 where id=$1 and status='resolving'", [input.id, input.restoreStatus]);
}

export async function getFailureDistributionByCommitmentId(commitmentId: string): Promise<FailureDistributionRecord | null> {
  await ensureSchema();
  ensureMockSeeded();

  if (!hasDatabase()) {
    return mem.failureDistributionsByCommitmentId.get(commitmentId) ?? null;
  }

  const pool = getPool();
  const res = await pool.query("select * from failure_distributions where commitment_id=$1", [commitmentId]);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    commitmentId: String(row.commitment_id),
    createdAtUnix: Number(row.created_at_unix),
    buybackLamports: Number(row.buyback_lamports),
    voterPotLamports: Number(row.voter_pot_lamports),
    shipBuybackTreasuryPubkey: String(row.ship_buyback_treasury_pubkey),
    buybackTxSig: String(row.buyback_tx_sig),
    voterPotTxSig: row.voter_pot_tx_sig == null ? undefined : String(row.voter_pot_tx_sig),
    status: String(row.status) as FailureDistributionStatus,
  };
}

export async function createFailureDistribution(input: {
  distribution: FailureDistributionRecord;
  allocations: FailureDistributionAllocation[];
}): Promise<void> {
  await ensureSchema();

  if (!hasDatabase()) {
    mem.failureDistributionsByCommitmentId.set(input.distribution.commitmentId, input.distribution);
    const byWallet = new Map<string, FailureDistributionAllocation>();
    for (const a of input.allocations) byWallet.set(a.walletPubkey, a);
    mem.failureAllocationsByDistributionId.set(input.distribution.id, byWallet);
    return;
  }

  const pool = getPool();
  await pool.query(
    `insert into failure_distributions (
      id, commitment_id, created_at_unix, buyback_lamports, voter_pot_lamports,
      ship_buyback_treasury_pubkey, buyback_tx_sig, voter_pot_tx_sig, status
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.distribution.id,
      input.distribution.commitmentId,
      String(input.distribution.createdAtUnix),
      String(input.distribution.buybackLamports),
      String(input.distribution.voterPotLamports),
      input.distribution.shipBuybackTreasuryPubkey,
      input.distribution.buybackTxSig,
      input.distribution.voterPotTxSig ?? null,
      input.distribution.status,
    ]
  );

  for (const a of input.allocations) {
    await pool.query(
      `insert into failure_distribution_allocations (distribution_id, wallet_pubkey, amount_lamports, weight)
       values ($1,$2,$3,$4)
       on conflict (distribution_id, wallet_pubkey) do nothing`,
      [a.distributionId, a.walletPubkey, String(a.amountLamports), a.weight]
    );
  }
}

export async function getFailureAllocation(input: { distributionId: string; walletPubkey: string }): Promise<FailureDistributionAllocation | null> {
  await ensureSchema();
  ensureMockSeeded();

  if (!hasDatabase()) {
    const byWallet = mem.failureAllocationsByDistributionId.get(input.distributionId);
    return byWallet?.get(input.walletPubkey) ?? null;
  }

  const pool = getPool();
  const res = await pool.query(
    `select distribution_id, wallet_pubkey, amount_lamports, weight
     from failure_distribution_allocations where distribution_id=$1 and wallet_pubkey=$2`,
    [input.distributionId, input.walletPubkey]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    distributionId: String(row.distribution_id),
    walletPubkey: String(row.wallet_pubkey),
    amountLamports: Number(row.amount_lamports),
    weight: Number(row.weight),
  };
}

export async function hasFailureClaim(input: { distributionId: string; walletPubkey: string }): Promise<boolean> {
  await ensureSchema();
  ensureMockSeeded();

  if (!hasDatabase()) {
    const byWallet = mem.failureClaimsByDistributionId.get(input.distributionId);
    return Boolean(byWallet?.get(input.walletPubkey));
  }

  const pool = getPool();
  const res = await pool.query(
    `select 1 from failure_distribution_claims where distribution_id=$1 and wallet_pubkey=$2`,
    [input.distributionId, input.walletPubkey]
  );
  return Boolean(res.rows[0]);
}

export async function insertFailureClaim(input: FailureDistributionClaim): Promise<void> {
  await ensureSchema();

  if (!hasDatabase()) {
    let byWallet = mem.failureClaimsByDistributionId.get(input.distributionId);
    if (!byWallet) {
      byWallet = new Map();
      mem.failureClaimsByDistributionId.set(input.distributionId, byWallet);
    }
    byWallet.set(input.walletPubkey, input);
    return;
  }

  const pool = getPool();
  await pool.query(
    `insert into failure_distribution_claims (distribution_id, wallet_pubkey, claimed_at_unix, amount_lamports, tx_sig)
     values ($1,$2,$3,$4,$5)
     on conflict (distribution_id, wallet_pubkey) do nothing`,
    [input.distributionId, input.walletPubkey, String(input.claimedAtUnix), String(input.amountLamports), input.txSig ?? ""]
  );
}

export async function tryAcquireFailureDistributionClaim(input: {
  distributionId: string;
  walletPubkey: string;
  claimedAtUnix: number;
  amountLamports: number;
}): Promise<{ acquired: true } | { acquired: false; existing: FailureDistributionClaim }> {
  await ensureSchema();
  ensureMockSeeded();

  const rec: FailureDistributionClaim = {
    distributionId: input.distributionId,
    walletPubkey: input.walletPubkey,
    claimedAtUnix: Math.floor(input.claimedAtUnix),
    amountLamports: Math.floor(input.amountLamports),
    txSig: null,
  };

  if (!hasDatabase()) {
    let byWallet = mem.failureClaimsByDistributionId.get(rec.distributionId);
    if (!byWallet) {
      byWallet = new Map();
      mem.failureClaimsByDistributionId.set(rec.distributionId, byWallet);
    }
    const existing = byWallet.get(rec.walletPubkey);
    if (existing) return { acquired: false, existing };
    byWallet.set(rec.walletPubkey, rec);
    return { acquired: true };
  }

  const pool = getPool();
  const res = await pool.query(
    `insert into failure_distribution_claims (distribution_id, wallet_pubkey, claimed_at_unix, amount_lamports, tx_sig)
     values ($1,$2,$3,$4,'')
     on conflict (distribution_id, wallet_pubkey) do nothing
     returning distribution_id`,
    [rec.distributionId, rec.walletPubkey, String(rec.claimedAtUnix), String(rec.amountLamports)]
  );

  if (res.rows[0]) return { acquired: true };

  const existingRes = await pool.query(
    "select distribution_id, wallet_pubkey, claimed_at_unix, amount_lamports, tx_sig from failure_distribution_claims where distribution_id=$1 and wallet_pubkey=$2",
    [rec.distributionId, rec.walletPubkey]
  );
  const row = existingRes.rows[0];
  const txSigRaw = row ? String(row.tx_sig ?? "") : "";
  const txSig = txSigRaw.trim().length ? txSigRaw.trim() : null;
  const existing: FailureDistributionClaim = {
    distributionId: rec.distributionId,
    walletPubkey: rec.walletPubkey,
    claimedAtUnix: row ? Number(row.claimed_at_unix) : rec.claimedAtUnix,
    amountLamports: row ? Number(row.amount_lamports) : rec.amountLamports,
    txSig,
  };
  return { acquired: false, existing };
}

export async function setFailureDistributionClaimTxSig(input: {
  distributionId: string;
  walletPubkey: string;
  txSig: string;
}): Promise<void> {
  await ensureSchema();
  ensureMockSeeded();

  if (!hasDatabase()) {
    const byWallet = mem.failureClaimsByDistributionId.get(input.distributionId);
    const existing = byWallet?.get(input.walletPubkey);
    if (existing) {
      byWallet?.set(input.walletPubkey, { ...existing, txSig: input.txSig });
    }
    return;
  }

  const pool = getPool();
  await pool.query(
    "update failure_distribution_claims set tx_sig=$3 where distribution_id=$1 and wallet_pubkey=$2 and (tx_sig is null or tx_sig='')",
    [input.distributionId, input.walletPubkey, input.txSig]
  );
}

export async function listCommitments(): Promise<CommitmentRecord[]> {
  await ensureSchema();

  ensureMockSeeded();

  if (!hasDatabase()) {
    return Array.from(mem.commitments.values()).sort((a, b) => b.createdAtUnix - a.createdAtUnix);
  }

  const pool = getPool();
  const res = await pool.query("select * from commitments order by created_at_unix desc");
  return res.rows.map(rowToRecord);
}

/** The live managed creator-reward commitment (if any) whose creator wallet is `authority`. */
export async function findManagedCommitmentByAuthority(authority: string): Promise<CommitmentRecord | null> {
  await ensureSchema();
  ensureMockSeeded();

  const key = String(authority ?? "").trim();
  if (!key) return null;

  if (!hasDatabase()) {
    return (
      Array.from(mem.commitments.values()).find(
        (c) => c.kind === "creator_reward" && c.creatorFeeMode === "managed" && c.status !== "archived" && c.authority === key
      ) ?? null
    );
  }

  const pool = getPool();
  const res = await pool.query(
    "select * from commitments where kind='creator_reward' and creator_fee_mode='managed' and status <> 'archived' and authority=$1 limit 1",
    [key]
  );
  const row = res.rows[0];
  return row ? rowToRecord(row) : null;
}

export async function getCommitment(id: string): Promise<CommitmentRecord | null> {
  await ensureSchema();

  ensureMockSeeded();

  if (!hasDatabase()) {
    return mem.commitments.get(id) ?? null;
  }

  const pool = getPool();
  const res = await pool.query("select * from commitments where id=$1", [id]);
  const row = res.rows[0];
  return row ? rowToRecord(row) : null;
}

export async function updateCommitmentAdminFields(input: {
  id: string;
  status?: CommitmentStatus;
  creatorFeeMode?: CreatorFeeMode | null;
}): Promise<CommitmentRecord> {
  await ensureSchema();

  if (!hasDatabase()) {
    const current = mem.commitments.get(input.id);
    if (!current) throw new Error("Not found");
    const updated: CommitmentRecord = {
      ...current,
      status: input.status ?? current.status,
      creatorFeeMode: input.creatorFeeMode === undefined ? current.creatorFeeMode : input.creatorFeeMode ?? undefined,
    };
    mem.commitments.set(input.id, updated);
    return updated;
  }

  const fields: string[] = [];
  const values: any[] = [input.id];
  let idx = 2;

  if (input.status != null) {
    fields.push(`status=$${idx++}`);
    values.push(input.status);
  }

  if (input.creatorFeeMode !== undefined) {
    fields.push(`creator_fee_mode=$${idx++}`);
    values.push(input.creatorFeeMode);
  }

  if (fields.length === 0) {
    const existing = await getCommitment(input.id);
    if (!existing) throw new Error("Not found");
    return existing;
  }

  const pool = getPool();
  const res = await pool.query(`update commitments set ${fields.join(", ")} where id=$1 returning *`, values);
  const row = res.rows[0];
  if (!row) throw new Error("Not found");
  return rowToRecord(row);
}

export async function getActiveCommitmentByTokenMint(tokenMint: string): Promise<CommitmentRecord | null> {
  await ensureSchema();

  const mint = String(tokenMint ?? "").trim();
  if (!mint) return null;

  if (!hasDatabase()) {
    for (const c of mem.commitments.values()) {
      if (c.tokenMint === mint && (c.status === "active" || c.status === "created")) {
        return c;
      }
    }
    return null;
  }

  const pool = getPool();
  const res = await pool.query(
    "select * from commitments where token_mint=$1 and status in ('active','created') limit 1",
    [mint]
  );
  const row = res.rows[0];
  return row ? rowToRecord(row) : null;
}

export async function claimForFailureSettlement(id: string): Promise<CommitmentRecord | null> {
  await ensureSchema();

  if (!hasDatabase()) {
    const current = mem.commitments.get(id);
    if (!current) return null;
    if (current.status !== "created" && current.status !== "active") return null;
    const next: CommitmentRecord = { ...current, status: "resolving" };
    mem.commitments.set(id, next);
    return next;
  }

  const pool = getPool();
  const res = await pool.query(
    "update commitments set status='resolving' where id=$1 and status in ('created','active') returning *",
    [id]
  );
  const row = res.rows[0];
  return row ? rowToRecord(row) : null;
}

export async function claimForResolution(id: string): Promise<CommitmentRecord | null> {
  await ensureSchema();

  if (!hasDatabase()) {
    const current = mem.commitments.get(id);
    if (!current) return null;
    if (current.status !== "created") return null;
    const next: CommitmentRecord = { ...current, status: "resolving" };
    mem.commitments.set(id, next);
    return next;
  }

  const pool = getPool();
  const res = await pool.query(
    "update commitments set status='resolving' where id=$1 and status='created' returning *",
    [id]
  );
  const row = res.rows[0];
  return row ? rowToRecord(row) : null;
}

export async function finalizeResolution(input: {
  id: string;
  status: "resolved_success" | "resolved_failure";
  resolvedAtUnix: number;
  resolvedTxSig: string;
}): Promise<CommitmentRecord> {
  await ensureSchema();

  if (!hasDatabase()) {
    const current = mem.commitments.get(input.id);
    if (!current || current.status !== "resolving") throw new Error("Commitment not in resolving state");
    const next: CommitmentRecord = {
      ...current,
      status: input.status,
      resolvedAtUnix: input.resolvedAtUnix,
      resolvedTxSig: input.resolvedTxSig,
    };
    mem.commitments.set(input.id, next);
    return next;
  }

  const pool = getPool();
  const res = await pool.query(
    "update commitments set status=$2, resolved_at_unix=$3, resolved_tx_sig=$4 where id=$1 and status='resolving' returning *",
    [input.id, input.status, String(input.resolvedAtUnix), input.resolvedTxSig]
  );
  const row = res.rows[0];
  if (!row) throw new Error("Commitment not in resolving state");
  return rowToRecord(row);
}

export async function releaseResolutionClaim(id: string): Promise<void> {
  await ensureSchema();

  if (!hasDatabase()) {
    const current = mem.commitments.get(id);
    if (current && current.status === "resolving") {
      mem.commitments.set(id, { ...current, status: "created" });
    }
    return;
  }

  const pool = getPool();
  await pool.query("update commitments set status='created' where id=$1 and status='resolving'", [id]);
}

export function randomId(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function validateEscrowSecretKeyB58(secret: string): void {
  const bytes = bs58.decode(secret);
  if (bytes.length !== 64) {
    throw new Error("Invalid escrow secret key length");
  }
}
