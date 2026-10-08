import crypto from "crypto";
import { PublicKey } from "@solana/web3.js";

import {
  RewardMilestone,
  VoteRewardDistributionRecord,
  countRewardMilestoneSignalsBySigner,
  createVoteRewardDistributionWithAllocations,
  getCommitment,
  getRewardMilestoneSignalFirstSeenUnixBySigner,
  getRewardMilestoneVoteWindow,
  getRewardVoteCutoffSeconds,
  getVoteRewardDistribution,
  listEligibleRewardVotersAtClose,
} from "./escrowStore";
import { getPool, hasDatabase } from "./db";
import { getChainUnixTime, getConnection, getTokenProgramIdForMint, verifyTokenExistsOnChain } from "./solana";

/**
 * Vote reward distributions ($SHIP rewards for milestone voters).
 *
 * Allocation happens exactly once per milestone, only after the vote window has closed AND the close-time holder
 * re-check has completed (escrowStore.listEligibleRewardVotersAtClose): wallets that no longer held the minimum at close
 * get nothing, and pool weights use min(voteBalance, closeBalance). The distribution and all of its allocations are
 * written in one transaction with the pool cap (CTS_VOTE_REWARD_MAX_POOL_UI_AMOUNT) enforced in SQL, so nothing is
 * claimable before close and a concurrent creator can never add a second allocation set. All amounts are BigInt.
 */

