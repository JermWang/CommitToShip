import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import {
  CommitmentRecord,
  RewardMilestone,
  getCommitment,
  getRewardApprovalThreshold,
  getRewardMilestoneVoteCounts,
  getRewardMilestonePayoutClaim,
  listMilestoneFailureDistributionsByCommitmentId,
  listMilestoneFailureDistributionClaims,
  listCommitments,
  normalizeRewardMilestonesClaimable,
  publicView,
  sumReleasedLamports,
} from "../../../lib/escrowStore";
import { checkRateLimit } from "../../../lib/rateLimit";
import { getBalanceLamports, getChainUnixTime, getConnection } from "../../../lib/solana";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { getProjectProfile } from "../../../lib/projectProfilesStore";
import { getLaunchTreasuryWallet } from "../../../lib/launchTreasuryStore";

export const runtime = "nodejs";

function computeUnlockedLamports(milestones: RewardMilestone[]): number {
  return milestones.reduce((acc, m) => {
    if (m.status === "claimable" || m.status === "released") return acc + Number(m.unlockLamports || 0);
    return acc;
  }, 0);
}

function effectiveUnlockLamports(m: RewardMilestone, totalFundedLamports: number): number {
  const explicit = Number(m.unlockLamports ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const pct = Number((m as any).unlockPercent ?? 0);
  const total = Number(totalFundedLamports ?? 0);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.floor((total * pct) / 100);
}

function solscanTxUrl(sig: string): string {
  const base = `https://solscan.io/tx/${encodeURIComponent(sig)}`;
  const c = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "mainnet-beta").trim();
  if (!c || c === "mainnet-beta") return base;
  return `${base}?cluster=${encodeURIComponent(c)}`;
}

function normalizeTxSig(sig: string | null | undefined): string | null {
  const t = String(sig ?? "").trim();
  if (!t) return null;
  const lowered = t.toLowerCase();
  if (lowered === "pending" || lowered === "none") return null;
  return t;
}

