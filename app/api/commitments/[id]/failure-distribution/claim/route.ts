import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { getCommitment, getFailureAllocation, getFailureDistributionByCommitmentId } from "../../../../../lib/escrowStore";
import { checkRateLimit } from "../../../../../lib/rateLimit";
import { getChainUnixTime, getConnection } from "../../../../../lib/solana";
import { apiError } from "../../../../../lib/apiError";
import { runFailureDistributionClaim, toResponse, verifyWalletMessageSignature } from "../../../../../lib/payoutClaimStore";

export const runtime = "nodejs";

function isFailureDistributionPayoutsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_FAILURE_DISTRIBUTION_PAYOUTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function expectedClaimMessage(input: { commitmentId: string; walletPubkey: string; timestampUnix: number }): string {
  return `Ship & Commit\nFailure Voter Claim\nCommitment: ${input.commitmentId}\nWallet: ${input.walletPubkey}\nTimestamp: ${input.timestampUnix}`;
}

function isFreshEnough(nowUnix: number, timestampUnix: number): boolean {
  const skew = Math.abs(nowUnix - timestampUnix);
  return skew <= 5 * 60;
}

export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "failure:claim", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    if (!isFailureDistributionPayoutsEnabled()) {
      return NextResponse.json(
        {
          error: "Failure distribution payouts are disabled",
          hint: "Set CTS_ENABLE_FAILURE_DISTRIBUTION_PAYOUTS=1 (or true) to enable failure claims.",
        },
        { status: 503 }
      );
    }

    const commitmentId = ctx.params.id;

    const body = (await req.json().catch(() => null)) as any;

    const walletPubkey = typeof body?.walletPubkey === "string" ? body.walletPubkey.trim() : "";
    const timestampUnix = Number(body?.timestampUnix);
    const signatureB58 = typeof body?.signatureB58 === "string" ? body.signatureB58.trim() : "";

    if (!walletPubkey) return NextResponse.json({ error: "walletPubkey required" }, { status: 400 });
    if (!Number.isFinite(timestampUnix) || timestampUnix <= 0) return NextResponse.json({ error: "timestampUnix required" }, { status: 400 });
    if (!signatureB58) return NextResponse.json({ error: "signatureB58 required" }, { status: 400 });

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);
    if (!isFreshEnough(nowUnix, timestampUnix)) {
      return NextResponse.json({ error: "Signature timestamp is too old" }, { status: 400 });
    }

    const pk = new PublicKey(walletPubkey);
    const message = expectedClaimMessage({ commitmentId, walletPubkey, timestampUnix });
    if (!verifyWalletMessageSignature({ message, signatureB58, walletPubkey: pk })) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const distribution = await getFailureDistributionByCommitmentId(commitmentId);
    if (!distribution) return NextResponse.json({ error: "No failure distribution found" }, { status: 404 });

    const alloc = await getFailureAllocation({ distributionId: distribution.id, walletPubkey });
    if (!alloc) return NextResponse.json({ error: "Not eligible for this distribution" }, { status: 403 });

    const amountLamports = Number(alloc.amountLamports);
    if (!Number.isFinite(amountLamports) || amountLamports <= 0) {
      return NextResponse.json({ error: "No claimable amount" }, { status: 400 });
    }

    const commitment = await getCommitment(commitmentId);
    if (!commitment) return NextResponse.json({ error: "Commitment not found" }, { status: 404 });

    if (commitment.kind === "creator_reward") {
      return NextResponse.json(
        {
          error: "Creator reward commitments do not use commitment-level failure claims",
          hint: "Use /api/commitments/[id]/milestones/[milestoneId]/failure-distribution/claim instead.",
        },
        { status: 400 }
      );
    }

    const result = await runFailureDistributionClaim({
      table: "failure_distribution_claims",
      distributionId: distribution.id,
      walletPubkey: pk.toBase58(),
      amountLamports,
      commitment,
      nowUnix,
      // Commitment-level pots have no separate reservation ledger; the balance check guards the payout.
      reservedOthersLamports: 0,
    });
    return toResponse(result);
  } catch (e) {
    return apiError(e, "failure-distribution/claim");
  }
}
