import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { RewardMilestone, getCommitment, publicView, updateRewardTotalsAndMilestones } from "../../../../../../lib/escrowStore";
import { getChainUnixTime, getConnection } from "../../../../../../lib/solana";
import { getSafeErrorMessage } from "../../../../../../lib/safeError";

export const runtime = "nodejs";

function getClaimDelaySeconds(): number {
  const raw = Number(process.env.REWARD_CLAIM_DELAY_SECONDS ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 48 * 60 * 60;
}

function milestoneCompleteMessage(input: { commitmentId: string; milestoneId: string }): string {
  return `Commit To Ship\nMilestone Completion\nCommitment: ${input.commitmentId}\nMilestone: ${input.milestoneId}`;
}

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  const id = ctx.params.id;
  const milestoneId = ctx.params.milestoneId;

  const body = (await req.json().catch(() => null)) as any;

  try {
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

    const signatureB58 = typeof body?.signature === "string" ? body.signature.trim() : "";
    if (!signatureB58) {
      const message = milestoneCompleteMessage({ commitmentId: id, milestoneId });
      return NextResponse.json({
        error: "signature required",
        message,
        creatorPubkey: record.creatorPubkey,
      }, { status: 400 });
    }

    const expectedMessage = milestoneCompleteMessage({ commitmentId: id, milestoneId });
    const providedMessage = typeof body?.message === "string" ? body.message : expectedMessage;
    if (providedMessage !== expectedMessage) {
      return NextResponse.json({ error: "Invalid message" }, { status: 400 });
    }

    const signature = bs58.decode(signatureB58);
    const creatorPk = new PublicKey(record.creatorPubkey);

    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(expectedMessage),
      signature,
      creatorPk.toBytes()
    );

    if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);
    const delaySeconds = getClaimDelaySeconds();

    const m = milestones[idx];
    if (m.status === "released") {
      return NextResponse.json({ error: "Already released", commitment: publicView(record) }, { status: 409 });
    }

    if (m.completedAtUnix != null) {
      return NextResponse.json({ error: "Already marked complete", commitment: publicView(record) }, { status: 409 });
    }

    milestones[idx] = {
      ...m,
      completedAtUnix: nowUnix,
      claimableAtUnix: nowUnix + delaySeconds,
    };

    const updated = await updateRewardTotalsAndMilestones({
      id,
      milestones,
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