export async function GET(_req: Request, ctx: { params: { wallet: string } }) {
  try {
    const rl = await checkRateLimit(_req, { keyPrefix: "creator:get", limit: 60, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const walletParam = ctx.params.wallet;
    let walletPubkey: string;
    try {
      walletPubkey = new PublicKey(walletParam).toBase58();
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    let treasuryWallet: string | null = null;
    try {
      const treasury = await getLaunchTreasuryWallet(walletPubkey);
      treasuryWallet = treasury?.treasuryWallet ?? null;
    } catch {
      treasuryWallet = null;
    }

    const allCommitments = await listCommitments();
    const creatorCommitments = allCommitments.filter(
      (c) =>
        c.status !== "archived" &&
        (c.creatorPubkey === walletPubkey ||
          c.authority === walletPubkey ||
          (c.kind === "personal" && c.destinationOnFail === walletPubkey) ||
          (treasuryWallet ? c.authority === treasuryWallet : false) ||
          (treasuryWallet ? (c.kind === "personal" && c.destinationOnFail === treasuryWallet) : false))
    );

    if (creatorCommitments.length === 0) {
      return NextResponse.json({
        wallet: walletPubkey,
        projects: [],
        summary: {
          totalProjects: 0,
          activeProjects: 0,
          completedProjects: 0,
          failedProjects: 0,
          totalMilestones: 0,
          completedMilestones: 0,
          releasedMilestones: 0,
          claimableMilestones: 0,
          totalEarnedLamports: 0,
          totalReleasedLamports: 0,
          totalClaimableLamports: 0,
          totalPendingLamports: 0,
        },
      });
    }

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);
    const approvalThreshold = getRewardApprovalThreshold();

    const projects: any[] = [];
    let totalMilestones = 0;
    let completedMilestones = 0;
    let releasedMilestones = 0;
    let claimableMilestones = 0;
    let totalEarnedLamports = 0;
    let totalReleasedLamports = 0;
    let totalClaimableLamports = 0;
    let totalPendingLamports = 0;

    for (const commitment of creatorCommitments) {
      if (commitment.kind !== "creator_reward") continue;

      const milestones: RewardMilestone[] = Array.isArray(commitment.milestones)
        ? (commitment.milestones.slice() as RewardMilestone[])
        : [];

      const voteCounts = await getRewardMilestoneVoteCounts(commitment.id);
      const approvalCounts = voteCounts.approvalCounts;
      const normalized = normalizeRewardMilestonesClaimable({
        milestones,
        nowUnix,
        approvalCounts,
        rejectCounts: voteCounts.rejectCounts,
        approvalThreshold,
      });

      const escrowPk = new PublicKey(commitment.escrowPubkey);
      let balanceLamports = 0;
      try {
        balanceLamports = await getBalanceLamports(connection, escrowPk);
      } catch {
        // Ignore balance fetch errors
      }

      const releasedLamports = sumReleasedLamports(normalized.milestones);
      const unlockedLamports = computeUnlockedLamports(normalized.milestones);
      const earnedLamports = Math.max(0, balanceLamports + releasedLamports);
      const claimableLamports = normalized.milestones
        .filter((m) => m.status === "claimable")
        .reduce((acc, m) => acc + Number(m.unlockLamports || 0), 0);
      const pendingLamports = normalized.milestones
        .filter((m) => m.status === "locked")
        .reduce((acc, m) => acc + Number(m.unlockLamports || 0), 0);

      const milestonesTotal = normalized.milestones.length;
      const milestonesCompleted = normalized.milestones.filter(
        (m) => m.completedAtUnix != null
      ).length;
      const milestonesReleased = normalized.milestones.filter(
        (m) => m.status === "released"
      ).length;
      const milestonesClaimable = normalized.milestones.filter(
        (m) => m.status === "claimable"
      ).length;

      totalMilestones += milestonesTotal;
      completedMilestones += milestonesCompleted;
      releasedMilestones += milestonesReleased;
      claimableMilestones += milestonesClaimable;
      totalEarnedLamports += earnedLamports;
      totalReleasedLamports += releasedLamports;
      totalClaimableLamports += claimableLamports;
      totalPendingLamports += pendingLamports;

      let projectProfile = null;
      if (commitment.tokenMint) {
        try {
          projectProfile = await getProjectProfile(commitment.tokenMint);
        } catch {
          // Ignore profile fetch errors
        }
      }

      const withdrawals: any[] = [];
      for (const m of normalized.milestones) {
        const releasedTxSig = normalizeTxSig((m as any).releasedTxSig);
        let txSig: string | null = releasedTxSig;
        let claim: any = null;

        if (!txSig) {
          claim = await getRewardMilestonePayoutClaim({ commitmentId: commitment.id, milestoneId: m.id });
          txSig = normalizeTxSig(claim?.txSig ?? null);
        }

        if (!txSig) continue;

        const releasedAtUnix = Number((m as any).releasedAtUnix ?? 0);
        const claimCreatedAtUnix = Number(claim?.createdAtUnix ?? 0);
        const unix = releasedAtUnix > 0 ? releasedAtUnix : claimCreatedAtUnix > 0 ? claimCreatedAtUnix : 0;

        const amountLamports = Number.isFinite(Number(claim?.amountLamports)) && Number(claim?.amountLamports) > 0
          ? Number(claim?.amountLamports)
          : effectiveUnlockLamports(m, Number(commitment.totalFundedLamports ?? 0));

        withdrawals.push({
          milestoneId: m.id,
          milestoneTitle: m.title,
          amountLamports,
          releasedAtUnix: unix > 0 ? unix : undefined,
          txSig,
          solscanUrl: solscanTxUrl(txSig),
        });
      }

      const failureDistributions = await listMilestoneFailureDistributionsByCommitmentId(commitment.id);
      const failureTransfers = failureDistributions
        .flatMap((d) => {
          const out: any[] = [];
          const buybackTxSig = normalizeTxSig(d.buybackTxSig);
          if (buybackTxSig) {
            out.push({
              kind: "milestone_failure_buyback",
              milestoneId: d.milestoneId,
              distributionId: d.id,
              amountLamports: Number(d.buybackLamports ?? 0),
              createdAtUnix: Number(d.createdAtUnix ?? 0),
              txSig: buybackTxSig,
              solscanUrl: solscanTxUrl(buybackTxSig),
            });
          }

          const voterPotTxSig = normalizeTxSig(d.voterPotTxSig);
          const voterPotToTreasuryLamports = Math.max(0, Number(d.forfeitedLamports ?? 0) - Number(d.buybackLamports ?? 0) - Number(d.voterPotLamports ?? 0));
          if (voterPotTxSig) {
            out.push({
              kind: "milestone_failure_voter_pot_to_treasury",
              milestoneId: d.milestoneId,
              distributionId: d.id,
              amountLamports: voterPotToTreasuryLamports,
              createdAtUnix: Number(d.createdAtUnix ?? 0),
              txSig: voterPotTxSig,
              solscanUrl: solscanTxUrl(voterPotTxSig),
            });
          }

          return out;
        })
        .filter((x) => Number(x.amountLamports ?? 0) > 0);

      const voterPayouts: any[] = [];
      for (const d of failureDistributions) {
        const claims = await listMilestoneFailureDistributionClaims({ distributionId: d.id });
        for (const c of claims) {
          const txSig = normalizeTxSig(c.txSig);
          if (!txSig) continue;
          voterPayouts.push({
            kind: "milestone_failure_voter_claim",
            milestoneId: d.milestoneId,
            distributionId: d.id,
            walletPubkey: c.walletPubkey,
            claimedAtUnix: c.claimedAtUnix,
            amountLamports: c.amountLamports,
            txSig,
            solscanUrl: solscanTxUrl(txSig),
          });
        }
      }

      projects.push({
        commitment: publicView({
          ...commitment,
          totalFundedLamports: earnedLamports,
        }),
        projectProfile,
        escrow: {
          balanceLamports,
          releasedLamports,
          unlockedLamports,
          claimableLamports,
          pendingLamports,
        },
        milestones: normalized.milestones.map((m, idx) => ({
          ...m,
          index: idx + 1,
          approvalCount: approvalCounts[m.id] ?? 0,
          approvalThreshold,
        })),
        stats: {
          milestonesTotal,
          milestonesCompleted,
          milestonesReleased,
          milestonesClaimable,
        },
        withdrawals,
        failureTransfers,
        voterPayouts,
        approvalCounts,
        approvalThreshold,
      });
    }

    const activeProjects = projects.filter(
      (p) => p.commitment.status === "active" || p.commitment.status === "created"
    ).length;
    const completedProjects = projects.filter(
      (p) => p.commitment.status === "completed" || p.commitment.status === "resolved_success"
    ).length;
    const failedProjects = projects.filter(
      (p) => p.commitment.status === "failed" || p.commitment.status === "resolved_failure"
    ).length;

    return NextResponse.json({
      wallet: walletPubkey,
      projects: projects.sort((a, b) => b.commitment.createdAtUnix - a.commitment.createdAtUnix),
      summary: {
        totalProjects: projects.length,
        activeProjects,
        completedProjects,
        failedProjects,
        totalMilestones,
        completedMilestones,
        releasedMilestones,
        claimableMilestones,
        totalEarnedLamports,
        totalReleasedLamports,
        totalClaimableLamports,
        totalPendingLamports,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
