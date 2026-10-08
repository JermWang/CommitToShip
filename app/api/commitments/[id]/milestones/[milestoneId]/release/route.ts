import { NextResponse } from "next/server";

import { isAdminRequestAsync } from "../../../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../../../lib/adminSession";
import { checkRateLimit } from "../../../../../../lib/rateLimit";
import { auditLog } from "../../../../../../lib/auditLog";
import { apiError } from "../../../../../../lib/apiError";
import { runMilestonePayout, toResponse } from "../../../../../../lib/payoutClaimStore";
import { getSafeErrorMessage } from "../../../../../../lib/safeError";

export const runtime = "nodejs";

function isRewardPayoutsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_REWARD_PAYOUTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  const id = ctx.params.id;
  const milestoneId = ctx.params.milestoneId;

  try {
    const rl = await checkRateLimit(req, { keyPrefix: "milestone:release", limit: 30, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    if (!isRewardPayoutsEnabled()) {
      return NextResponse.json(
        {
          error: "Reward payouts are disabled",
          hint: "Set CTS_ENABLE_REWARD_PAYOUTS=1 (or true) to enable milestone releases.",
        },
        { status: 503 }
      );
    }

    verifyAdminOrigin(req);
    if (!(await isAdminRequestAsync(req))) {
      await auditLog("admin_reward_milestone_release_denied", { commitmentId: id, milestoneId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await runMilestonePayout({ commitmentId: id, milestoneId, auditPrefix: "admin_reward_milestone_release" });
    return toResponse(result);
  } catch (e) {
    await auditLog("admin_reward_milestone_release_error", { commitmentId: id, milestoneId, error: getSafeErrorMessage(e) }).catch(() => null);
    return apiError(e, "milestone/release");
  }
}
