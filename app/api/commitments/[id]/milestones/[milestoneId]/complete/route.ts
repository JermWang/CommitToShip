import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { RewardMilestone, getCommitment, publicView, sumReleasedLamports, updateRewardTotalsAndMilestones } from "../../../../../../lib/escrowStore";
import { checkRateLimit } from "../../../../../../lib/rateLimit";
import { getBalanceLamports, getChainUnixTime, getConnection } from "../../../../../../lib/solana";
import { getSafeErrorMessage } from "../../../../../../lib/safeError";

export const runtime = "nodejs";

function computeUnlockedLamports(milestones: RewardMilestone[]): number {
  return milestones.reduce((acc, m) => {
    if (m.status === "claimable" || m.status === "released") return acc + Number(m.unlockLamports || 0);
    return acc;
  }, 0);
}

function getClaimDelaySeconds(): number {
  const rawStr = process.env.REWARD_CLAIM_DELAY_SECONDS;
  if (rawStr == null || String(rawStr).trim() === "") return 48 * 60 * 60;
  const raw = Number(rawStr);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 48 * 60 * 60;
}

function getVoteCutoffSeconds(): number {
  const raw = Number(process.env.REWARD_VOTE_CUTOFF_SECONDS ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 24 * 60 * 60;
}

function getDeliveryGraceSeconds(): number {
  const raw = Number(process.env.REWARD_DELIVERY_GRACE_SECONDS ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 24 * 60 * 60;
}

function milestoneCompleteMessage(input: { commitmentId: string; milestoneId: string }): string {
  return `Commit To Ship\nMilestone Completion\nCommitment: ${input.commitmentId}\nMilestone: ${input.milestoneId}`;
}

function milestoneCompleteMessageV2(input: { commitmentId: string; milestoneId: string; review?: "early" }): string {
  const base = milestoneCompleteMessage({ commitmentId: input.commitmentId, milestoneId: input.milestoneId });
  if (input.review === "early") return `${base}\nReview: early`;
  return base;
}

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  const id = ctx.params.id;
  const milestoneId = ctx.params.milestoneId;

  const body = (await req.json().catch(() => null)) as any;

  try {
    const rl = await checkRateLimit(req, { keyPrefix: "milestone:complete", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const record = await getCommitment(id);
    if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (record.kind !== "creator_reward") {
      return NextResponse.json({ error: "Not a reward commitment" }, { status: 400 });
    }

    if (!record.creatorPubkey) {
      return NextResponse.json({ error: "Missing creator pubkey" }, { status: 500 });
    }

    const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
    const idx = milestones.findIndex((m: RewardMilestone) => m.id === milestoneId);
    if (idx < 0) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });

    const earlyReviewRequested = String(body?.review ?? "").trim().toLowerCase() === "early";

    const signatureB58 = typeof body?.signature === "string" ? body.signature.trim() : "";
    if (!signatureB58) {
      const message = earlyReviewRequested
        ? milestoneCompleteMessageV2({ commitmentId: id, milestoneId, review: "early" })
        : milestoneCompleteMessage({ commitmentId: id, milestoneId });
      return NextResponse.json({
        error: "signature required",
        message,
        creatorPubkey: record.creatorPubkey,
      }, { status: 400 });
    }

    const expectedLegacy = milestoneCompleteMessage({ commitmentId: id, milestoneId });
    const expectedEarly = milestoneCompleteMessageV2({ commitmentId: id, milestoneId, review: "early" });

    const providedMessage = typeof body?.message === "string" ? body.message : (earlyReviewRequested ? expectedEarly : expectedLegacy);

    const signature = bs58.decode(signatureB58);
    const creatorPk = new PublicKey(record.creatorPubkey);

    const matchesLegacy = providedMessage === expectedLegacy;
    const matchesEarly = providedMessage === expectedEarly;
    if (!matchesLegacy && !matchesEarly) {
      return NextResponse.json({ error: "Invalid message" }, { status: 400 });
    }
    if (earlyReviewRequested && !matchesEarly) {
      return NextResponse.json({ error: "Invalid message" }, { status: 400 });
    }

    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(matchesEarly ? expectedEarly : expectedLegacy),
      signature,
      creatorPk.toBytes()
    );

    if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    const connection = getConnection();
    const [nowUnix, balanceLamports] = await Promise.all([
      getChainUnixTime(connection),
      getBalanceLamports(connection, new PublicKey(record.escrowPubkey)),
    ]);
    const delaySeconds = getClaimDelaySeconds();
    const cutoffSeconds = getVoteCutoffSeconds();
    const graceSeconds = getDeliveryGraceSeconds();

    const m = milestones[idx];
    if (m.status === "released") {
      return NextResponse.json({ error: "Already released", commitment: publicView(record) }, { status: 409 });
    }

    if (m.status === "failed") {
      return NextResponse.json({ error: "Milestone is failed", commitment: publicView(record) }, { status: 409 });
    }

    if (m.completedAtUnix != null) {
      if (matchesEarly) {
        const completedAtUnix = Number(m.completedAtUnix);
        if (!Number.isFinite(completedAtUnix) || completedAtUnix <= 0) {
          return NextResponse.json({ error: "Invalid milestone completion timestamp" }, { status: 500 });
        }

        const reviewOpenedAtUnix = Number(m.reviewOpenedAtUnix);
        if (!Number.isFinite(reviewOpenedAtUnix) || reviewOpenedAtUnix <= 0) {
          const nextMilestones = milestones.slice();
          nextMilestones[idx] = {
            ...m,
            reviewOpenedAtUnix: nowUnix,
            claimableAtUnix: completedAtUnix + delaySeconds,
          };

          const releasedLamports = sumReleasedLamports(nextMilestones);
          const totalFundedLamports = Math.max(0, Number(balanceLamports) + releasedLamports);

          const updated = await updateRewardTotalsAndMilestones({
            id,
            milestones: nextMilestones,
            unlockedLamports: computeUnlockedLamports(nextMilestones),
            totalFundedLamports,
            status: record.status === "created" ? "active" : record.status,
          });

          return NextResponse.json({
            ok: true,
            nowUnix,
            claimableAtUnix: nextMilestones[idx].claimableAtUnix,
            commitment: publicView(updated),
          });
        }
      }

      return NextResponse.json({ error: "Already marked complete", commitment: publicView(record) }, { status: 409 });
    }

    const dueAtUnix = Number(m.dueAtUnix ?? 0);
    if (!matchesEarly && Number.isFinite(dueAtUnix) && dueAtUnix > 0) {
      const graceEndUnix = dueAtUnix + graceSeconds;
      if (nowUnix >= graceEndUnix) {
        return NextResponse.json(
          {
            error: "Milestone delivery window closed",
            nowUnix,
            dueAtUnix,
            graceEndUnix,
            hint: "This milestone was not turned in within the 24h grace period after the deadline.",
          },
          { status: 409 }
        );
      }
    }

    const releasedLamports = sumReleasedLamports(milestones);
    const totalFundedLamports = Math.max(0, Number(balanceLamports) + releasedLamports);

    const currentUnlockLamports = Number(m.unlockLamports ?? 0);
    const currentUnlockPercent = Number(m.unlockPercent ?? 0);
    const unlockLamports =
      Number.isFinite(currentUnlockLamports) && currentUnlockLamports > 0
        ? Math.floor(currentUnlockLamports)
        : Number.isFinite(currentUnlockPercent) && currentUnlockPercent > 0
          ? Math.floor((totalFundedLamports * currentUnlockPercent) / 100)
          : 0;

    if (!Number.isFinite(unlockLamports) || unlockLamports < 0) {
      return NextResponse.json({ error: "Invalid milestone unlock configuration" }, { status: 400 });
    }

    milestones[idx] = {
      ...m,
      unlockLamports,
      completedAtUnix: nowUnix,
      reviewOpenedAtUnix: matchesEarly ? nowUnix : m.reviewOpenedAtUnix,
      claimableAtUnix: nowUnix + delaySeconds,
    };

    const updated = await updateRewardTotalsAndMilestones({
      id,
      milestones,
      totalFundedLamports,
      status: record.status === "created" ? "active" : record.status,
    });

    return NextResponse.json({
      ok: true,
      nowUnix,
      claimableAtUnix: milestones[idx].claimableAtUnix,
      commitment: publicView(updated),
    });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
