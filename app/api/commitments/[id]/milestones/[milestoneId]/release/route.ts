import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { isAdminRequestAsync } from "../../../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../../../lib/adminSession";
import {
  RewardMilestone,
  getCommitment,
  getEscrowSecretKeyB58,
  getRewardApprovalThreshold,
  getRewardMilestoneApprovalCounts,
  normalizeRewardMilestonesClaimable,
  publicView,
  sumReleasedLamports,
  updateRewardTotalsAndMilestones,
} from "../../../../../../lib/escrowStore";
import { getBalanceLamports, getChainUnixTime, getConnection, keypairFromBase58Secret, transferLamports } from "../../../../../../lib/solana";
import { releaseRewardReleaseLock, setRewardReleaseLockTxSig, tryAcquireRewardReleaseLock } from "../../../../../../lib/rewardReleaseLock";
import { getSafeErrorMessage } from "../../../../../../lib/safeError";

export const runtime = "nodejs";

function computeUnlockedLamports(milestones: RewardMilestone[]): number {
  return milestones.reduce((acc, m) => {
    if (m.status === "claimable" || m.status === "released") return acc + Number(m.unlockLamports || 0);
    return acc;
  }, 0);
}

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  verifyAdminOrigin(req);
  if (!(await isAdminRequestAsync(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = ctx.params.id;
  const milestoneId = ctx.params.milestoneId;

  try {
    const record = await getCommitment(id);
    if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (record.kind !== "creator_reward") {
      return NextResponse.json({ error: "Not a reward commitment" }, { status: 400 });
    }

    if (!record.creatorPubkey) {
      return NextResponse.json({ error: "Missing creator pubkey" }, { status: 500 });
    }

    const connection = getConnection();
    const escrowPk = new PublicKey(record.escrowPubkey);

    const [balanceLamports, nowUnix] = await Promise.all([
      getBalanceLamports(connection, escrowPk),
      getChainUnixTime(connection),
    ]);

    const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
    const idx = milestones.findIndex((m: RewardMilestone) => m.id === milestoneId);
    if (idx < 0) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });

    const approvalCounts = await getRewardMilestoneApprovalCounts(id);
    const approvalThreshold = getRewardApprovalThreshold();
    const normalized = normalizeRewardMilestonesClaimable({ milestones, nowUnix, approvalCounts, approvalThreshold });
    let effectiveMilestones = normalized.milestones;

    const m = effectiveMilestones[idx];

    if (m.status === "released") {
      return NextResponse.json({ error: "Already released", commitment: publicView(record) }, { status: 409 });
    }

    if (m.status !== "claimable") {
      return NextResponse.json({
        error: "Milestone not claimable",
        nowUnix,
        milestone: m,
        commitment: publicView(record),
      }, { status: 400 });
    }

    const unlockLamports = Number(m.unlockLamports);
    if (!Number.isFinite(unlockLamports) || unlockLamports <= 0) {
      return NextResponse.json({ error: "Invalid milestone unlock amount" }, { status: 500 });
    }

    if (balanceLamports < unlockLamports) {
      return NextResponse.json(
        {
          error: "Escrow underfunded for this release",
          balanceLamports,
          requiredLamports: unlockLamports,
          commitment: publicView(record),
        },
        { status: 400 }
      );
    }

    const lock = await tryAcquireRewardReleaseLock({ commitmentId: id, milestoneId });
    if (!lock.acquired) {
      return NextResponse.json(
        {
          error: "Release already in progress (or already executed)",
          existing: lock.existing,
        },
        { status: 409 }
      );
    }

    const escrow = keypairFromBase58Secret(getEscrowSecretKeyB58(record));
    const to = new PublicKey(record.creatorPubkey);

    try {
      const { signature } = await transferLamports({
        connection,
        from: escrow,
        to,
        lamports: unlockLamports,
      });

      await setRewardReleaseLockTxSig({ commitmentId: id, milestoneId, txSig: signature });

      effectiveMilestones[idx] = {
        ...m,
        status: "released",
        releasedAtUnix: nowUnix,
        releasedTxSig: signature,
      };

      const unlockedLamports = computeUnlockedLamports(effectiveMilestones);

      const releasedLamports = sumReleasedLamports(effectiveMilestones);
      const totalFundedLamports = Math.max(record.totalFundedLamports ?? 0, balanceLamports + releasedLamports);

      const allReleased = effectiveMilestones.length > 0 && effectiveMilestones.every((x) => x.status === "released");

      const updated = await updateRewardTotalsAndMilestones({
        id,
        milestones: effectiveMilestones,
        unlockedLamports,
        totalFundedLamports,
        status: allReleased ? "completed" : "active",
      });

      await releaseRewardReleaseLock({ commitmentId: id, milestoneId });

      return NextResponse.json({
        ok: true,
        nowUnix,
        signature,
        commitment: publicView(updated),
      });
    } catch (e) {
      await releaseRewardReleaseLock({ commitmentId: id, milestoneId });
      return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
    }
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
