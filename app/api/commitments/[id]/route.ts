import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import {
  RewardMilestone,
  getCommitment,
  getRewardApprovalThreshold,
  getRewardMilestoneApprovalCounts,
  normalizeRewardMilestonesClaimable,
  publicView,
  sumReleasedLamports,
  updateRewardTotalsAndMilestones,
} from "../../../lib/escrowStore";
import { getBalanceLamports, getChainUnixTime, getConnection } from "../../../lib/solana";
import { getSafeErrorMessage } from "../../../lib/safeError";

export const runtime = "nodejs";

function computeUnlockedLamports(milestones: RewardMilestone[]): number {
  return milestones.reduce((acc, m) => {
    if (m.status === "claimable" || m.status === "released") return acc + Number(m.unlockLamports || 0);
    return acc;
  }, 0);
}

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  try {
    const id = ctx.params.id;
    const record = await getCommitment(id);
    if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const connection = getConnection();
    const escrowPk = new PublicKey(record.escrowPubkey);

    const [balanceLamports, nowUnix] = await Promise.all([
      getBalanceLamports(connection, escrowPk),
      getChainUnixTime(connection),
    ]);

    if (record.kind === "creator_reward") {
      const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
      const approvalCounts = await getRewardMilestoneApprovalCounts(id);
      const approvalThreshold = getRewardApprovalThreshold();
      const normalized = normalizeRewardMilestonesClaimable({ milestones, nowUnix, approvalCounts, approvalThreshold });
      const unlockedLamports = computeUnlockedLamports(normalized.milestones);

      const releasedLamports = sumReleasedLamports(normalized.milestones);
      const totalFundedLamports = Math.max(record.totalFundedLamports ?? 0, balanceLamports + releasedLamports);

      const allReleased = normalized.milestones.length > 0 && normalized.milestones.every((m) => m.status === "released");
      const nextStatus = allReleased ? "completed" : (record.status === "completed" ? "completed" : "active");

      const shouldPersist =
        normalized.changed ||
        unlockedLamports !== Number(record.unlockedLamports ?? 0) ||
        totalFundedLamports !== Number(record.totalFundedLamports ?? 0) ||
        nextStatus !== record.status;

      const updated = shouldPersist
        ? await updateRewardTotalsAndMilestones({
            id,
            milestones: normalized.milestones,
            unlockedLamports,
            totalFundedLamports,
            status: nextStatus,
          })
        : record;

      return NextResponse.json({
        commitment: publicView(updated),
        reward: {
          approvalCounts,
          approvalThreshold,
        },
        escrow: {
          balanceLamports,
          funded: balanceLamports > 0,
          expired: false,
          nowUnix,
        },
      });
    }

    const funded = balanceLamports >= record.amountLamports;
    const expired = nowUnix > record.deadlineUnix;

    return NextResponse.json({
      commitment: publicView(record),
      escrow: {
        balanceLamports,
        funded,
        expired,
        nowUnix,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
