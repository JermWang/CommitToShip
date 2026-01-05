import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import crypto from "crypto";

import { isAdminRequestAsync } from "../../../../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../../../../lib/adminSession";
import { auditLog } from "../../../../../../../lib/auditLog";
import { checkRateLimit } from "../../../../../../../lib/rateLimit";
import {
  RewardMilestone,
  countRewardMilestoneSignalsBySigner,
  getCommitment,
  getEscrowSignerRef,
  getRewardMilestoneSignalFirstSeenUnixBySigner,
  getMilestoneFailureReservedLamports,
  getMilestoneFailureDistribution,
  insertMilestoneFailureDistributionAllocations,
  listRewardVoterSnapshotsByMilestone,
  publicView,
  sumReleasedLamports,
  tryAcquireMilestoneFailureDistributionCreate,
  setMilestoneFailureDistributionTxSigs,
} from "../../../../../../../lib/escrowStore";
import {
  getBalanceLamports,
  getChainUnixTime,
  getConnection,
  findRecentSystemTransferSignature,
  keypairFromBase58Secret,
  transferLamports,
  transferLamportsFromPrivyWallet,
} from "../../../../../../../lib/solana";
import { getSafeErrorMessage } from "../../../../../../../lib/safeError";

export const runtime = "nodejs";

function isMilestoneFailurePayoutsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_FAILURE_DISTRIBUTION_PAYOUTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isParticipationWeightedFailurePayoutsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_PARTICIPATION_WEIGHTED_FAILURE_PAYOUTS ?? "").trim().toLowerCase();
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

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "milestone:failure:create", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    if (!isMilestoneFailurePayoutsEnabled()) {
      return NextResponse.json(
        {
          error: "Milestone failure payouts are disabled",
          hint: "Set CTS_ENABLE_FAILURE_DISTRIBUTION_PAYOUTS=1 (or true) to enable milestone failure payouts.",
        },
        { status: 503 }
      );
    }

    verifyAdminOrigin(req);
    if (!(await isAdminRequestAsync(req))) {
      await auditLog("admin_milestone_failure_distribution_denied", { commitmentId: ctx.params.id, milestoneId: ctx.params.milestoneId });
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

    const m = milestones[idx];
    if (m.status !== "failed") {
      return NextResponse.json({ error: "Milestone is not failed", milestone: m, commitment: publicView(record) }, { status: 409 });
    }

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);

    const escrowPk = new PublicKey(record.escrowPubkey);
    const balanceLamports = await getBalanceLamports(connection, escrowPk);

    const releasedLamports = sumReleasedLamports(milestones);
    const totalFundedLamports = Math.max(0, Number(balanceLamports) + releasedLamports);

    const unlockLamportsRaw = Number(m.unlockLamports ?? 0);
    const unlockPercent = Number(m.unlockPercent ?? 0);

    const forfeitedLamports =
      Number.isFinite(unlockLamportsRaw) && unlockLamportsRaw > 0
        ? Math.floor(unlockLamportsRaw)
        : Number.isFinite(unlockPercent) && unlockPercent > 0
          ? Math.floor((totalFundedLamports * unlockPercent) / 100)
          : 0;

    if (!Number.isFinite(forfeitedLamports) || forfeitedLamports <= 0) {
      return NextResponse.json({ error: "Invalid forfeited amount", milestone: m }, { status: 400 });
    }

    const reservedLamports = await getMilestoneFailureReservedLamports(commitmentId);
    const availableLamports = Math.max(0, Math.floor(balanceLamports - reservedLamports));

    if (availableLamports < forfeitedLamports) {
      return NextResponse.json(
        {
          error: "Escrow underfunded for milestone failure payout",
          balanceLamports,
          reservedLamports,
          availableLamports,
          forfeitedLamports,
          commitment: publicView(record),
        },
        { status: 400 }
      );
    }

    const treasuryRaw = String(process.env.CTS_SHIP_BUYBACK_TREASURY_PUBKEY ?? "").trim();
    if (!treasuryRaw) {
      return NextResponse.json({ error: "CTS_SHIP_BUYBACK_TREASURY_PUBKEY is required" }, { status: 500 });
    }
    const treasury = new PublicKey(treasuryRaw);

    const escrowRef = getEscrowSignerRef(record);

    const buybackLamports = Math.floor(forfeitedLamports * 0.5);
    const plannedVoterPotLamports = Math.max(0, forfeitedLamports - buybackLamports);

    const snapshots = await listRewardVoterSnapshotsByMilestone({ commitmentId, milestoneId });

    const participationEnabled = isParticipationWeightedFailurePayoutsEnabled();
    const participationMultiplierByWallet = new Map<string, number>();

    if (participationEnabled) {
      const signerPubkeys = Array.from(
        new Set(
          snapshots
            .map((s) => String(s.signerPubkey ?? "").trim())
            .filter(Boolean)
        )
      );

      const cutoffSeconds = getVoteCutoffSeconds();
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
          const mult = streaksMultiplierFromMisses({ misses, graceMisses });
          participationMultiplierByWallet.set(walletPubkey, mult);
        }
      }
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
      const participationMult = participationEnabled ? Number(participationMultiplierByWallet.get(pk) ?? 1) : 1;
      const w = baseWeight * participationMult;
      if (!Number.isFinite(w) || w <= 0) continue;
      weightsByWallet.set(pk, (weightsByWallet.get(pk) ?? 0) + w);
    }

    const totalWeight = Array.from(weightsByWallet.values()).reduce((acc, v) => acc + v, 0);
    const distributionId = crypto.randomBytes(16).toString("hex");

    const allocations: Array<{ distributionId: string; walletPubkey: string; amountLamports: number; weight: number }> = [];

    const hasEligibleVoters = Number.isFinite(totalWeight) && totalWeight > 0;
    const initialVoterPotLamports = hasEligibleVoters ? plannedVoterPotLamports : 0;

    if (hasEligibleVoters && initialVoterPotLamports > 0) {
      const entries = Array.from(weightsByWallet.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      let allocated = 0;
      for (const [walletPubkey, weight] of entries) {
        const amt = Math.floor((initialVoterPotLamports * weight) / totalWeight);
        if (amt <= 0) continue;
        allocations.push({ distributionId, walletPubkey, amountLamports: amt, weight });
        allocated += amt;
      }

      const remainder = initialVoterPotLamports - allocated;
      if (remainder > 0 && allocations.length > 0) {
        allocations[0] = { ...allocations[0], amountLamports: allocations[0].amountLamports + remainder };
      }
    }

    const effectiveVoterPotLamports = allocations.length > 0 ? initialVoterPotLamports : 0;
    const voterPotToTreasuryLamports = Math.max(0, plannedVoterPotLamports - effectiveVoterPotLamports);

    const distribution = {
      id: distributionId,
      commitmentId,
      milestoneId,
      createdAtUnix: nowUnix,
      forfeitedLamports,
      buybackLamports,
      voterPotLamports: effectiveVoterPotLamports,
      shipBuybackTreasuryPubkey: treasury.toBase58(),
      buybackTxSig: "pending",
      voterPotTxSig: undefined,
      status: "open" as const,
    };

    const acquired = await tryAcquireMilestoneFailureDistributionCreate({ distribution });
    const existing = !acquired.acquired ? acquired.existing : null;

    if (existing) {
      const expectedVoterPotToTreasury = Math.max(0, (existing.forfeitedLamports - existing.buybackLamports) - existing.voterPotLamports);
      if (
        existing.forfeitedLamports !== forfeitedLamports ||
        existing.buybackLamports !== buybackLamports ||
        existing.voterPotLamports !== effectiveVoterPotLamports ||
        existing.shipBuybackTreasuryPubkey !== treasury.toBase58() ||
        expectedVoterPotToTreasury !== voterPotToTreasuryLamports
      ) {
        return NextResponse.json(
          {
            error: "Existing milestone failure distribution has mismatched parameters",
            existing,
            expected: {
              forfeitedLamports,
              buybackLamports,
              voterPotLamports: effectiveVoterPotLamports,
              shipBuybackTreasuryPubkey: treasury.toBase58(),
              voterPotToTreasuryLamports,
            },
          },
          { status: 409 }
        );
      }
    }

    const distributionToUse = existing ?? distribution;
    const allocationsForDb = allocations.map((a) => ({ ...a, distributionId: distributionToUse.id }));

    await insertMilestoneFailureDistributionAllocations({
      distributionId: distributionToUse.id,
      allocations: allocationsForDb,
    });

    const shouldTreatAsUnsetSig = (sig: string | undefined | null) => {
      const t = String(sig ?? "").trim();
      if (!t) return true;
      if (t === "pending" || t === "none") return true;
      return false;
    };

    let buybackTxSig: string | null = shouldTreatAsUnsetSig(distributionToUse.buybackTxSig) ? null : String(distributionToUse.buybackTxSig);
    let voterPotTxSig: string | null = distributionToUse.voterPotTxSig ? String(distributionToUse.voterPotTxSig) : null;

    if (buybackLamports > 0 && buybackTxSig == null) {
      const found = await findRecentSystemTransferSignature({
        connection,
        fromPubkey: escrowPk,
        toPubkey: treasury,
        lamports: buybackLamports,
        limit: 50,
      });
      if (found) {
        buybackTxSig = found;
      } else {
        const buybackTx =
          escrowRef.kind === "privy"
            ? await transferLamportsFromPrivyWallet({ connection, walletId: escrowRef.walletId, fromPubkey: escrowPk, to: treasury, lamports: buybackLamports })
            : await transferLamports({ connection, from: keypairFromBase58Secret(escrowRef.escrowSecretKeyB58), to: treasury, lamports: buybackLamports });
        buybackTxSig = buybackTx.signature;
      }
    }

    if (voterPotToTreasuryLamports > 0 && voterPotTxSig == null) {
      const found = await findRecentSystemTransferSignature({
        connection,
        fromPubkey: escrowPk,
        toPubkey: treasury,
        lamports: voterPotToTreasuryLamports,
        limit: 50,
      });
      if (found && (!buybackTxSig || found !== buybackTxSig)) {
        voterPotTxSig = found;
      } else {
        const tx =
          escrowRef.kind === "privy"
            ? await transferLamportsFromPrivyWallet({
                connection,
                walletId: escrowRef.walletId,
                fromPubkey: escrowPk,
                to: treasury,
                lamports: voterPotToTreasuryLamports,
              })
            : await transferLamports({
                connection,
                from: keypairFromBase58Secret(escrowRef.escrowSecretKeyB58),
                to: treasury,
                lamports: voterPotToTreasuryLamports,
              });
        voterPotTxSig = tx.signature;
      }
    }

    await setMilestoneFailureDistributionTxSigs({
      distributionId: distributionToUse.id,
      buybackTxSig: buybackTxSig,
      voterPotTxSig: voterPotTxSig,
    });

    await auditLog("admin_milestone_failure_distribution_ok", {
      commitmentId,
      milestoneId,
      distributionId: distributionToUse.id,
      forfeitedLamports,
      buybackLamports,
      voterPotLamports: effectiveVoterPotLamports,
      participationWeighted: participationEnabled,
      buybackTxSig,
      voterPotTxSig,
    });

    return NextResponse.json({
      ok: true,
      nowUnix,
      distributionId: distributionToUse.id,
      forfeitedLamports,
      buyback: {
        treasury: treasury.toBase58(),
        lamports: buybackLamports,
        signature: buybackTxSig,
      },
      voterPot: {
        lamports: effectiveVoterPotLamports,
        allocations: allocationsForDb.length,
        txSig: voterPotTxSig,
      },
    });
  } catch (e) {
    await auditLog("admin_milestone_failure_distribution_error", {
      commitmentId: ctx.params.id,
      milestoneId: ctx.params.milestoneId,
      error: getSafeErrorMessage(e),
    });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
