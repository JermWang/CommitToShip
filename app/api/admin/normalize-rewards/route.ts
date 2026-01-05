import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { isAdminRequestAsync } from "../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { checkRateLimit } from "../../../lib/rateLimit";
import { auditLog } from "../../../lib/auditLog";
import {
  RewardMilestone,
  getRewardApprovalThreshold,
  getRewardMilestoneVoteCounts,
  listCommitments,
  normalizeRewardMilestonesClaimable,
  sumReleasedLamports,
  updateRewardTotalsAndMilestones,
} from "../../../lib/escrowStore";
import { getBalanceLamports, getChainUnixTime, getConnection } from "../../../lib/solana";
import { getSafeErrorMessage } from "../../../lib/safeError";

export const runtime = "nodejs";

function isCronAuthorized(req: Request): boolean {
  const secret = String(process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;

  const header = String(req.headers.get("x-cron-secret") ?? "").trim();
  if (!header) return false;

  return header === secret;
}

function computeUnlockedLamports(milestones: RewardMilestone[]): number {
  return milestones.reduce((acc, m) => {
    if (m.status === "claimable" || m.status === "released") return acc + Number(m.unlockLamports || 0);
    return acc;
  }, 0);
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "admin:normalize-rewards", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const cronOk = isCronAuthorized(req);
    if (!cronOk) {
      verifyAdminOrigin(req);
      if (!(await isAdminRequestAsync(req))) {
        await auditLog("admin_normalize_rewards_denied", {});
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const body = (await req.json().catch(() => null)) as any;
    const commitmentId = typeof body?.commitmentId === "string" ? body.commitmentId.trim() : "";
    const limit = body?.limit != null ? Number(body.limit) : undefined;

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);

    const approvalThreshold = getRewardApprovalThreshold();

    const all = await listCommitments();
    const targets = all.filter((c) => c.kind === "creator_reward" && (!commitmentId || c.id === commitmentId));

    const capped = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? targets.slice(0, Math.min(500, Math.floor(limit))) : targets;

    let changedCount = 0;
    const results: Array<{ id: string; changed: boolean; error?: string }> = [];

    for (const c of capped) {
      try {
        const milestones: RewardMilestone[] = Array.isArray(c.milestones) ? (c.milestones.slice() as RewardMilestone[]) : [];
        const voteCounts = await getRewardMilestoneVoteCounts(c.id);
        const approvalCounts = voteCounts.approvalCounts;
        const normalized = normalizeRewardMilestonesClaimable({
          milestones,
          nowUnix,
          approvalCounts,
          rejectCounts: voteCounts.rejectCounts,
          approvalThreshold,
        });

        if (!normalized.changed) {
          results.push({ id: c.id, changed: false });
          continue;
        }

        const escrowPk = new PublicKey(c.escrowPubkey);
        const balanceLamports = await getBalanceLamports(connection, escrowPk);

        const unlockedLamports = computeUnlockedLamports(normalized.milestones);
        const releasedLamports = sumReleasedLamports(normalized.milestones);
        const totalFundedLamports = Math.max(0, balanceLamports + releasedLamports);

        const allReleased = normalized.milestones.length > 0 && normalized.milestones.every((m) => m.status === "released");
        const nextStatus = allReleased ? "completed" : (c.status === "completed" ? "completed" : "active");

        await updateRewardTotalsAndMilestones({
          id: c.id,
          milestones: normalized.milestones,
          unlockedLamports,
          totalFundedLamports,
          status: nextStatus,
        });

        changedCount++;
        results.push({ id: c.id, changed: true });
      } catch (e) {
        results.push({ id: c.id, changed: false, error: getSafeErrorMessage(e) });
      }
    }

    await auditLog("admin_normalize_rewards_completed", {
      cron: cronOk,
      nowUnix,
      commitmentId: commitmentId || null,
      targetCount: capped.length,
      changedCount,
    });

    return NextResponse.json({ ok: true, nowUnix, targetCount: capped.length, changedCount, results });
  } catch (e) {
    await auditLog("admin_normalize_rewards_error", { error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
