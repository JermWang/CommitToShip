import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { isAdminRequestAsync } from "../../../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../../../lib/adminSession";
import { auditLog } from "../../../../../../lib/auditLog";
import { checkRateLimit } from "../../../../../../lib/rateLimit";
import {
  RewardMilestone,
  deleteRewardMilestonePayoutClaim,
  getCommitment,
  getRewardMilestonePayoutClaim,
  publicView,
  setRewardMilestonePayoutClaimTxSig,
  sumReleasedLamports,
  updateRewardTotalsAndMilestones,
} from "../../../../../../lib/escrowStore";
import { findSystemTransferSignature, getBalanceLamports, getChainUnixTime, getConnection } from "../../../../../../lib/solana";
import { getSafeErrorMessage } from "../../../../../../lib/safeError";

export const runtime = "nodejs";

function computeUnlockedLamports(milestones: RewardMilestone[]): number {
  return milestones.reduce((acc, m) => {
    if (m.status === "claimable" || m.status === "released") return acc + Number(m.unlockLamports || 0);
    return acc;
  }, 0);
}

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  const rl = await checkRateLimit(req, { keyPrefix: "milestone:reconcile", limit: 30, windowSeconds: 60 });
  if (!rl.allowed) {
    const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    res.headers.set("retry-after", String(rl.retryAfterSeconds));
    return res;
  }

  verifyAdminOrigin(req);
  if (!(await isAdminRequestAsync(req))) {
    await auditLog("admin_reward_milestone_reconcile_denied", { commitmentId: ctx.params.id, milestoneId: ctx.params.milestoneId });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = ctx.params.id;
  const milestoneId = ctx.params.milestoneId;
  const body = (await req.json().catch(() => null)) as any;

  try {
    const record = await getCommitment(id);
    if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (record.kind !== "creator_reward") {
      return NextResponse.json({ error: "Not a reward commitment" }, { status: 400 });
    }

    const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
    const idx = milestones.findIndex((m) => m.id === milestoneId);
    if (idx < 0) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });

    const connection = getConnection();
    const escrowPk = new PublicKey(record.escrowPubkey);
    const [nowUnix, balanceLamports] = await Promise.all([
      getChainUnixTime(connection),
      getBalanceLamports(connection, escrowPk),
    ]);

    const claim = await getRewardMilestonePayoutClaim({ commitmentId: id, milestoneId });
    if (!claim) {
      return NextResponse.json({ error: "No payout claim record exists for this milestone" }, { status: 404 });
    }

    const ensureReleasedState = async (txSig: string) => {
      const nextMilestones = milestones.slice();
      const current = nextMilestones[idx];
      if (current.status !== "released") {
        nextMilestones[idx] = {
          ...current,
          status: "released",
          releasedAtUnix: nowUnix,
          releasedTxSig: txSig,
        };
      } else if (!current.releasedTxSig) {
        nextMilestones[idx] = {
          ...current,
          releasedTxSig: txSig,
        };
      }

      const unlockedLamports = computeUnlockedLamports(nextMilestones);
      const releasedLamports = sumReleasedLamports(nextMilestones);
      const totalFundedLamports = Math.max(record.totalFundedLamports ?? 0, balanceLamports + releasedLamports);
      const allReleased = nextMilestones.length > 0 && nextMilestones.every((m) => m.status === "released");

      const updated = await updateRewardTotalsAndMilestones({
        id,
        milestones: nextMilestones,
        unlockedLamports,
        totalFundedLamports,
        status: allReleased ? "completed" : "active",
      });

      return updated;
    };

    if (claim.txSig) {
      const updated = await ensureReleasedState(String(claim.txSig));
      await auditLog("admin_reward_milestone_reconcile_ok", { commitmentId: id, milestoneId, mode: "already_has_txSig", txSig: claim.txSig });
      return NextResponse.json({ ok: true, mode: "already_has_txSig", txSig: claim.txSig, commitment: publicView(updated) });
    }

    const toPk = new PublicKey(claim.toPubkey);
    const lamports = Number(claim.amountLamports);
    const foundSig = await findSystemTransferSignature({
      connection,
      fromPubkey: escrowPk,
      toPubkey: toPk,
      lamports,
      minBlockTimeUnix: Math.max(0, Number(claim.createdAtUnix ?? 0) - 300),
      maxTransactionsToInspect: 300,
    });

    if (foundSig) {
      await setRewardMilestonePayoutClaimTxSig({ commitmentId: id, milestoneId, txSig: foundSig });
      const updated = await ensureReleasedState(foundSig);
      await auditLog("admin_reward_milestone_reconcile_ok", { commitmentId: id, milestoneId, mode: "found_on_chain", txSig: foundSig });
      return NextResponse.json({ ok: true, mode: "found_on_chain", txSig: foundSig, commitment: publicView(updated) });
    }

    const forceReset = Boolean(body?.forceReset);
    if (!forceReset) {
      await auditLog("admin_reward_milestone_reconcile_no_match", { commitmentId: id, milestoneId, amountLamports: lamports, toPubkey: claim.toPubkey });
      return NextResponse.json(
        {
          error: "No matching transfer found on-chain for this payout claim",
          hint: "If you are sure the transfer never happened and want to unblock retries, re-run with { forceReset: true } to clear the in-progress claim record.",
          claim,
        },
        { status: 409 }
      );
    }

    await deleteRewardMilestonePayoutClaim({ commitmentId: id, milestoneId });
    await auditLog("admin_reward_milestone_reconcile_reset", { commitmentId: id, milestoneId });

    return NextResponse.json({ ok: true, mode: "reset", commitment: publicView(record) });
  } catch (e) {
    await auditLog("admin_reward_milestone_reconcile_error", { commitmentId: id, milestoneId, error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
