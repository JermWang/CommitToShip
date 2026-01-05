import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { isAdminRequestAsync } from "../../../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../../../lib/adminSession";
import { checkRateLimit } from "../../../../../../lib/rateLimit";
import { auditLog } from "../../../../../../lib/auditLog";
import {
  RewardMilestone,
  getMilestoneFailureReservedLamports,
  getCommitment,
  getEscrowSignerRef,
  getRewardApprovalThreshold,
  getRewardMilestoneVoteCounts,
  normalizeRewardMilestonesClaimable,
  publicView,
  sumReleasedLamports,
  setRewardMilestonePayoutClaimTxSig,
  tryAcquireRewardMilestonePayoutClaim,
  updateRewardTotalsAndMilestones,
} from "../../../../../../lib/escrowStore";
import {
  getBalanceLamports,
  getChainUnixTime,
  getConnection,
  closeNativeWsolTokenAccounts,
  findRecentSystemTransferSignature,
  keypairFromBase58Secret,
  transferLamports,
  transferLamportsFromPrivyWallet,
} from "../../../../../../lib/solana";
import { getSafeErrorMessage } from "../../../../../../lib/safeError";

export const runtime = "nodejs";

function isRewardPayoutsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_REWARD_PAYOUTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function computeUnlockedLamports(milestones: RewardMilestone[]): number {
  return milestones.reduce((acc, m) => {
    if (m.status === "claimable" || m.status === "released") return acc + Number(m.unlockLamports || 0);
    return acc;
  }, 0);
}

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
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
    await auditLog("admin_reward_milestone_release_denied", { commitmentId: ctx.params.id, milestoneId: ctx.params.milestoneId });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = ctx.params.id;
  const milestoneId = ctx.params.milestoneId;

  try {
    const record = await getCommitment(id);
    if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (record.kind !== "creator_reward") {
      return NextResponse.json({ error: "Not a reward commitment" }, { status: 400 });
    }

    if (record.status === "failed") {
      return NextResponse.json({ error: "Commitment is failed" }, { status: 409 });
    }

    if (!record.creatorPubkey) {
      return NextResponse.json({ error: "Missing creator pubkey" }, { status: 500 });
    }

    const connection = getConnection();
    const escrowPk = new PublicKey(record.escrowPubkey);

    const [balanceLamports0, nowUnix] = await Promise.all([
      getBalanceLamports(connection, escrowPk),
      getChainUnixTime(connection),
    ]);
    let balanceLamports = balanceLamports0;

    const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
    const idx = milestones.findIndex((m: RewardMilestone) => m.id === milestoneId);
    if (idx < 0) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });

    const voteCounts = await getRewardMilestoneVoteCounts(id);
    const approvalCounts = voteCounts.approvalCounts;
    const approvalThreshold = getRewardApprovalThreshold();
    const normalized = normalizeRewardMilestonesClaimable({
      milestones,
      nowUnix,
      approvalCounts,
      rejectCounts: voteCounts.rejectCounts,
      approvalThreshold,
    });
    let effectiveMilestones = normalized.milestones;

    const m = effectiveMilestones[idx];

    if (m.status === "released") {
      return NextResponse.json({ error: "Already released", commitment: publicView(record) }, { status: 409 });
    }

    if (m.status !== "claimable") {
      return NextResponse.json({
        error: "Milestone not claimable",
        nowUnix,
        milestone: m,
        commitment: publicView(record),
      }, { status: 400 });
    }

    const unlockLamports = Number(m.unlockLamports);
    if (!Number.isFinite(unlockLamports) || unlockLamports <= 0) {
      return NextResponse.json({ error: "Invalid milestone unlock amount" }, { status: 500 });
    }

    const escrowRef = getEscrowSignerRef(record);
    const to = new PublicKey(record.creatorPubkey);

    const reservedLamports = await getMilestoneFailureReservedLamports(id);
    let availableLamports = Math.max(0, Math.floor(balanceLamports - reservedLamports));

    if (availableLamports < unlockLamports) {
      try {
        await closeNativeWsolTokenAccounts({
          connection,
          owner: escrowPk,
          destination: escrowPk,
          signer:
            escrowRef.kind === "privy"
              ? { kind: "privy", walletId: escrowRef.walletId }
              : { kind: "keypair", keypair: keypairFromBase58Secret(escrowRef.escrowSecretKeyB58) },
        });
        balanceLamports = await getBalanceLamports(connection, escrowPk);
        availableLamports = Math.max(0, Math.floor(balanceLamports - reservedLamports));
      } catch (e) {
        void e;
      }
    }

    if (availableLamports < unlockLamports) {
      return NextResponse.json(
        {
          error: "Escrow underfunded for this release",
          balanceLamports,
          reservedLamports,
          availableLamports,
          requiredLamports: unlockLamports,
          commitment: publicView(record),
        },
        { status: 400 }
      );
    }

    const claim = await tryAcquireRewardMilestonePayoutClaim({
      commitmentId: id,
      milestoneId,
      createdAtUnix: nowUnix,
      toPubkey: to.toBase58(),
      amountLamports: unlockLamports,
    });

    if (!claim.acquired) {
      const existing = claim.existing;
      if (existing.toPubkey !== to.toBase58() || Number(existing.amountLamports) !== unlockLamports) {
        return NextResponse.json(
          {
            error: "Existing claim has mismatched payout details",
            existing,
            expected: { toPubkey: to.toBase58(), amountLamports: unlockLamports },
          },
          { status: 409 }
        );
      }

      const recoveredTxSig =
        existing.txSig ??
        (await findRecentSystemTransferSignature({
          connection,
          fromPubkey: escrowPk,
          toPubkey: to,
          lamports: unlockLamports,
          limit: 50,
        }));

      if (recoveredTxSig) {
        if (!existing.txSig) {
          await setRewardMilestonePayoutClaimTxSig({ commitmentId: id, milestoneId, txSig: recoveredTxSig });
        }

        const nextMilestones = effectiveMilestones.slice();
        if (nextMilestones[idx]?.status !== "released") {
          nextMilestones[idx] = {
            ...m,
            status: "released",
            releasedAtUnix: nowUnix,
            releasedTxSig: recoveredTxSig,
          };
        }

        const unlockedLamports = computeUnlockedLamports(nextMilestones);
        const releasedLamports = sumReleasedLamports(nextMilestones);
        const totalFundedLamports = Math.max(record.totalFundedLamports ?? 0, balanceLamports + releasedLamports);

        const allReleased = nextMilestones.length > 0 && nextMilestones.every((x) => x.status === "released");

        const updated = await updateRewardTotalsAndMilestones({
          id,
          milestones: nextMilestones,
          unlockedLamports,
          totalFundedLamports,
          status: allReleased ? "completed" : "active",
        });

        return NextResponse.json({
          ok: true,
          nowUnix,
          signature: recoveredTxSig,
          commitment: publicView(updated),
          idempotent: true,
          recovered: !existing.txSig,
        });
      }

      return NextResponse.json(
        {
          error: "Release already in progress",
          existing,
          hint: "A payout claim record exists but no tx signature is recorded yet. If this persists, use the admin reconcile endpoint to find the on-chain transfer or reset the claim.",
        },
        { status: 409 }
      );
    }

    try {
      const { signature } =
        escrowRef.kind === "privy"
          ? await transferLamportsFromPrivyWallet({
              connection,
              walletId: escrowRef.walletId,
              fromPubkey: escrowPk,
              to,
              lamports: unlockLamports,
            })
          : await transferLamports({
              connection,
              from: keypairFromBase58Secret(escrowRef.escrowSecretKeyB58),
              to,
              lamports: unlockLamports,
            });

      await setRewardMilestonePayoutClaimTxSig({ commitmentId: id, milestoneId, txSig: signature });

      effectiveMilestones[idx] = {
        ...m,
        status: "released",
        releasedAtUnix: nowUnix,
        releasedTxSig: signature,
      };

      const unlockedLamports = computeUnlockedLamports(effectiveMilestones);

      const releasedLamports = sumReleasedLamports(effectiveMilestones);
      const totalFundedLamports = Math.max(record.totalFundedLamports ?? 0, balanceLamports + releasedLamports);

      const allReleased = effectiveMilestones.length > 0 && effectiveMilestones.every((x) => x.status === "released");

      const updated = await updateRewardTotalsAndMilestones({
        id,
        milestones: effectiveMilestones,
        unlockedLamports,
        totalFundedLamports,
        status: allReleased ? "completed" : "active",
      });

      await auditLog("admin_reward_milestone_release_ok", { commitmentId: id, milestoneId, signature });

      return NextResponse.json({
        ok: true,
        nowUnix,
        signature,
        commitment: publicView(updated),
      });
    } catch (e) {
      await auditLog("admin_reward_milestone_release_error", { commitmentId: id, milestoneId, error: getSafeErrorMessage(e) });
      return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
    }
  } catch (e) {
    await auditLog("admin_reward_milestone_release_error", { commitmentId: id, milestoneId, error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
