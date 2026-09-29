import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import {
  getCommitment,
  getEscrowSignerRef,
  getMilestoneFailureAllocation,
  getMilestoneFailureDistribution,
  setMilestoneFailureDistributionClaimTxSig,
  releaseMilestoneFailureDistributionClaim,
  tryAcquireMilestoneFailureDistributionClaim,
} from "../../../../../../../lib/escrowStore";
import { checkRateLimit } from "../../../../../../../lib/rateLimit";
import {
  getChainUnixTime,
  findRecentSystemTransferSignature,
  getConnection,
  keypairFromBase58Secret,
  transferLamports,
  transferLamportsFromPrivyWallet,
} from "../../../../../../../lib/solana";
import { getSafeErrorMessage } from "../../../../../../../lib/safeError";

export const runtime = "nodejs";

function isMilestoneFailureDistributionPayoutsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_FAILURE_DISTRIBUTION_PAYOUTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function expectedClaimMessage(input: {
  commitmentId: string;
  milestoneId: string;
  walletPubkey: string;
  timestampUnix: number;
}): string {
  return `Ship & Commit\nMilestone Failure Voter Claim\nCommitment: ${input.commitmentId}\nMilestone: ${input.milestoneId}\nWallet: ${input.walletPubkey}\nTimestamp: ${input.timestampUnix}`;
}

function isFreshEnough(nowUnix: number, timestampUnix: number): boolean {
  const skew = Math.abs(nowUnix - timestampUnix);
  return skew <= 5 * 60;
}

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "milestone-failure:claim", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    if (!isMilestoneFailureDistributionPayoutsEnabled()) {
      return NextResponse.json(
        {
          error: "Milestone failure payouts are disabled",
          hint: "Set CTS_ENABLE_FAILURE_DISTRIBUTION_PAYOUTS=1 (or true) to enable milestone failure claims.",
        },
        { status: 503 }
      );
    }

    const commitmentId = ctx.params.id;
    const milestoneId = ctx.params.milestoneId;

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
    const sigBytes = bs58.decode(signatureB58);
    const message = expectedClaimMessage({ commitmentId, milestoneId, walletPubkey, timestampUnix });

    const ok = nacl.sign.detached.verify(new TextEncoder().encode(message), sigBytes, pk.toBytes());
    if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    const distribution = await getMilestoneFailureDistribution({ commitmentId, milestoneId });
    if (!distribution) return NextResponse.json({ error: "No milestone failure distribution found" }, { status: 404 });

    const alloc = await getMilestoneFailureAllocation({ distributionId: distribution.id, walletPubkey });
    if (!alloc) return NextResponse.json({ error: "Not eligible for this distribution" }, { status: 403 });

    const amountLamports = Number(alloc.amountLamports);
    if (!Number.isFinite(amountLamports) || amountLamports <= 0) {
      return NextResponse.json({ error: "No claimable amount" }, { status: 400 });
    }

    const commitment = await getCommitment(commitmentId);
    if (!commitment) return NextResponse.json({ error: "Commitment not found" }, { status: 404 });

    const escrowRef = getEscrowSignerRef(commitment);
    const fromPubkey = new PublicKey(commitment.escrowPubkey);

    const claimed = await tryAcquireMilestoneFailureDistributionClaim({
      distributionId: distribution.id,
      walletPubkey,
      claimedAtUnix: nowUnix,
      amountLamports,
    });

    if (!claimed.acquired) {
      const existing = claimed.existing;
      if (Number(existing.amountLamports) !== amountLamports) {
        return NextResponse.json(
          {
            error: "Existing claim has mismatched amount",
            existing,
            expectedAmountLamports: amountLamports,
          },
          { status: 409 }
        );
      }

      if (existing.txSig) {
        return NextResponse.json({
          ok: true,
          idempotent: true,
          nowUnix,
          signature: existing.txSig,
          amountLamports,
          distributionId: distribution.id,
        });
      }

      return NextResponse.json({ error: "Already claimed" }, { status: 409 });
    }

    let signature: string;
    try {
      ({ signature } =
        escrowRef.kind === "privy"
          ? await transferLamportsFromPrivyWallet({ connection, walletId: escrowRef.walletId, fromPubkey, to: pk, lamports: amountLamports })
          : await transferLamports({ connection, from: keypairFromBase58Secret(escrowRef.escrowSecretKeyB58), to: pk, lamports: amountLamports }));
    } catch (transferErr) {
      // The claim row was reserved before sending. If the payout clearly did not land, release it so the voter can
      // retry; if it did land (e.g. confirmation timed out), record the signature instead of paying twice.
      let landedSig: string | null = null;
      try {
        landedSig = await findRecentSystemTransferSignature({ connection, fromPubkey, toPubkey: pk, lamports: amountLamports, limit: 10 });
      } catch {
        landedSig = null;
      }
      if (landedSig) {
        await setMilestoneFailureDistributionClaimTxSig({ distributionId: distribution.id, walletPubkey, txSig: landedSig });
        return NextResponse.json({ ok: true, recovered: true, nowUnix, signature: landedSig, amountLamports, distributionId: distribution.id });
      }
      await releaseMilestoneFailureDistributionClaim({ distributionId: distribution.id, walletPubkey }).catch(() => null);
      throw transferErr;
    }

    await setMilestoneFailureDistributionClaimTxSig({ distributionId: distribution.id, walletPubkey, txSig: signature });

    return NextResponse.json({ ok: true, nowUnix, signature, amountLamports, distributionId: distribution.id });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
