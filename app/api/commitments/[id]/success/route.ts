import { NextResponse } from "next/server";

import { isAdminRequestAsync } from "../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../lib/adminSession";
import { checkRateLimit } from "../../../../lib/rateLimit";
import { auditLog } from "../../../../lib/auditLog";
import { apiError } from "../../../../lib/apiError";
import { settlePersonalCommitment, toResponse } from "../../../../lib/payoutClaimStore";
import { getSafeErrorMessage } from "../../../../lib/safeError";

export const runtime = "nodejs";

/** Admin: settle a personal commitment as successful before its deadline - the whole escrow goes back to its authority, exactly once. */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "commitment:success", limit: 30, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    verifyAdminOrigin(req);
    if (!(await isAdminRequestAsync(req))) {
      await auditLog("admin_commitment_success_denied", { commitmentId: ctx.params.id });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await settlePersonalCommitment({ commitmentId: ctx.params.id, outcome: "success" });
    return toResponse(result);
  } catch (e) {
    await auditLog("admin_commitment_success_error", { commitmentId: ctx.params.id, error: getSafeErrorMessage(e) }).catch(() => null);
    return apiError(e, "commitment/success");
  }
}