export function isVoteRewardDistributionsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_VOTE_REWARD_DISTRIBUTIONS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function getParticipationWindowMilestones(): number {
  const raw = Number(process.env.CTS_PARTICIPATION_WINDOW_MILESTONES ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 20;
}

function getStreaksGraceMisses(): number {
  const raw = Number(process.env.CTS_STREAKS_GRACE_MISSES ?? "");
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 2;
}

/** Streak multiplier in basis points (5000..20000). */
function streaksMultiplierBpsFromMisses(input: { misses: number; graceMisses: number }): bigint {
  const misses = Math.max(0, Math.floor(Number(input.misses ?? 0)));
  const grace = Math.max(0, Math.floor(Number(input.graceMisses ?? 0)));
  const penalizedGraceMisses = Math.min(misses, grace);
  const extraMisses = Math.max(0, misses - grace);
  // 2.0x minus 0.05x per grace miss and 0.10x per further miss, floored at 0.5x - all in bps to stay exact.
  const bps = 20000 - penalizedGraceMisses * 500 - extraMisses * 1000;
  return BigInt(Math.max(5000, Math.min(20000, bps)));
}

function getVoteRewardPoolUiAmount(): number {
  const raw = String(process.env.CTS_VOTE_REWARD_POOL_UI_AMOUNT ?? "").trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return 0;
  return Math.floor(n);
}

function getVoteRewardPerVoteUiAmount(): number {
  const raw = String(process.env.CTS_VOTE_REWARD_PER_VOTE_UI_AMOUNT ?? "").trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return 0;
  return Math.floor(n);
}

export function getVoteRewardMode(): "pool" | "fixed" {
  const raw = String(process.env.CTS_VOTE_REWARD_MODE ?? "").trim().toLowerCase();
  if (raw === "fixed" || raw === "per_vote" || raw === "per-vote" || raw === "per_voter" || raw === "per-voter") return "fixed";
  if (raw === "pool") return "pool";

  const perVote = getVoteRewardPerVoteUiAmount();
  const pool = getVoteRewardPoolUiAmount();
  if (perVote > 0 && pool <= 0) return "fixed";
  if (pool > 0 && perVote <= 0) return "pool";
  if (perVote > 0 && pool > 0) return "fixed";
  return "pool";
}

function getVoteRewardMaxPoolUiAmount(): number {
  const raw = String(process.env.CTS_VOTE_REWARD_MAX_POOL_UI_AMOUNT ?? "").trim();
  if (!raw.length) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return 0;
  return Math.floor(n);
}

const MAX_I64 = 9223372036854775807n;

export type VoteRewardMintConfig = {
  mintPubkey: string;
  tokenProgramPubkey: string;
  faucetOwnerPubkey: string;
  decimals: number;
};

export type VoteRewardCreateResult =
  | { ok: true; created: boolean; distribution: VoteRewardDistributionRecord; allocations: number; nowUnix: number }
  | { ok: false; status: number; code: string; error: string; details?: Record<string, unknown> };

function fail(status: number, code: string, error: string, details?: Record<string, unknown>): VoteRewardCreateResult {
  return { ok: false, status, code, error, details };
}

/** Reads CTS_SHIP_TOKEN_MINT / CTS_VOTE_REWARD_FAUCET_OWNER_PUBKEY and the mint's program + decimals (read-only RPC). */
export async function loadVoteRewardMintConfig(): Promise<VoteRewardMintConfig | { error: string }> {
  const shipMintRaw = String(process.env.CTS_SHIP_TOKEN_MINT ?? "").trim();
  if (!shipMintRaw) return { error: "CTS_SHIP_TOKEN_MINT is required" };
  const faucetOwnerRaw = String(process.env.CTS_VOTE_REWARD_FAUCET_OWNER_PUBKEY ?? "").trim();
  if (!faucetOwnerRaw) return { error: "CTS_VOTE_REWARD_FAUCET_OWNER_PUBKEY is required" };

  const connection = getConnection();
  const mintPk = new PublicKey(shipMintRaw);
  const tokenProgram = await getTokenProgramIdForMint({ connection, mint: mintPk });
  const mintInfo = await verifyTokenExistsOnChain({ connection, mint: mintPk });
  const decimals = Number(mintInfo.decimals ?? 0);
  if (!mintInfo.exists || !mintInfo.isMintAccount || !Number.isFinite(decimals) || decimals < 0 || decimals > 18) {
    return { error: "Invalid CTS_SHIP_TOKEN_MINT mint account" };
  }
  return {
    mintPubkey: mintPk.toBase58(),
    tokenProgramPubkey: tokenProgram.toBase58(),
    faucetOwnerPubkey: new PublicKey(faucetOwnerRaw).toBase58(),
    decimals: Math.floor(decimals),
  };
}

/**
 * Creates the vote reward distribution for one milestone (idempotent). Refuses while the window is open or while the
 * close-time re-check is incomplete. Returns the existing distribution if one was already created.
 */
export async function createVoteRewardDistributionForMilestone(input: {
  commitmentId: string;
  milestoneId: string;
  nowUnix?: number;
  mint?: VoteRewardMintConfig;
  mode?: "pool" | "fixed";
}): Promise<VoteRewardCreateResult> {
  const commitmentId = String(input.commitmentId ?? "").trim();
  const milestoneId = String(input.milestoneId ?? "").trim();
  if (!commitmentId || !milestoneId) return fail(400, "invalid_input", "commitmentId and milestoneId are required");

  const record = await getCommitment(commitmentId);
  if (!record) return fail(404, "not_found", "Not found");
  if (record.kind !== "creator_reward") return fail(400, "not_reward_commitment", "Not a reward commitment");

  const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
  const milestone = milestones.find((m) => String(m?.id ?? "") === milestoneId);
  if (!milestone) return fail(404, "milestone_not_found", "Milestone not found");
  if (String((milestone as any)?.autoKind ?? "") === "market_cap") {
    return fail(409, "vote_disabled_marketcap", "Vote rewards are disabled for market cap milestones");
  }

  const nowUnix = Math.floor(Number(input.nowUnix ?? (await getChainUnixTime(getConnection()))));
  const cutoffSeconds = getRewardVoteCutoffSeconds();
  const voteWindow = getRewardMilestoneVoteWindow(milestone, cutoffSeconds);
  if (!voteWindow) return fail(409, "no_vote_window", "Milestone has no vote window yet");
  if (voteWindow.endUnix > nowUnix) return fail(409, "vote_window_open", "Vote window still open", { nowUnix, voteWindow });

  const existing = await getVoteRewardDistribution({ commitmentId, milestoneId });
  if (existing) return { ok: true, created: false, distribution: existing, allocations: -1, nowUnix };

  const mint = input.mint ?? (await loadVoteRewardMintConfig());
  if ("error" in mint) return fail(500, "config", mint.error);

  const eligible = await listEligibleRewardVotersAtClose({ record, milestoneId, nowUnix });
  if (!eligible.complete) {
    return fail(503, "close_recheck_pending", "Close-time holder re-check is not complete yet; try again shortly");
  }
  const voters = eligible.voters;
  if (!voters.length) return fail(409, "no_eligible_voters", "No eligible voters (none still held the minimum at close)");

  // Participation streak multipliers (bps), over the most recent ended vote windows of this commitment.
  const signerPubkeys = voters.map((v) => v.signerPubkey);
  const streakBpsByWallet = new Map<string, bigint>();
  const endedOpportunities = milestones
    .map((m) => {
      const w = getRewardMilestoneVoteWindow(m, cutoffSeconds);
      if (!w || w.endUnix > nowUnix) return null;
      return { milestoneId: m.id, startUnix: w.startUnix, endUnix: w.endUnix };
    })
    .filter(Boolean) as Array<{ milestoneId: string; startUnix: number; endUnix: number }>;
  const recentWindow = endedOpportunities
    .sort((a, b) => b.endUnix - a.endUnix || a.milestoneId.localeCompare(b.milestoneId))
    .slice(0, getParticipationWindowMilestones());
  const windowMilestoneIds = recentWindow.map((m) => m.milestoneId);
  if (windowMilestoneIds.length) {
    const [voteCounts, firstSeen] = await Promise.all([
      countRewardMilestoneSignalsBySigner({ commitmentId, milestoneIds: windowMilestoneIds, signerPubkeys }),
      getRewardMilestoneSignalFirstSeenUnixBySigner({ commitmentId, signerPubkeys }),
    ]);
    const graceMisses = getStreaksGraceMisses();
    for (const walletPubkey of signerPubkeys) {
      const firstSeenUnix = Number(firstSeen.get(walletPubkey) ?? 0);
      const opportunities = recentWindow.reduce((acc, m) => {
        if (!Number.isFinite(firstSeenUnix) || firstSeenUnix <= 0) return acc + 1;
        return m.endUnix >= firstSeenUnix ? acc + 1 : acc;
      }, 0);
      const votes = Math.max(0, Math.floor(Number(voteCounts.get(walletPubkey) ?? 0)));
      const misses = opportunities > 0 ? Math.max(0, opportunities - votes) : 0;
      streakBpsByWallet.set(walletPubkey, streaksMultiplierBpsFromMisses({ misses, graceMisses }));
    }
  }

  const decimals = mint.decimals;
  const unit = 10n ** BigInt(decimals);
  const maxPoolUi = getVoteRewardMaxPoolUiAmount();
  const capRaw = maxPoolUi > 0 ? BigInt(maxPoolUi) * unit : null;
  const mode = input.mode ?? getVoteRewardMode();

  const distributionId = crypto.randomBytes(16).toString("hex");
  type Alloc = { distributionId: string; walletPubkey: string; amountRaw: bigint; weight: number; sortKey: bigint };
  let allocs: Alloc[] = [];
  let poolAmountRaw = 0n;

  if (mode === "fixed") {
    const perVoteUi = getVoteRewardPerVoteUiAmount();
    if (!perVoteUi) return fail(500, "config", "CTS_VOTE_REWARD_PER_VOTE_UI_AMOUNT must be a positive integer in fixed mode");
    const perVoteRaw = BigInt(perVoteUi) * unit;

    for (const v of voters) {
      const shipBps = BigInt(v.shipMultiplierBps);
      const streakBps = streakBpsByWallet.get(v.signerPubkey) ?? 10000n;
      const amt = (perVoteRaw * shipBps * streakBps) / 100_000_000n;
      if (amt <= 0n) continue;
      allocs.push({ distributionId, walletPubkey: v.signerPubkey, amountRaw: amt, weight: Number(shipBps * streakBps) / 1e8, sortKey: amt });
    }
    let total = allocs.reduce((acc, a) => acc + a.amountRaw, 0n);
    if (total <= 0n) return fail(409, "no_eligible_voters", "No eligible voters for a fixed distribution");

    // Over the cap: scale every allocation down pro rata (floor), so the total never exceeds the cap.
    if (capRaw != null && total > capRaw) {
      const scaledTotal = total;
      allocs = allocs.map((a) => ({ ...a, amountRaw: (a.amountRaw * capRaw) / scaledTotal })).filter((a) => a.amountRaw > 0n);
      total = allocs.reduce((acc, a) => acc + a.amountRaw, 0n);
    }
    poolAmountRaw = total;
  } else {
    const poolUi = getVoteRewardPoolUiAmount();
    if (!poolUi) return fail(500, "config", "CTS_VOTE_REWARD_POOL_UI_AMOUNT must be a positive integer");
    poolAmountRaw = BigInt(poolUi) * unit;
    if (capRaw != null && poolAmountRaw > capRaw) poolAmountRaw = capRaw;

    const weighted = voters
      .map((v) => {
        const streakBps = streakBpsByWallet.get(v.signerPubkey) ?? 10000n;
        return { v, w: v.weightUnits * BigInt(v.shipMultiplierBps) * streakBps };
      })
      .filter((x) => x.w > 0n);
    const totalWeight = weighted.reduce((acc, x) => acc + x.w, 0n);
    if (totalWeight <= 0n) return fail(409, "no_eligible_voters", "No eligible voter weight");

    weighted.sort((a, b) => (b.w > a.w ? 1 : b.w < a.w ? -1 : a.v.signerPubkey.localeCompare(b.v.signerPubkey)));
    let allocated = 0n;
    for (const x of weighted) {
      const amt = (poolAmountRaw * x.w) / totalWeight;
      if (amt <= 0n) continue;
      allocs.push({ distributionId, walletPubkey: x.v.signerPubkey, amountRaw: amt, weight: Number(x.w), sortKey: x.w });
      allocated += amt;
    }
    const remainder = poolAmountRaw - allocated;
    if (remainder > 0n && allocs.length > 0) allocs[0] = { ...allocs[0], amountRaw: allocs[0].amountRaw + remainder };
    if (!allocs.length) return fail(409, "no_eligible_voters", "Pool too small for any allocation");
  }

  if (poolAmountRaw <= 0n || poolAmountRaw > MAX_I64) return fail(500, "config", "Vote reward pool out of range");

  const distribution: VoteRewardDistributionRecord = {
    id: distributionId,
    commitmentId,
    milestoneId,
    createdAtUnix: nowUnix,
    mintPubkey: mint.mintPubkey,
    tokenProgramPubkey: mint.tokenProgramPubkey,
    poolAmountRaw: poolAmountRaw.toString(),
    faucetOwnerPubkey: mint.faucetOwnerPubkey,
    status: "open",
  };

  const res = await createVoteRewardDistributionWithAllocations({
    distribution,
    allocations: allocs.map((a) => ({ distributionId, walletPubkey: a.walletPubkey, amountRaw: a.amountRaw.toString(), weight: a.weight })),
    maxPoolAmountRaw: capRaw == null ? null : capRaw.toString(),
  });
  if (!res.created) return { ok: true, created: false, distribution: res.existing, allocations: -1, nowUnix };
  return { ok: true, created: true, distribution, allocations: allocs.length, nowUnix };
}

/**
 * Lazily creates distributions for the milestones a wallet voted on (called from the claimable views). Only closed,
 * fully re-checked windows produce a distribution; everything else is skipped and retried on a later call.
 */
export async function ensureVoteRewardDistributionsForWallet(input: {
  walletPubkey: string;
  maxPairs?: number;
  maxCreates?: number;
}): Promise<{ considered: number; created: number }> {
  const walletPubkey = String(input.walletPubkey ?? "").trim();
  if (!walletPubkey) return { considered: 0, created: 0 };
  if (!hasDatabase()) return { considered: 0, created: 0 };
  if (!isVoteRewardDistributionsEnabled()) return { considered: 0, created: 0 };

  // Makes sure the escrow tables exist before the raw query below.
  await getVoteRewardDistribution({ commitmentId: "", milestoneId: "" });

  const maxPairs = Math.max(1, Math.min(12, Math.floor(Number(input.maxPairs ?? 8))));
  const maxCreates = Math.max(0, Math.min(5, Math.floor(Number(input.maxCreates ?? 2))));
  if (maxCreates === 0) return { considered: 0, created: 0 };

  const pool = getPool();
  const pairsRes = await pool.query(
    `select s.commitment_id, s.milestone_id, max(s.created_at_unix) as last_seen
     from reward_milestone_signals s
     left join vote_reward_distributions d on d.commitment_id=s.commitment_id and d.milestone_id=s.milestone_id
     where s.signer_pubkey=$1 and d.id is null
     group by s.commitment_id, s.milestone_id
     order by last_seen desc
     limit $2`,
    [walletPubkey, maxPairs]
  );

  const pairs = (pairsRes.rows ?? []) as Array<{ commitment_id: string; milestone_id: string }>;
  if (!pairs.length) return { considered: 0, created: 0 };

  const mint = await loadVoteRewardMintConfig();
  if ("error" in mint) return { considered: pairs.length, created: 0 };

  const nowUnix = await getChainUnixTime(getConnection());
  const mode = getVoteRewardMode();

  let created = 0;
  let considered = 0;
  for (const p of pairs) {
    const commitmentId = String(p?.commitment_id ?? "").trim();
    const milestoneId = String(p?.milestone_id ?? "").trim();
    if (!commitmentId || !milestoneId) continue;
    considered += 1;
    try {
      const r = await createVoteRewardDistributionForMilestone({ commitmentId, milestoneId, nowUnix, mint, mode });
      if (r.ok && r.created) {
        created += 1;
        if (created >= maxCreates) break;
      }
    } catch (e) {
      console.warn("[vote-rewards] lazy create failed", { commitmentId, milestoneId, error: (e as Error)?.message ?? String(e) });
    }
  }

  return { considered, created };
}
