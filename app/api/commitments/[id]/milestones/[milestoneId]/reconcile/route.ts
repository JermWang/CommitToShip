import { NextResponse } from "next/server";

import { isAdminRequestAsync } from "../../../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../../../lib/adminSession";
import { auditLog } from "../../../../../../lib/auditLog";
import { checkRateLimit } from "../../../../../../lib/rateLimit";
import { apiError } from "../../../../../../lib/apiError";
import { reconcileMilestonePayout, toResponse } from "../../../../../../lib/payoutClaimStore";
import { getSafeErrorMessage } from "../../../../../../lib/safeError";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  const id = ctx.params.id;
  const milestoneId = ctx.params.milestoneId;

  try {
    const rl = await checkRateLimit(req, { keyPrefix: "milestone:reconcile", limit: 30, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    verifyAdminOrigin(req);
    if (!(await isAdminRequestAsync(req))) {
      await auditLog("admin_reward_milestone_reconcile_denied", { commitmentId: id, milestoneId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as any;
    const result = await reconcileMilestonePayout({ commitmentId: id, milestoneId, forceReset: body?.forceReset === true });
    return toResponse(result);
  } catch (e) {
    await auditLog("admin_reward_milestone_reconcile_error", { commitmentId: id, milestoneId, error: getSafeErrorMessage(e) }).catch(() => null);
    return apiError(e, "milestone/reconcile");
  }
}
