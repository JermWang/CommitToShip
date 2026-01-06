import { NextResponse } from "next/server";
import crypto from "crypto";
import { PublicKey } from "@solana/web3.js";

import { isAdminRequestAsync } from "../../../../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../../../../lib/adminSession";
import { auditLog } from "../../../../../../../lib/auditLog";
import { checkRateLimit } from "../../../../../../../lib/rateLimit";
import {
  RewardMilestone,
  countRewardMilestoneSignalsBySigner,
  getCommitment,
  getRewardMilestoneSignalFirstSeenUnixBySigner,
  insertVoteRewardDistributionAllocations,
  listRewardVoterSnapshotsByMilestone,
  publicView,
  tryAcquireVoteRewardDistributionCreate,
} from "../../../../../../../lib/escrowStore";
import {
  getChainUnixTime,
  getConnection,
  getTokenProgramIdForMint,
  verifyTokenExistsOnChain,
} from "../../../../../../../lib/solana";
import { getSafeErrorMessage } from "../../../../../../../lib/safeError";

export const runtime = "nodejs";

function isVoteRewardDistributionsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_VOTE_REWARD_DISTRIBUTIONS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function getVoteCutoffSeconds(): number {
  const raw = Number(process.env.REWARD_VOTE_CUTOFF_SECONDS ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 24 * 60 * 60;
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

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function streaksMultiplierFromMisses(input: { misses: number; graceMisses: number }): number {
  const misses = Math.max(0, Math.floor(Number(input.misses ?? 0)));
  const grace = Math.max(0, Math.floor(Number(input.graceMisses ?? 0)));

  const gracePenalty = 0.05;
  const extraPenalty = 0.1;

  const penalizedGraceMisses = Math.min(misses, grace);
  const extraMisses = Math.max(0, misses - grace);
  const penalty = penalizedGraceMisses * gracePenalty + extraMisses * extraPenalty;
  return clamp(2.0 - penalty, 0.5, 2.0);
}

function getVoteWindowUnix(input: { milestone: RewardMilestone; cutoffSeconds: number }): { startUnix: number; endUnix: number } | null {
  const completedAtUnix = Number(input.milestone.completedAtUnix ?? 0);
  if (!Number.isFinite(completedAtUnix) || completedAtUnix <= 0) return null;

  const reviewOpenedAtUnix = Number((input.milestone as any).reviewOpenedAtUnix ?? 0);
  const dueAtUnix = Number((input.milestone as any).dueAtUnix ?? 0);
  const hasReview = Number.isFinite(reviewOpenedAtUnix) && reviewOpenedAtUnix > 0;
  const hasDue = Number.isFinite(dueAtUnix) && dueAtUnix > 0;

  const startUnix = hasReview ? Math.floor(reviewOpenedAtUnix) : hasDue ? Math.floor(dueAtUnix) : completedAtUnix;
  const endUnix = hasReview ? startUnix + input.cutoffSeconds : hasDue ? Math.floor(dueAtUnix) + input.cutoffSeconds : completedAtUnix + input.cutoffSeconds;
  if (!Number.isFinite(endUnix) || endUnix <= startUnix) return null;
  return { startUnix, endUnix };
}

function getVoteRewardPoolUiAmount(): number {
  const raw = String(process.env.CTS_VOTE_REWARD_POOL_UI_AMOUNT ?? "").trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return 0;
  return Math.floor(n);
}

function getVoteRewardMode(): "pool" | "fixed" {
  const raw = String(process.env.CTS_VOTE_REWARD_MODE ?? "pool").trim().toLowerCase();
  if (raw === "fixed" || raw === "per_vote" || raw === "per-vote" || raw === "per_voter" || raw === "per-voter") return "fixed";
  return "pool";
}

function getVoteRewardPerVoteUiAmount(): number {
  const raw = String(process.env.CTS_VOTE_REWARD_PER_VOTE_UI_AMOUNT ?? "").trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return 0;
  return Math.floor(n);
}

function getVoteRewardMaxPoolUiAmount(): number {
  const raw = String(process.env.CTS_VOTE_REWARD_MAX_POOL_UI_AMOUNT ?? "").trim();
  if (!raw.length) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return 0;
  return Math.floor(n);
}

const MAX_I64 = 9223372036854775807n;

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "vote-reward:create", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    if (!isVoteRewardDistributionsEnabled()) {
      return NextResponse.json(
        {
          error: "Vote reward distributions are disabled",
          hint: "Set CTS_ENABLE_VOTE_REWARD_DISTRIBUTIONS=1 (or true) to enable vote reward distributions.",
        },
        { status: 503 }
      );
    }

    verifyAdminOrigin(req);
    if (!(await isAdminRequestAsync(req))) {
      await auditLog("admin_vote_reward_distribution_denied", { commitmentId: ctx.params.id, milestoneId: ctx.params.milestoneId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const commitmentId = ctx.params.id;
    const milestoneId = ctx.params.milestoneId;

    const record = await getCommitment(commitmentId);
    if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (record.kind !== "creator_reward") {
      return NextResponse.json({ error: "Not a reward commitment" }, { status: 400 });
    }

    const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
    const idx = milestones.findIndex((m) => m.id === milestoneId);
    if (idx < 0) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });

    if (String((milestones[idx] as any)?.autoKind ?? "") === "market_cap") {
      return NextResponse.json(
        {
          error: "Vote rewards are disabled for market cap milestones",
          hint: "Market cap milestones are auto-resolved and do not use holder voting.",
        },
        { status: 409 }
      );
    }

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);

    const cutoffSeconds = getVoteCutoffSeconds();
    const voteWindow = getVoteWindowUnix({ milestone: milestones[idx], cutoffSeconds });
    if (!voteWindow) {
      return NextResponse.json({ error: "Milestone has no vote window yet", milestone: milestones[idx], commitment: publicView(record) }, { status: 409 });
    }
    if (voteWindow.endUnix > nowUnix) {
      return NextResponse.json({ error: "Vote window still open", nowUnix, voteWindow }, { status: 409 });
    }

    const shipMintRaw = String(process.env.CTS_SHIP_TOKEN_MINT ?? "").trim();
    if (!shipMintRaw) {
      return NextResponse.json({ error: "CTS_SHIP_TOKEN_MINT is required" }, { status: 500 });
    }
    const faucetOwnerPubkey = String(process.env.CTS_VOTE_REWARD_FAUCET_OWNER_PUBKEY ?? "").trim();
    if (!faucetOwnerPubkey) {
      return NextResponse.json({ error: "CTS_VOTE_REWARD_FAUCET_OWNER_PUBKEY is required" }, { status: 500 });
    }

    const mintPk = new PublicKey(shipMintRaw);
    const tokenProgram = await getTokenProgramIdForMint({ connection, mint: mintPk });
    const mintInfo = await verifyTokenExistsOnChain({ connection, mint: mintPk });
    const decimals = Number(mintInfo.decimals ?? 0);
    if (!mintInfo.exists || !mintInfo.isMintAccount || !Number.isFinite(decimals) || decimals < 0 || decimals > 18) {
      return NextResponse.json({ error: "Invalid mint account", mint: shipMintRaw, mintInfo }, { status: 500 });
    }

    const mode = getVoteRewardMode();

    const snapshots = await listRewardVoterSnapshotsByMilestone({ commitmentId, milestoneId });

    const signerPubkeys = Array.from(
      new Set(
        snapshots
          .map((s) => String(s.signerPubkey ?? "").trim())
          .filter(Boolean)
      )
    );

    const participationMultiplierByWallet = new Map<string, number>();

    const endedOpportunities = milestones
      .map((milestone) => {
        const w = getVoteWindowUnix({ milestone, cutoffSeconds });
        if (!w) return null;
        if (w.endUnix > nowUnix) return null;
        return { milestoneId: milestone.id, startUnix: w.startUnix, endUnix: w.endUnix };
      })
      .filter(Boolean) as Array<{ milestoneId: string; startUnix: number; endUnix: number }>;

    const windowN = getParticipationWindowMilestones();
    const recentWindow = endedOpportunities.sort((a, b) => b.endUnix - a.endUnix || a.milestoneId.localeCompare(b.milestoneId)).slice(0, windowN);
    const windowMilestoneIds = recentWindow.map((m) => m.milestoneId);

    if (signerPubkeys.length && windowMilestoneIds.length) {
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
        const votes = Number(voteCounts.get(walletPubkey) ?? 0);

        const safeOpp = Number.isFinite(opportunities) && opportunities > 0 ? Math.floor(opportunities) : 0;
        const safeVotes = Number.isFinite(votes) && votes > 0 ? Math.floor(votes) : 0;
        const misses = safeOpp > 0 ? Math.max(0, safeOpp - safeVotes) : 0;
        participationMultiplierByWallet.set(walletPubkey, streaksMultiplierFromMisses({ misses, graceMisses }));
      }
    }

    const distributionId = crypto.randomBytes(16).toString("hex");

    const allocations: Array<{ distributionId: string; walletPubkey: string; amountRaw: string; weight: number }> = [];

    let poolAmountRawBig = 0n;

    if (mode === "fixed") {
      const perVoteUiAmount = getVoteRewardPerVoteUiAmount();
      if (!perVoteUiAmount) {
        return NextResponse.json(
          { error: "CTS_VOTE_REWARD_PER_VOTE_UI_AMOUNT is required and must be a positive integer when CTS_VOTE_REWARD_MODE=fixed" },
          { status: 500 }
        );
      }

      const perVoteRawBig = BigInt(perVoteUiAmount) * 10n ** BigInt(decimals);
      if (perVoteRawBig <= 0n || perVoteRawBig > MAX_I64) {
        return NextResponse.json({ error: "Per-vote amount too large", perVoteAmountRaw: perVoteRawBig.toString() }, { status: 500 });
      }
      if (perVoteRawBig > BigInt(Number.MAX_SAFE_INTEGER)) {
        return NextResponse.json(
          { error: "Per-vote amount exceeds safe JS integer; reduce CTS_VOTE_REWARD_PER_VOTE_UI_AMOUNT" },
          { status: 500 }
        );
      }

      const perVoteRawNum = Number(perVoteRawBig);
      let total = 0;

      for (const s of snapshots) {
        const pk = String(s.signerPubkey ?? "").trim();
        if (!pk) continue;

        const shipMultBps = Number(s.shipMultiplierBps ?? 10000);
        if (!Number.isFinite(shipMultBps) || shipMultBps <= 0) continue;

        const streakMult = Number(participationMultiplierByWallet.get(pk) ?? 1);
        const mult = (shipMultBps / 10000) * streakMult;
        if (!Number.isFinite(mult) || mult <= 0) continue;

        const amt = Math.floor(perVoteRawNum * mult);
        if (!Number.isFinite(amt) || amt <= 0) continue;

        allocations.push({ distributionId, walletPubkey: pk, amountRaw: String(amt), weight: mult });
        total += amt;
      }

      if (!Number.isFinite(total) || total <= 0) {
        return NextResponse.json({ error: "No eligible voters for fixed distribution" }, { status: 409 });
      }
      if (total > Number.MAX_SAFE_INTEGER) {
        return NextResponse.json({ error: "Total pool exceeds safe JS integer; reduce CTS_VOTE_REWARD_PER_VOTE_UI_AMOUNT" }, { status: 500 });
      }

      const maxPoolUiAmount = getVoteRewardMaxPoolUiAmount();
      if (maxPoolUiAmount) {
        const maxPoolRawBig = BigInt(maxPoolUiAmount) * 10n ** BigInt(decimals);
        if (maxPoolRawBig > 0n && BigInt(total) > maxPoolRawBig) {
          return NextResponse.json(
            {
              error: "Fixed vote reward distribution exceeds max pool cap",
              hint: "Increase CTS_VOTE_REWARD_MAX_POOL_UI_AMOUNT or reduce CTS_VOTE_REWARD_PER_VOTE_UI_AMOUNT",
              totalAmountRaw: String(total),
              maxPoolAmountRaw: maxPoolRawBig.toString(),
            },
            { status: 409 }
          );
        }
      }

      poolAmountRawBig = BigInt(total);
    } else {
      const poolUiAmount = getVoteRewardPoolUiAmount();
      if (!poolUiAmount) {
        return NextResponse.json(
          { error: "CTS_VOTE_REWARD_POOL_UI_AMOUNT is required and must be a positive integer" },
          { status: 500 }
        );
      }

      poolAmountRawBig = BigInt(poolUiAmount) * 10n ** BigInt(decimals);
      if (poolAmountRawBig <= 0n || poolAmountRawBig > MAX_I64) {
        return NextResponse.json({ error: "Pool amount too large", poolAmountRaw: poolAmountRawBig.toString() }, { status: 500 });
      }
      if (poolAmountRawBig > BigInt(Number.MAX_SAFE_INTEGER)) {
        return NextResponse.json(
          { error: "Pool amount exceeds safe JS integer; reduce CTS_VOTE_REWARD_POOL_UI_AMOUNT" },
          { status: 500 }
        );
      }

      const weightsByWallet = new Map<string, number>();
      for (const s of snapshots) {
        const pk = String(s.signerPubkey ?? "").trim();
        if (!pk) continue;
        const base = Number(s.projectUiAmount ?? 0);
        const multBps = Number(s.shipMultiplierBps ?? 10000);
        if (!Number.isFinite(base) || base <= 0) continue;
        if (!Number.isFinite(multBps) || multBps <= 0) continue;

        const baseWeight = base * (multBps / 10000);
        const streakMult = Number(participationMultiplierByWallet.get(pk) ?? 1);
        const w = baseWeight * streakMult;
        if (!Number.isFinite(w) || w <= 0) continue;
        weightsByWallet.set(pk, (weightsByWallet.get(pk) ?? 0) + w);
      }

      const totalWeight = Array.from(weightsByWallet.values()).reduce((acc, v) => acc + v, 0);
      const hasEligibleVoters = Number.isFinite(totalWeight) && totalWeight > 0;

      const poolAmountRawNum = Number(poolAmountRawBig);

      if (hasEligibleVoters && poolAmountRawNum > 0) {
        const entries = Array.from(weightsByWallet.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        let allocated = 0;
        for (const [walletPubkey, weight] of entries) {
          const amt = Math.floor((poolAmountRawNum * weight) / totalWeight);
          if (amt <= 0) continue;
          allocations.push({ distributionId, walletPubkey, amountRaw: String(amt), weight });
          allocated += amt;
        }

        const remainder = poolAmountRawNum - allocated;
        if (remainder > 0 && allocations.length > 0) {
          allocations[0] = { ...allocations[0], amountRaw: String(Number(allocations[0].amountRaw) + remainder) };
        }
      }
    }

    const distribution = {
      id: distributionId,
      commitmentId,
      milestoneId,
      createdAtUnix: nowUnix,
      mintPubkey: mintPk.toBase58(),
      tokenProgramPubkey: tokenProgram.toBase58(),
      poolAmountRaw: poolAmountRawBig.toString(),
      faucetOwnerPubkey,
      status: "open" as const,
    };

    const acquired = await tryAcquireVoteRewardDistributionCreate({ distribution });
    const existing = !acquired.acquired ? acquired.existing : null;

    if (existing) {
      if (
        existing.mintPubkey !== distribution.mintPubkey ||
        existing.tokenProgramPubkey !== distribution.tokenProgramPubkey ||
        String(existing.poolAmountRaw) !== String(distribution.poolAmountRaw) ||
        existing.faucetOwnerPubkey !== distribution.faucetOwnerPubkey
      ) {
        return NextResponse.json(
          {
            error: "Existing vote reward distribution has mismatched parameters",
            existing,
            expected: distribution,
          },
          { status: 409 }
        );
      }
    }

    const distributionToUse = existing ?? distribution;
    const allocationsForDb = allocations.map((a) => ({ ...a, distributionId: distributionToUse.id }));

    await insertVoteRewardDistributionAllocations({
      distributionId: distributionToUse.id,
      allocations: allocationsForDb,
    });

    await auditLog("admin_vote_reward_distribution_ok", {
      commitmentId,
      milestoneId,
      distributionId: distributionToUse.id,
      mintPubkey: distributionToUse.mintPubkey,
      poolAmountRaw: distributionToUse.poolAmountRaw,
      allocations: allocationsForDb.length,
    });

    return NextResponse.json({
      ok: true,
      nowUnix,
      distributionId: distributionToUse.id,
      commitmentId,
      milestoneId,
      mintPubkey: distributionToUse.mintPubkey,
      poolAmountRaw: distributionToUse.poolAmountRaw,
      allocations: allocationsForDb.length,
    });
  } catch (e) {
    await auditLog("admin_vote_reward_distribution_error", {
      commitmentId: ctx.params.id,
      milestoneId: ctx.params.milestoneId,
      error: getSafeErrorMessage(e),
    });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
