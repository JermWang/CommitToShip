import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import crypto from "crypto";

import { RewardMilestone, getCommitment, publicView, updateRewardTotalsAndMilestones } from "../../../../../lib/escrowStore";
import { checkRateLimit } from "../../../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../../../lib/safeError";

export const runtime = "nodejs";

function milestoneAddMessage(input: { commitmentId: string; requestId: string; title: string; unlockPercent: number; dueAtUnix: number }): string {
  return `Ship & Commit\nAdd Milestone\nCommitment: ${input.commitmentId}\nRequest: ${input.requestId}\nTitle: ${input.title}\nUnlockPercent: ${input.unlockPercent}\nDueAtUnix: ${input.dueAtUnix}`;
}

function milestoneIdFromRequest(input: { commitmentId: string; requestId: string }): string {
  const h = crypto.createHash("sha256");
  h.update(`${input.commitmentId}:${input.requestId}`, "utf8");
  return h.digest("hex").slice(0, 16);
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

export async function POST(req: Request, ctx: { params: { id: string } }) {
  const id = ctx.params.id;

  const body = (await req.json().catch(() => null)) as any;

  try {
    const rl = await checkRateLimit(req, { keyPrefix: "milestone:add", limit: 20, windowSeconds: 60 });
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
    const unlockPercent = Number(body?.unlockPercent);
    const dueAtUnix = Number(body?.dueAtUnix);

    if (!requestId) return NextResponse.json({ error: "requestId required" }, { status: 400 });
    if (requestId.length > 80) return NextResponse.json({ error: "requestId too long" }, { status: 400 });

    if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
    if (title.length > 80) return NextResponse.json({ error: "title too long (max 80 chars)" }, { status: 400 });

    if (!Number.isFinite(unlockPercent) || unlockPercent <= 0 || unlockPercent > 100) {
      return NextResponse.json({ error: "unlockPercent must be between 1 and 100" }, { status: 400 });
    }

    if (!Number.isFinite(dueAtUnix) || dueAtUnix <= 0) {
      return NextResponse.json({ error: "dueAtUnix required" }, { status: 400 });
    }

    const nowUnix = Math.floor(Date.now() / 1000);
    const maxFutureSeconds = 10 * 365 * 24 * 60 * 60;
    if (dueAtUnix < nowUnix - 60) {
      return NextResponse.json({ error: "dueAtUnix must be in the future" }, { status: 400 });
    }
    if (dueAtUnix > nowUnix + maxFutureSeconds) {
      return NextResponse.json({ error: "dueAtUnix too far in the future" }, { status: 400 });
    }

    const signatureB58 = typeof body?.signature === "string" ? body.signature.trim() : "";
    if (!signatureB58) {
      const message = milestoneAddMessage({
        commitmentId: id,
        requestId,
        title,
        unlockPercent: Math.floor(unlockPercent),
        dueAtUnix: Math.floor(dueAtUnix),
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

    const expectedMessage = milestoneAddMessage({
      commitmentId: id,
      requestId,
      title,
      unlockPercent: Math.floor(unlockPercent),
      dueAtUnix: Math.floor(dueAtUnix),
    });
    const providedMessage = typeof body?.message === "string" ? body.message : expectedMessage;
    if (providedMessage !== expectedMessage) {
      return NextResponse.json({ error: "Invalid message" }, { status: 400 });
    }

    const signature = bs58.decode(signatureB58);
    const creatorPk = new PublicKey(record.creatorPubkey);
    const ok = nacl.sign.detached.verify(new TextEncoder().encode(expectedMessage), signature, creatorPk.toBytes());
    if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
    if (milestones.length >= 50) {
      return NextResponse.json({ error: "Maximum 50 milestones allowed" }, { status: 400 });
    }

    const currentAllocatedPercent = allocatedPercentFromMilestones({ milestones, totalFundedLamports: Number(record.totalFundedLamports ?? 0) });
    const totalNext = currentAllocatedPercent + Math.floor(unlockPercent);
    if (totalNext > 100.0001) {
      return NextResponse.json({ error: `Total allocation cannot exceed 100% (would be ${totalNext}%).` }, { status: 400 });
    }

    const milestoneId = milestoneIdFromRequest({ commitmentId: id, requestId });
    const existingIdx = milestones.findIndex((m) => m.id === milestoneId);
    if (existingIdx >= 0) {
      return NextResponse.json({ ok: true, duplicate: true, commitment: publicView(record) });
    }

    milestones.push({
      id: milestoneId,
      title,
      unlockLamports: 0,
      unlockPercent: Math.floor(unlockPercent),
      dueAtUnix: Math.floor(dueAtUnix),
      status: "locked",
    });

    const updated = await updateRewardTotalsAndMilestones({
      id,
      milestones,
      status: record.status === "completed" ? "active" : record.status,
    });

    return NextResponse.json({ ok: true, milestoneId, commitment: publicView(updated) });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
