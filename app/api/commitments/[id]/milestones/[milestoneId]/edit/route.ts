import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { RewardMilestone, getCommitment, publicView, updateRewardTotalsAndMilestones } from "../../../../../../lib/escrowStore";
import { checkRateLimit } from "../../../../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../../../../lib/safeError";

export const runtime = "nodejs";

function milestoneEditMessage(input: {
  commitmentId: string;
  milestoneId: string;
  requestId: string;
  title: string;
  unlockPercent: number;
  dueAtUnix: number;
}): string {
  return `Ship & Commit\nEdit Milestone\nCommitment: ${input.commitmentId}\nMilestone: ${input.milestoneId}\nRequest: ${input.requestId}\nTitle: ${input.title}\nUnlockPercent: ${input.unlockPercent}\nDueAtUnix: ${input.dueAtUnix}`;
}

function allocatedPercentFromMilestones(input: { milestones: RewardMilestone[]; totalFundedLamports: number }): number {
  const total = Number(input.totalFundedLamports ?? 0);
  return input.milestones.reduce((acc, m) => {
    const explicitLamports = Number(m.unlockLamports ?? 0);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(explicitLamports) && explicitLamports > 0) {
      return acc + (explicitLamports / total) * 100;
    }
    return acc + (Number(m.unlockPercent ?? 0) || 0);
  }, 0);
}

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  const id = ctx.params.id;
  const milestoneId = ctx.params.milestoneId;

  const body = (await req.json().catch(() => null)) as any;

  try {
    const rl = await checkRateLimit(req, { keyPrefix: "milestone:edit", limit: 30, windowSeconds: 60 });
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

    if (record.status === "failed") {
      return NextResponse.json({ error: "Commitment is failed" }, { status: 409 });
    }

    if (!record.creatorPubkey) {
      return NextResponse.json({ error: "Missing creator pubkey" }, { status: 500 });
    }

    const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const unlockPercentRaw = Number(body?.unlockPercent);
    const dueAtUnixRaw = Number(body?.dueAtUnix);

    if (!requestId) return NextResponse.json({ error: "requestId required" }, { status: 400 });
    if (requestId.length > 80) return NextResponse.json({ error: "requestId too long" }, { status: 400 });

    if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
    if (title.length > 80) return NextResponse.json({ error: "title too long (max 80 chars)" }, { status: 400 });

    if (!Number.isFinite(unlockPercentRaw) || unlockPercentRaw <= 0 || unlockPercentRaw > 100) {
      return NextResponse.json({ error: "unlockPercent must be between 1 and 100" }, { status: 400 });
    }

    if (!Number.isFinite(dueAtUnixRaw) || dueAtUnixRaw <= 0) {
      return NextResponse.json({ error: "dueAtUnix required" }, { status: 400 });
    }

    const unlockPercent = Math.floor(unlockPercentRaw);
    const dueAtUnix = Math.floor(dueAtUnixRaw);

    const nowUnix = Math.floor(Date.now() / 1000);
    const maxFutureSeconds = 10 * 365 * 24 * 60 * 60;
    if (dueAtUnix < nowUnix - 60) {
      return NextResponse.json({ error: "dueAtUnix must be in the future" }, { status: 400 });
    }
    if (dueAtUnix > nowUnix + maxFutureSeconds) {
      return NextResponse.json({ error: "dueAtUnix too far in the future" }, { status: 400 });
    }

    const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
    const idx = milestones.findIndex((m: RewardMilestone) => m.id === milestoneId);
    if (idx < 0) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });

    const existing = milestones[idx];
    if ((existing as any).autoKind === "market_cap") {
      return NextResponse.json({ error: "Market cap milestones can't be edited.", code: "auto_milestone" }, { status: 400 });
    }
    if (existing.completedAtUnix != null) {
      return NextResponse.json({ error: "Cannot edit after completion" }, { status: 409 });
    }
    if (existing.status !== "locked") {
      return NextResponse.json({ error: "Cannot edit milestone in current state" }, { status: 409 });
    }

    const signatureB58 = typeof body?.signature === "string" ? body.signature.trim() : "";
    if (!signatureB58) {
      const message = milestoneEditMessage({
        commitmentId: id,
        milestoneId,
        requestId,
        title,
        unlockPercent,
        dueAtUnix,
      });
      return NextResponse.json(
        {
          error: "signature required",
          message,
          creatorPubkey: record.creatorPubkey,
        },
        { status: 400 }
      );
    }

    const expectedMessage = milestoneEditMessage({
      commitmentId: id,
      milestoneId,
      requestId,
      title,
      unlockPercent,
      dueAtUnix,
    });

    const providedMessage = typeof body?.message === "string" ? body.message : expectedMessage;
    if (providedMessage !== expectedMessage) {
      return NextResponse.json({ error: "Invalid message" }, { status: 400 });
    }

    const signature = bs58.decode(signatureB58);
    const creatorPk = new PublicKey(record.creatorPubkey);
    const ok = nacl.sign.detached.verify(new TextEncoder().encode(expectedMessage), signature, creatorPk.toBytes());
    if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    const nextUnlockPercent = unlockPercent;
    const nextDueAtUnix = dueAtUnix;

    const nextMilestones = milestones.slice();
    nextMilestones[idx] = {
      ...existing,
      title,
      unlockPercent: nextUnlockPercent,
      dueAtUnix: nextDueAtUnix,
    };

    const totalFundedLamports = Number(record.totalFundedLamports ?? 0);
    const currentAllocatedPercent = allocatedPercentFromMilestones({ milestones, totalFundedLamports });

    const existingLamports = Number(existing.unlockLamports ?? 0);
    const existingPct =
      Number.isFinite(totalFundedLamports) && totalFundedLamports > 0 && Number.isFinite(existingLamports) && existingLamports > 0
        ? (existingLamports / totalFundedLamports) * 100
        : Number(existing.unlockPercent ?? 0) || 0;

    const totalNext = currentAllocatedPercent - existingPct + unlockPercent;
    if (totalNext > 100.0001) {
      return NextResponse.json({ error: `Total allocation cannot exceed 100% (would be ${totalNext}%).` }, { status: 400 });
    }

    const updated = await updateRewardTotalsAndMilestones({
      id,
      milestones: nextMilestones,
    });

    return NextResponse.json({ ok: true, commitment: publicView(updated) });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
