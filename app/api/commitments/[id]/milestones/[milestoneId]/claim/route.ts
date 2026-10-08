import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { checkRateLimit } from "../../../../../../lib/rateLimit";
import { auditLog } from "../../../../../../lib/auditLog";
import { apiError } from "../../../../../../lib/apiError";
import { getCommitment } from "../../../../../../lib/escrowStore";
import { runMilestonePayout, toResponse, verifyWalletMessageSignature } from "../../../../../../lib/payoutClaimStore";
import { getSafeErrorMessage } from "../../../../../../lib/safeError";

export const runtime = "nodejs";

/** A signed claim is only accepted within ±5 minutes of its timestamp. */
const CLAIM_MESSAGE_MAX_SKEW_SECONDS = 5 * 60;

function isRewardPayoutsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_REWARD_PAYOUTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function milestoneClaimMessage(input: { commitmentId: string; milestoneId: string; timestampUnix: number }): string {
  return `Ship & Commit\nMilestone Claim\nCommitment: ${input.commitmentId}\nMilestone: ${input.milestoneId}\nTimestamp: ${input.timestampUnix}`;
}

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  const id = ctx.params.id;
  const milestoneId = ctx.params.milestoneId;

  try {
    const rl = await checkRateLimit(req, { keyPrefix: "milestone:claim", limit: 30, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    if (!isRewardPayoutsEnabled()) {
      return NextResponse.json(
        {
          error: "Reward payouts are disabled",
          hint: "Set CTS_ENABLE_REWARD_PAYOUTS=1 (or true) to enable milestone claims.",
        },
        { status: 503 }
      );
    }

    const body = (await req.json().catch(() => null)) as any;

    const record = await getCommitment(id);
    if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (record.kind !== "creator_reward") return NextResponse.json({ error: "Not a reward commitment" }, { status: 400 });
    if (record.status === "failed") return NextResponse.json({ error: "Commitment is failed" }, { status: 409 });
    if (!record.creatorPubkey) return NextResponse.json({ error: "Missing creator pubkey" }, { status: 409 });

    const nowUnix = Math.floor(Date.now() / 1000);
    const signatureB58 = typeof body?.signature === "string" ? body.signature.trim() : "";
    const timestampUnix = Math.floor(Number(body?.timestampUnix));

    if (!signatureB58 || !Number.isFinite(timestampUnix) || timestampUnix <= 0) {
      return NextResponse.json(
        {
          error: !signatureB58 ? "signature required" : "timestampUnix required",
          message: milestoneClaimMessage({ commitmentId: id, milestoneId, timestampUnix: nowUnix }),
          timestampUnix: nowUnix,
          creatorPubkey: record.creatorPubkey,
        },
        { status: 400 }
      );
    }

    if (Math.abs(nowUnix - timestampUnix) > CLAIM_MESSAGE_MAX_SKEW_SECONDS) {
      return NextResponse.json({ error: "Signature timestamp is too old (or in the future); sign a fresh claim message" }, { status: 400 });
    }

    const expectedMessage = milestoneClaimMessage({ commitmentId: id, milestoneId, timestampUnix });
    const providedMessage = typeof body?.message === "string" ? body.message : expectedMessage;
    if (providedMessage !== expectedMessage) {
      return NextResponse.json({ error: "Invalid message" }, { status: 400 });
    }

    const creatorPk = new PublicKey(record.creatorPubkey);
    const ok = verifyWalletMessageSignature({ message: expectedMessage, signatureB58, walletPubkey: creatorPk });
    if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    // The payout claim row (commitment, milestone) is the idempotency key: a replayed signature within the window
    // can only ever re-report the same payout.
    const result = await runMilestonePayout({ commitmentId: id, milestoneId, auditPrefix: "creator_reward_milestone_claim" });
    return toResponse(result);
  } catch (e) {
    await auditLog("creator_reward_milestone_claim_error", { commitmentId: id, milestoneId, error: getSafeErrorMessage(e) }).catch(() => null);
    return apiError(e, "milestone/claim");
  }
}
