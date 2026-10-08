import { NextResponse } from "next/server";

import { isAdminRequestAsync } from "../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { checkRateLimit } from "../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { listCommitments } from "../../../lib/escrowStore";
import { sweepManagedCreatorFeesToEscrow } from "../../../lib/escrowSweep";
import { auditLog } from "../../../lib/auditLog";
import { apiError } from "../../../lib/apiError";

export const runtime = "nodejs";

function isCronAuthorized(req: Request): boolean {
  void req;
  return false;
}

async function sweepOne(commitmentId: string, actor: { kind: "cron" | "admin" } | null): Promise<any> {
  return await sweepManagedCreatorFeesToEscrow({
    commitmentId,
    actor: actor ?? { kind: "admin" },
  });
}

/**
 * POST /api/escrow/sweep
 * 
 * Auto-escrow flow for managed commitments:
 * 1. Check if the commitment uses a Privy-managed creator wallet
 * 2. Check claimable creator fees in the Pump.fun creator vault
 * 3. Claim fees to the creator wallet
 * 4. Transfer claimed fees to the escrow address
 * 5. Update commitment totals
 * 
 * This should be called periodically (cron) or triggered after trades.
 */
export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "escrow:sweep", limit: 30, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const cronOk = isCronAuthorized(req);

    if (!cronOk) {
      verifyAdminOrigin(req);
      const adminOk = await isAdminRequestAsync(req);
      if (!adminOk) {
        await auditLog("escrow_sweep_denied", { reason: "unauthorized" });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const body = (await req.json().catch(() => ({}))) as any;
    const commitmentId = typeof body.commitmentId === "string" ? body.commitmentId.trim() : "";
    const limit = body?.limit != null ? Number(body.limit) : undefined;

    if (!commitmentId && !cronOk) {
      return NextResponse.json({ error: "commitmentId is required" }, { status: 400 });
    }

    if (!commitmentId && cronOk) {
      const all = await listCommitments();
      const targets = all.filter((c) => c.kind === "creator_reward" && c.creatorFeeMode === "managed" && c.status !== "archived");
      const sharedCreatorPubkeys = new Map<string, string[]>();
      for (const c of all) {
        if (c.kind !== "creator_reward") continue;
        if (c.creatorFeeMode !== "managed") continue;
        if (c.status === "archived") continue;
        const key = String(c.authority);
        const arr = sharedCreatorPubkeys.get(key) ?? [];
        arr.push(c.id);
        sharedCreatorPubkeys.set(key, arr);
      }

      const capped = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? targets.slice(0, Math.min(200, Math.floor(limit))) : targets;
      const results: any[] = [];
      const failed: Array<{ id: string; error: string; attempts: number }> = [];
      
      for (const c of capped) {
        const sharedIds = sharedCreatorPubkeys.get(String(c.authority)) ?? [];
        if (sharedIds.length > 1) {
          const msg = "Creator wallet is shared across multiple commitments; sweep is blocked to prevent mixing creator fees";
          results.push({
            id: c.id,
            ok: false,
            status: 409,
            error: msg,
            creatorPubkey: c.authority,
            sharedCommitmentIds: sharedIds,
          });
          failed.push({ id: c.id, error: msg, attempts: 0 });
          continue;
        }

        // One attempt per run: a sweep whose transaction is uncertain stays recorded under its lock and is settled
        // (from the chain) by the next run - blind retries could stack transactions.
        try {
          const r = await sweepOne(c.id, { kind: "cron" });
          results.push(r);
          if (!r?.ok) failed.push({ id: c.id, error: String(r?.error ?? "Sweep failed"), attempts: 1 });
        } catch (e) {
          const lastError = getSafeErrorMessage(e);
          results.push({ id: c.id, ok: false, error: lastError, attempts: 1 });
          failed.push({ id: c.id, error: lastError, attempts: 1 });
        }
      }
      
      // Log failed sweeps for monitoring
      if (failed.length > 0) {
        await auditLog("sweep_batch_failures", { failedCount: failed.length, failed });
      }
      
      return NextResponse.json({ ok: true, swept: results.length, failedCount: failed.length, results });
    }

    const result = await sweepOne(commitmentId, cronOk ? { kind: "cron" } : { kind: "admin" });
    if (!result.ok && result.status === 409) {
      return NextResponse.json(result, { status: 409 });
    }
    if (!result.ok && result.error === "Commitment not found") {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }
    if (!result.ok) {
      const status = Number(result.status);
      return NextResponse.json({ ...result, error: result.error ?? "Sweep failed" }, { status: Number.isFinite(status) && status >= 400 ? status : 400 });
    }
    return NextResponse.json(result);

  } catch (e) {
    await auditLog("sweep_error", { error: getSafeErrorMessage(e) }).catch(() => null);
    return apiError(e, "escrow/sweep");
  }
}
