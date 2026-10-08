import { NextResponse } from "next/server";

import { isAdminRequestAsync } from "../../../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../../../lib/adminSession";
import { auditLog } from "../../../../../../lib/auditLog";
import { checkRateLimit } from "../../../../../../lib/rateLimit";
import {
  allocatedPercentFromMilestones,
  getCommitment,
  publicView,
  RewardMilestone,
  updateRewardTotalsAndMilestones,
} from "../../../../../../lib/escrowStore";
import { apiError } from "../../../../../../lib/apiError";
import { getSafeErrorMessage } from "../../../../../../lib/safeError";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  const id = ctx.params.id;
  const milestoneId = ctx.params.milestoneId;

  try {
    const rl = await checkRateLimit(req, { keyPrefix: "milestone:override", limit: 30, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    // Inside the try: a foreign/missing Origin becomes a 403 via apiError, never an unhandled 500.
    verifyAdminOrigin(req);
    if (!(await isAdminRequestAsync(req))) {
      await auditLog("admin_reward_milestone_override_denied", { commitmentId: id, milestoneId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as any;

    const record = await getCommitment(id);
    if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (record.kind !== "creator_reward") {
      return NextResponse.json({ error: "Not a reward commitment" }, { status: 400 });
    }

    const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
    const idx = milestones.findIndex((m) => m.id === milestoneId);
    if (idx < 0) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });

    const existing = milestones[idx];

    const rawTitle = typeof body?.title === "string" ? body.title.trim() : undefined;
    const rawDueAtUnix = body?.dueAtUnix != null ? Number(body.dueAtUnix) : undefined;
    const rawUnlockPercent = body?.unlockPercent != null ? Number(body.unlockPercent) : undefined;

    if (rawTitle == null && rawDueAtUnix == null && rawUnlockPercent == null) {
      return NextResponse.json({ error: "No fields provided" }, { status: 400 });
    }

    let title = existing.title;
    if (rawTitle != null) {
      if (!rawTitle) return NextResponse.json({ error: "title required" }, { status: 400 });
      if (rawTitle.length > 80) return NextResponse.json({ error: "title too long (max 80 chars)" }, { status: 400 });
      title = rawTitle;
    }

    let dueAtUnix = existing.dueAtUnix;
    if (rawDueAtUnix != null) {
      if (!Number.isFinite(rawDueAtUnix) || rawDueAtUnix <= 0) {
        return NextResponse.json({ error: "Invalid dueAtUnix" }, { status: 400 });
      }
      const nowUnix = Math.floor(Date.now() / 1000);
      const maxFutureSeconds = 10 * 365 * 24 * 60 * 60;
      if (rawDueAtUnix > nowUnix + maxFutureSeconds) {
        return NextResponse.json({ error: "dueAtUnix too far in the future" }, { status: 400 });
      }
      dueAtUnix = Math.floor(rawDueAtUnix);
    }

    let unlockPercent = existing.unlockPercent;
    if (rawUnlockPercent != null) {
      if (existing.completedAtUnix != null) {
        return NextResponse.json({ error: "Cannot edit unlockPercent after completion" }, { status: 409 });
      }
      if (!Number.isFinite(rawUnlockPercent) || rawUnlockPercent <= 0 || rawUnlockPercent > 100) {
        return NextResponse.json({ error: "unlockPercent must be between 1 and 100" }, { status: 400 });
      }
      unlockPercent = Math.floor(rawUnlockPercent);
    }

    const next: RewardMilestone = { ...existing, title, dueAtUnix, unlockPercent };
    const nextMilestones = milestones.slice();
    nextMilestones[idx] = next;

    // M8: the milestones together may never unlock more than 100% of the escrow (same rule as add/edit).
    if (rawUnlockPercent != null) {
      const totalFundedLamports = Number(record.totalFundedLamports ?? 0);
      const totalNext = allocatedPercentFromMilestones({ milestones: nextMilestones, totalFundedLamports });
      if (totalNext > 100.0001) {
        return NextResponse.json({ error: `Total allocation cannot exceed 100% (would be ${totalNext}%).` }, { status: 400 });
      }
    }

    const updated = await updateRewardTotalsAndMilestones({ id, milestones: nextMilestones, expectedMilestones: record.milestones ?? [] });
    const applied = (updated.milestones ?? []).find((m) => m.id === milestoneId);
    if (!applied || applied.title !== title || applied.dueAtUnix !== dueAtUnix || applied.unlockPercent !== unlockPercent) {
      return NextResponse.json({ error: "The commitment changed concurrently; reload and try again" }, { status: 409 });
    }

    await auditLog("admin_reward_milestone_override_ok", {
      commitmentId: id,
      milestoneId,
      fields: {
        title: rawTitle != null,
        dueAtUnix: rawDueAtUnix != null,
        unlockPercent: rawUnlockPercent != null,
      },
    });

    return NextResponse.json({ ok: true, commitment: publicView(updated) });
  } catch (e) {
    await auditLog("admin_reward_milestone_override_error", { commitmentId: id, milestoneId, error: getSafeErrorMessage(e) });
    return apiError(e, "milestone/override");
  }
}
