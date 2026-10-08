import { NextResponse } from "next/server";

import { isAdminRequestAsync } from "../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { checkRateLimit } from "../../../lib/rateLimit";
import { auditLog } from "../../../lib/auditLog";
import { apiError } from "../../../lib/apiError";
import { listCommitments } from "../../../lib/escrowStore";
import { getChainUnixTime, getConnection } from "../../../lib/solana";
import { settlePersonalCommitment } from "../../../lib/payoutClaimStore";
import { getSafeErrorMessage } from "../../../lib/safeError";

export const runtime = "nodejs";

function isCronAuthorized(req: Request): boolean {
  void req;
  return false;
}

/**
 * Admin: settle every personal commitment whose deadline passed (status created, or stuck in resolving) as failed.
 * Each escrow pays its destinationOnFail exactly once (see settlePersonalCommitment).
 */
export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "commitments:sweep", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const cronOk = isCronAuthorized(req);
    if (!cronOk) {
      verifyAdminOrigin(req);
      if (!(await isAdminRequestAsync(req))) {
        await auditLog("admin_sweep_denied", {});
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);

    const commitments = await listCommitments();

    const results: Array<{ id: string; status: string; signature?: string | null; error?: string }> = [];

    for (const c of commitments) {
      if (c.kind !== "personal") continue;
      if (c.status !== "created" && c.status !== "resolving") continue;
      if (nowUnix <= c.deadlineUnix) continue;

      try {
        const r = await settlePersonalCommitment({ commitmentId: c.id, outcome: "failure" });
        if (r.status === 200) {
          results.push({ id: c.id, status: "resolved_failure", signature: String(r.body.signature ?? "") || null });
        } else {
          results.push({ id: c.id, status: r.status === 202 ? "pending" : "error", signature: (r.body.signature as string | null | undefined) ?? null, error: String(r.body.error ?? "") });
        }
      } catch (e) {
        results.push({ id: c.id, status: "error", error: getSafeErrorMessage(e) });
      }
    }

    await auditLog("admin_sweep_completed", { nowUnix, resultsCount: results.length });
    return NextResponse.json({ nowUnix, results });
  } catch (e) {
    await auditLog("admin_sweep_error", { error: getSafeErrorMessage(e) }).catch(() => null);
    return apiError(e, "commitments/sweep");
  }
}
