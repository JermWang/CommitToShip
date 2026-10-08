import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import crypto from "crypto";

import { isAdminRequestAsync } from "../../../../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../../../../lib/adminSession";
import { auditLog } from "../../../../../../../lib/auditLog";
import { checkRateLimit } from "../../../../../../../lib/rateLimit";
import {
  MilestoneFailureDistributionRecord,
  MilestoneFailureDistributionStep,
  RewardMilestone,
  completeMilestoneFailureDistributionStep,
  countRewardMilestoneSignalsBySigner,
  createMilestoneFailureDistributionWithAllocations,
  getCommitment,
  getEscrowSignerRef,
  getMilestoneFailureDistribution,
  getMilestoneFailureReservedLamports,
  getRewardMilestoneSignalFirstSeenUnixBySigner,
  getRewardMilestoneVoteWindow,
  getMilestoneFailureDistributionStepValue,
  getRewardVoteCutoffSeconds,
  isFailureDistributionStepMarker,
  listEligibleRewardVotersAtClose,
  parseFailureDistributionStepMarker,
  prepareMilestoneFailureDistributionStep,
  publicView,
  releaseMilestoneFailureDistributionStep,
  sumReleasedLamports,
  tryClaimMilestoneFailureDistributionStep,
} from "../../../../../../../lib/escrowStore";
import {
  getBalanceLamports,
  getChainUnixTime,
  getConnection,
  getSignatureOutcome,
  isTxDefinitelyNotLanded,
  keypairFromBase58Secret,
  transferLamports,
  transferLamportsFromPrivyWallet,
} from "../../../../../../../lib/solana";
import { apiError } from "../../../../../../../lib/apiError";
import { getSafeErrorMessage } from "../../../../../../../lib/safeError";

export const runtime = "nodejs";

/** A reserved step that never recorded a signature (so never broadcast) may be taken over once it is this old. */
const STEP_STALE_AFTER_SECONDS = 10 * 60;

function isMilestoneFailurePayoutsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_FAILURE_DISTRIBUTION_PAYOUTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isParticipationWeightedFailurePayoutsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_PARTICIPATION_WEIGHTED_FAILURE_PAYOUTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function getParticipationWindowMilestones(): number {
  const raw = Number(process.env.CTS_PARTICIPATION_WINDOW_MILESTONES ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 20;
}

function getStreaksGraceMisses(): number {
  const raw = Number(process.env.CTS_STREAKS_GRACE_MISSES ?? "");
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 2;
}

/** Streak multiplier in bps: 2.0x minus 0.05x per grace miss and 0.10x per further miss, clamped to 0.5x..2.0x. */
function streaksMultiplierBpsFromMisses(input: { misses: number; graceMisses: number }): bigint {
  const misses = Math.max(0, Math.floor(Number(input.misses ?? 0)));
  const grace = Math.max(0, Math.floor(Number(input.graceMisses ?? 0)));
  const penalizedGraceMisses = Math.min(misses, grace);
  const extraMisses = Math.max(0, misses - grace);
  const bps = 20000 - penalizedGraceMisses * 500 - extraMisses * 1000;
  return BigInt(Math.max(5000, Math.min(20000, bps)));
}

type StepResult = { step: MilestoneFailureDistributionStep; lamports: number; to: string; signature: string | null; state: "done" | "sent" | "found" | "in_progress" | "skipped" };

/**
 * Admin: settle a failed milestone. Idempotent and safe under concurrent calls:
 *  - the distribution and ALL voter allocations are created once, in one transaction (later calls reuse the stored
 *    record - amounts are never recomputed from the shrinking escrow balance);
 *  - voter weights use the close-time holder re-check: only wallets that still held the minimum when the vote window
 *    closed, weighted by min(voteBalance, closeBalance) (BigInt math);
 *  - every transfer step (buyback, vote-reward treasury, unallocated voter pot) is reserved with an atomic conditional
 *    UPDATE before sending, so two requests can never both send it; the signature is persisted before broadcast
 *    (onPrepared). A leftover reservation is resolved by that signature's on-chain outcome (confirmed -> recorded,
 *    failed/expired -> resent, pending -> left alone); one without a signature is retaken after STEP_STALE_AFTER_SECONDS.
 */
export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "milestone:failure:create", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    if (!isMilestoneFailurePayoutsEnabled()) {
      return NextResponse.json(
        {
          error: "Milestone failure payouts are disabled",
          hint: "Set CTS_ENABLE_FAILURE_DISTRIBUTION_PAYOUTS=1 (or true) to enable milestone failure payouts.",
        },
        { status: 503 }
      );
    }

    verifyAdminOrigin(req);
    if (!(await isAdminRequestAsync(req))) {
      await auditLog("admin_milestone_failure_distribution_denied", { commitmentId: ctx.params.id, milestoneId: ctx.params.milestoneId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const commitmentId = ctx.params.id;
    const milestoneId = ctx.params.milestoneId;

    const record = await getCommitment(commitmentId);
    if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (record.kind !== "creator_reward") return NextResponse.json({ error: "Not a reward commitment" }, { status: 400 });

    const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
    const m = milestones.find((x) => x.id === milestoneId);
    if (!m) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
    if (m.status !== "failed") {
      return NextResponse.json({ error: "Milestone is not failed", milestone: m, commitment: publicView(record) }, { status: 409 });
    }

    const treasuryRaw = String(process.env.CTS_SHIP_BUYBACK_TREASURY_PUBKEY ?? "").trim();
    if (!treasuryRaw) return NextResponse.json({ error: "CTS_SHIP_BUYBACK_TREASURY_PUBKEY is required" }, { status: 500 });
    const treasury = new PublicKey(treasuryRaw);

    const voteRewardTreasuryRaw = String(process.env.CTS_VOTE_REWARD_FAUCET_OWNER_PUBKEY ?? "").trim();
    if (!voteRewardTreasuryRaw) return NextResponse.json({ error: "CTS_VOTE_REWARD_FAUCET_OWNER_PUBKEY is required" }, { status: 500 });
    const voteRewardTreasury = new PublicKey(voteRewardTreasuryRaw);

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);
    const escrowPk = new PublicKey(record.escrowPubkey);
    const escrowRef = getEscrowSignerRef(record);
    const participationEnabled = isParticipationWeightedFailurePayoutsEnabled();

    let dist: MilestoneFailureDistributionRecord | null = await getMilestoneFailureDistribution({ commitmentId, milestoneId });
    let createdNow = false;
    let allocationCount = -1;

    if (!dist) {
      const cutoffSeconds = getRewardVoteCutoffSeconds();
      const window = getRewardMilestoneVoteWindow(m, cutoffSeconds);
      if (window && nowUnix < window.endUnix) {
        return NextResponse.json({ error: "Vote window still open", code: "vote_window_open", nowUnix, voteWindow: window }, { status: 409 });
      }

      const balanceLamports = await getBalanceLamports(connection, escrowPk);
      const releasedLamports = sumReleasedLamports(milestones);
      const totalFundedLamports = Math.max(0, Number(balanceLamports) + releasedLamports);

      const unlockLamportsRaw = Number(m.unlockLamports ?? 0);
      const unlockPercent = Number(m.unlockPercent ?? 0);
      const forfeitedLamports =
        Number.isFinite(unlockLamportsRaw) && unlockLamportsRaw > 0
          ? Math.floor(unlockLamportsRaw)
          : Number.isFinite(unlockPercent) && unlockPercent > 0
            ? Math.floor((totalFundedLamports * unlockPercent) / 100)
            : 0;
      if (!Number.isFinite(forfeitedLamports) || forfeitedLamports <= 0) {
        return NextResponse.json({ error: "Invalid forfeited amount", milestone: m }, { status: 400 });
      }

      const reservedLamports = await getMilestoneFailureReservedLamports(commitmentId);
      const availableLamports = Math.max(0, Math.floor(balanceLamports - reservedLamports));
      if (availableLamports < forfeitedLamports) {
        return NextResponse.json(
          { error: "Escrow underfunded for milestone failure payout", balanceLamports, reservedLamports, availableLamports, forfeitedLamports },
          { status: 400 }
        );
      }

      const totalBuybackLamports = Math.floor(forfeitedLamports * 0.5);
      const voteRewardLamports = Math.floor(totalBuybackLamports * 0.1);
      const buybackLamports = Math.max(0, totalBuybackLamports - voteRewardLamports);
      const plannedVoterPotLamports = Math.max(0, forfeitedLamports - totalBuybackLamports);

      // Close-time holder re-check: only wallets that still held the minimum at close, weighted by min(vote, close).
      const eligible = await listEligibleRewardVotersAtClose({ record, milestoneId, nowUnix });
      if (!eligible.complete) {
        return NextResponse.json(
          { error: "Close-time holder re-check is not complete yet; try again shortly", code: "close_recheck_pending" },
          { status: 503 }
        );
      }
      const voters = eligible.voters;

      const streakBpsByWallet = new Map<string, bigint>();
      if (participationEnabled && voters.length) {
        const signerPubkeys = voters.map((v) => v.signerPubkey);
        const endedOpportunities = milestones
          .map((milestone) => {
            const w = getRewardMilestoneVoteWindow(milestone, cutoffSeconds);
            if (!w || w.endUnix > nowUnix) return null;
            return { milestoneId: milestone.id, startUnix: w.startUnix, endUnix: w.endUnix };
          })
          .filter(Boolean) as Array<{ milestoneId: string; startUnix: number; endUnix: number }>;
        const recentWindow = endedOpportunities
          .sort((a, b) => b.endUnix - a.endUnix || a.milestoneId.localeCompare(b.milestoneId))
          .slice(0, getParticipationWindowMilestones());
        const windowMilestoneIds = recentWindow.map((x) => x.milestoneId);
        if (windowMilestoneIds.length) {
          const [voteCounts, firstSeen] = await Promise.all([
            countRewardMilestoneSignalsBySigner({ commitmentId, milestoneIds: windowMilestoneIds, signerPubkeys }),
            getRewardMilestoneSignalFirstSeenUnixBySigner({ commitmentId, signerPubkeys }),
          ]);
          const graceMisses = getStreaksGraceMisses();
          for (const walletPubkey of signerPubkeys) {
            const firstSeenUnix = Number(firstSeen.get(walletPubkey) ?? 0);
            const opportunities = recentWindow.reduce((acc, x) => {
              if (!Number.isFinite(firstSeenUnix) || firstSeenUnix <= 0) return acc + 1;
              return x.endUnix >= firstSeenUnix ? acc + 1 : acc;
            }, 0);
            const votes = Math.max(0, Math.floor(Number(voteCounts.get(walletPubkey) ?? 0)));
            const misses = opportunities > 0 ? Math.max(0, opportunities - votes) : 0;
            streakBpsByWallet.set(walletPubkey, streaksMultiplierBpsFromMisses({ misses, graceMisses }));
          }
        }
      }

      const weighted = voters
        .map((v) => ({ pk: v.signerPubkey, w: v.weightUnits * BigInt(v.shipMultiplierBps) * (streakBpsByWallet.get(v.signerPubkey) ?? 10000n) }))
        .filter((x) => x.w > 0n)
        .sort((a, b) => (b.w > a.w ? 1 : b.w < a.w ? -1 : a.pk.localeCompare(b.pk)));
      const totalWeight = weighted.reduce((acc, x) => acc + x.w, 0n);

      const distributionId = crypto.randomBytes(16).toString("hex");
      const allocations: Array<{ distributionId: string; walletPubkey: string; amountLamports: number; weight: number }> = [];
      const pot = BigInt(plannedVoterPotLamports);
      if (totalWeight > 0n && pot > 0n) {
        let allocated = 0n;
        for (const x of weighted) {
          const amt = (pot * x.w) / totalWeight;
          if (amt <= 0n) continue;
          allocations.push({ distributionId, walletPubkey: x.pk, amountLamports: Number(amt), weight: Number(x.w) });
          allocated += amt;
        }
        const remainder = pot - allocated;
        if (remainder > 0n && allocations.length > 0) {
          allocations[0] = { ...allocations[0], amountLamports: allocations[0].amountLamports + Number(remainder) };
        }
      }
      const effectiveVoterPotLamports = allocations.length > 0 ? plannedVoterPotLamports : 0;

      const distribution: MilestoneFailureDistributionRecord = {
        id: distributionId,
        commitmentId,
        milestoneId,
        createdAtUnix: nowUnix,
        forfeitedLamports,
        buybackLamports,
        voteRewardLamports,
        voterPotLamports: effectiveVoterPotLamports,
        shipBuybackTreasuryPubkey: treasury.toBase58(),
        voteRewardTreasuryPubkey: voteRewardLamports > 0 ? voteRewardTreasury.toBase58() : undefined,
        buybackTxSig: "pending",
        voteRewardTxSig: undefined,
        voterPotTxSig: undefined,
        status: "open",
      };

      const created = await createMilestoneFailureDistributionWithAllocations({ distribution, allocations });
      if (created.created) {
        dist = distribution;
        createdNow = true;
        allocationCount = allocations.length;
      } else {
        dist = created.existing;
      }
    }

    if (!dist) throw new Error("Milestone failure distribution missing");

    // The stored record is authoritative; refuse if the configured treasuries changed under it.
    if (dist.shipBuybackTreasuryPubkey !== treasury.toBase58()) {
      return NextResponse.json({ error: "CTS_SHIP_BUYBACK_TREASURY_PUBKEY differs from the stored distribution", existing: dist }, { status: 409 });
    }
    if (dist.voteRewardLamports > 0 && (dist.voteRewardTreasuryPubkey ?? "") !== voteRewardTreasury.toBase58()) {
      return NextResponse.json({ error: "CTS_VOTE_REWARD_FAUCET_OWNER_PUBKEY differs from the stored distribution", existing: dist }, { status: 409 });
    }

    const voterPotToTreasuryLamports = Math.max(0, dist.forfeitedLamports - (dist.buybackLamports + dist.voteRewardLamports) - dist.voterPotLamports);
    const plan: Array<{ step: MilestoneFailureDistributionStep; lamports: number; to: PublicKey }> = [
      { step: "buyback", lamports: dist.buybackLamports, to: treasury },
      { step: "vote_reward", lamports: dist.voteRewardLamports, to: voteRewardTreasury },
      { step: "voter_pot", lamports: voterPotToTreasuryLamports, to: treasury },
    ];

    const stepResults: StepResult[] = [];
    const distributionId = dist.id;

    for (const p of plan) {
      const base = { step: p.step, lamports: p.lamports, to: p.to.toBase58() };
      if (!(p.lamports > 0)) {
        stepResults.push({ ...base, signature: null, state: "skipped" });
        continue;
      }

      const cur = await getMilestoneFailureDistributionStepValue({ distributionId, step: p.step });
      const curTrim = String(cur ?? "").trim();
      if (curTrim && curTrim !== "pending" && curTrim !== "none" && !isFailureDistributionStepMarker(curTrim)) {
        stepResults.push({ ...base, signature: curTrim, state: "done" });
        continue;
      }

      // Another request reserved this step. Its signature (if any) was persisted before broadcast, so the chain tells
      // us exactly where it stands; a reservation without a signature never broadcast anything.
      let takeoverFrom: string | null = null;
      const reserved = parseFailureDistributionStepMarker(curTrim);
      if (reserved) {
        if (reserved.signature) {
          const outcome = await getSignatureOutcome(connection, reserved.signature, reserved.lastValidBlockHeight);
          if (outcome.outcome === "confirmed") {
            await completeMilestoneFailureDistributionStep({ distributionId, step: p.step, marker: curTrim, txSig: reserved.signature });
            stepResults.push({ ...base, signature: reserved.signature, state: "found" });
            continue;
          }
          if (outcome.outcome === "pending") {
            stepResults.push({ ...base, signature: reserved.signature, state: "in_progress" });
            continue;
          }
          // failed on-chain or provably expired: nothing moved, the step may be sent again.
          takeoverFrom = curTrim;
        } else if (nowUnix - reserved.reservedAtUnix < STEP_STALE_AFTER_SECONDS) {
          stepResults.push({ ...base, signature: null, state: "in_progress" });
          continue;
        } else {
          takeoverFrom = curTrim;
        }
      }

      const claim = await tryClaimMilestoneFailureDistributionStep({ distributionId, step: p.step, nowUnix, takeoverFrom });
      if (!claim.claimed) {
        stepResults.push({ ...base, signature: null, state: "in_progress" });
        continue;
      }

      const onPrepared = (info: { signature: string; lastValidBlockHeight: number }) =>
        prepareMilestoneFailureDistributionStep({
          distributionId,
          step: p.step,
          marker: claim.marker,
          signature: info.signature,
          lastValidBlockHeight: info.lastValidBlockHeight,
        });

      let tx: { signature: string };
      try {
        tx =
          escrowRef.kind === "privy"
            ? await transferLamportsFromPrivyWallet({ connection, walletId: escrowRef.walletId, fromPubkey: escrowPk, to: p.to, lamports: p.lamports, onPrepared })
            : await transferLamports({ connection, from: keypairFromBase58Secret(escrowRef.escrowSecretKeyB58), to: p.to, lamports: p.lamports, onPrepared });
      } catch (e) {
        // Proven no-effect failures give the step back immediately; anything uncertain keeps the reservation (with its
        // persisted signature) so the next call resolves it from the chain instead of paying twice.
        if (isTxDefinitelyNotLanded(e)) await releaseMilestoneFailureDistributionStep({ distributionId, step: p.step, marker: claim.marker });
        throw e;
      }
      await completeMilestoneFailureDistributionStep({ distributionId, step: p.step, marker: claim.marker, txSig: tx.signature });
      stepResults.push({ ...base, signature: tx.signature, state: "sent" });
    }

    const inProgress = stepResults.filter((s) => s.state === "in_progress").map((s) => s.step);

    await auditLog("admin_milestone_failure_distribution_ok", {
      commitmentId,
      milestoneId,
      distributionId,
      createdNow,
      forfeitedLamports: dist.forfeitedLamports,
      voterPotLamports: dist.voterPotLamports,
      participationWeighted: participationEnabled,
      steps: stepResults.map((s) => ({ step: s.step, state: s.state, signature: s.signature })),
    });

    const byStep = (step: MilestoneFailureDistributionStep) => stepResults.find((s) => s.step === step);
    return NextResponse.json(
      {
        ok: inProgress.length === 0,
        inProgress,
        nowUnix,
        distributionId,
        createdNow,
        forfeitedLamports: dist.forfeitedLamports,
        buyback: { treasury: treasury.toBase58(), lamports: dist.buybackLamports, signature: byStep("buyback")?.signature ?? null },
        voteRewardTreasury: {
          treasury: voteRewardTreasury.toBase58(),
          lamports: dist.voteRewardLamports,
          signature: byStep("vote_reward")?.signature ?? null,
        },
        voterPot: {
          lamports: dist.voterPotLamports,
          allocations: allocationCount,
          toTreasuryLamports: voterPotToTreasuryLamports,
          txSig: byStep("voter_pot")?.signature ?? null,
        },
      },
      { status: inProgress.length ? 202 : 200 }
    );
  } catch (e) {
    await auditLog("admin_milestone_failure_distribution_error", {
      commitmentId: ctx.params.id,
      milestoneId: ctx.params.milestoneId,
      error: getSafeErrorMessage(e),
    });
    return apiError(e, "milestone/failure-distribution/create");
  }
}
