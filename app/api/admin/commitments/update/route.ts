import { NextResponse } from "next/server";

import { isAdminRequestAsync } from "../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../lib/adminSession";
import { auditLog } from "../../../../lib/auditLog";
import { checkRateLimit } from "../../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../../lib/safeError";
import { getCommitment, publicView, updateCommitmentAdminFields } from "../../../../lib/escrowStore";

export const runtime = "nodejs";

function isCronAuthorized(req: Request): boolean {
  const secret = String(process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = String(req.headers.get("x-cron-secret") ?? "").trim();
  if (!header) return false;
  return header === secret;
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "admin:commitments:update", limit: 30, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const cronOk = isCronAuthorized(req);
    if (!cronOk) {
      verifyAdminOrigin(req);
      if (!(await isAdminRequestAsync(req))) {
        await auditLog("admin_commitment_update_denied", { reason: "unauthorized" });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const body = (await req.json().catch(() => null)) as any;
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const statusRaw = body?.status;
    const status = typeof statusRaw === "string" ? statusRaw.trim() : undefined;

    const creatorFeeModeRaw = body?.creatorFeeMode;
    const creatorFeeMode =
      creatorFeeModeRaw == null
        ? creatorFeeModeRaw
        : typeof creatorFeeModeRaw === "string"
          ? creatorFeeModeRaw.trim()
          : undefined;

    if (
      status != null &&
      status !== "created" &&
      status !== "resolving" &&
      status !== "resolved_success" &&
      status !== "resolved_failure" &&
      status !== "active" &&
      status !== "completed" &&
      status !== "failed" &&
      status !== "archived"
    ) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    if (creatorFeeMode !== undefined && creatorFeeMode !== null && creatorFeeMode !== "managed" && creatorFeeMode !== "assisted") {
      return NextResponse.json({ error: "Invalid creatorFeeMode" }, { status: 400 });
    }

    const existing = await getCommitment(id);
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const updated = await updateCommitmentAdminFields({
      id,
      status: status as any,
      creatorFeeMode: creatorFeeMode as any,
    });

    await auditLog("admin_commitment_update_ok", {
      id,
      status: status ?? null,
      creatorFeeMode: creatorFeeMode ?? null,
    });

    return NextResponse.json({ ok: true, commitment: publicView(updated) });
  } catch (e) {
    await auditLog("admin_commitment_update_error", { error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
