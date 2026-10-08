import { NextResponse } from "next/server";

import { isAdminRequestAsync } from "../../../../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../../../../lib/adminSession";
import { auditLog } from "../../../../../../../lib/auditLog";
import { checkRateLimit } from "../../../../../../../lib/rateLimit";
import { apiError } from "../../../../../../../lib/apiError";
import { getSafeErrorMessage } from "../../../../../../../lib/safeError";
import { createVoteRewardDistributionForMilestone, isVoteRewardDistributionsEnabled } from "../../../../../../../lib/voteRewardDistributions";

export const runtime = "nodejs";

/**
 * Admin: create the $SHIP vote reward distribution for a milestone whose vote window has closed.
 * Shares one implementation with the lazy path (lib/voteRewardDistributions.ts): close-time holder re-check first,
 * BigInt allocation, distribution + allocations written atomically with the pool cap enforced in SQL. Idempotent.
 */
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

    const r = await createVoteRewardDistributionForMilestone({ commitmentId, milestoneId });
    if (!r.ok) {
      return NextResponse.json({ error: r.error, code: r.code, ...(r.details ?? {}) }, { status: r.status });
    }

    await auditLog("admin_vote_reward_distribution_ok", {
      commitmentId,
      milestoneId,
      distributionId: r.distribution.id,
      created: r.created,
      mintPubkey: r.distribution.mintPubkey,
      poolAmountRaw: r.distribution.poolAmountRaw,
      allocations: r.allocations,
    });

    return NextResponse.json({
      ok: true,
      nowUnix: r.nowUnix,
      created: r.created,
      distributionId: r.distribution.id,
      commitmentId,
      milestoneId,
      mintPubkey: r.distribution.mintPubkey,
      poolAmountRaw: r.distribution.poolAmountRaw,
      allocations: r.allocations,
    });
  } catch (e) {
    await auditLog("admin_vote_reward_distribution_error", {
      commitmentId: ctx.params.id,
      milestoneId: ctx.params.milestoneId,
      error: getSafeErrorMessage(e),
    });
    return apiError(e, "vote-reward/create");
  }
}
