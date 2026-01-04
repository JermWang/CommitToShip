import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import {
  CommitmentRecord,
  RewardMilestone,
  getCommitment,
  getRewardApprovalThreshold,
  getRewardMilestoneVoteCounts,
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
          c.destinationOnFail === walletPubkey ||
          (treasuryWallet ? c.authority === treasuryWallet : false) ||
          (treasuryWallet ? c.destinationOnFail === treasuryWallet : false))
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
      totalEarnedLamports += commitment.totalFundedLamports ?? 0;
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

      const withdrawals = normalized.milestones
        .filter((m) => m.status === "released" && m.releasedTxSig)
        .map((m) => ({
          milestoneId: m.id,
          milestoneTitle: m.title,
          amountLamports: m.unlockLamports,
          releasedAtUnix: m.releasedAtUnix,
          txSig: m.releasedTxSig,
          solscanUrl: `https://solscan.io/tx/${m.releasedTxSig}`,
        }));

      projects.push({
        commitment: publicView(commitment),
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
