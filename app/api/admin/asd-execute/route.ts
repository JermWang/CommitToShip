import { NextResponse } from "next/server";

import { auditLog } from "../../../lib/auditLog";
import { isAdminRequestAsync } from "../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { checkRateLimit } from "../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { getAsdConfig, listActiveAsdConfigs } from "../../../lib/asdStore";
import { AsdRunResult, asdSwapsEnabled, runAsdForCommitment } from "../../../lib/asdExecution";
import { isCronAuthorized } from "../../../lib/cronAuth";
import { apiError } from "../../../lib/apiError";

export const runtime = "nodejs";

/**
 * Cron/admin: run ASD for every active config (or one `commitmentId`). Safe to call concurrently / overlapping:
 * each commitment's interval is won by a single atomic conditional UPDATE (asdStore.claimAsdExecutionSlot), and any
 * swap or forward whose outcome is still unknown is resolved by signature before anything new is sent.
 * See lib/asdExecution.ts for the full flow.
 */
export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "admin:asd-execute", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const cronOk = isCronAuthorized(req);
    if (!cronOk) {
      verifyAdminOrigin(req);
      if (!(await isAdminRequestAsync(req))) {
        await auditLog("admin_asd_execute_denied", {});
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const body = (await req.json().catch(() => null)) as any;
    const commitmentIdFilter = typeof body?.commitmentId === "string" ? body.commitmentId.trim() : "";
    const limitRaw = body?.limit != null ? Number(body.limit) : undefined;
    const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;

    const nowUnix = Math.floor(Date.now() / 1000);

    const ids = commitmentIdFilter
      ? (await getAsdConfig(commitmentIdFilter))
        ? [commitmentIdFilter]
        : []
      : (await listActiveAsdConfigs({ limit })).map((c) => c.commitmentId);

    if (commitmentIdFilter && !ids.length) {
      return NextResponse.json({ ok: true, nowUnix, swapsEnabled: asdSwapsEnabled(), results: [{ commitmentId: commitmentIdFilter, ok: false, error: "ASD config not found" }] });
    }

    const results: AsdRunResult[] = [];
    for (const commitmentId of ids) {
      try {
        results.push(await runAsdForCommitment({ commitmentId, nowUnix }));
      } catch (e) {
        results.push({ commitmentId, ok: false, error: getSafeErrorMessage(e) });
      }
    }

    await auditLog("admin_asd_execute_completed", {
      cron: cronOk,
      count: results.length,
      swapsEnabled: asdSwapsEnabled(),
      results: results.map((r) => ({ commitmentId: r.commitmentId, ok: r.ok, reason: r.reason ?? null, txSig: r.txSig ?? null, forward: r.forward?.txSig ?? null })),
    });

    return NextResponse.json({ ok: true, nowUnix, swapsEnabled: asdSwapsEnabled(), results });
  } catch (e) {
    await auditLog("admin_asd_execute_error", { error: getSafeErrorMessage(e) });
    return apiError(e, "admin/asd-execute");
  }
}
