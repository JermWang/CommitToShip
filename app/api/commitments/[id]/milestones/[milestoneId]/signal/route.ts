import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import {
  RewardMilestone,
  getCommitment,
  getRewardApprovalThreshold,
  getRewardMilestoneVoteCounts,
  getRewardMilestoneVoteWindow,
  getRewardVoteCutoffSeconds,
  normalizeRewardMilestonesClaimable,
  publicView,
  updateRewardTotalsAndMilestones,
  upsertRewardMilestoneSignal,
  upsertRewardVoterSnapshot,
} from "../../../../../../lib/escrowStore";
import { getChainUnixTime, getConnection, getTokenBalanceForMint } from "../../../../../../lib/solana";
import { resolveTokenUsdPrice } from "../../../../../../lib/priceCache";
import { checkRateLimit } from "../../../../../../lib/rateLimit";
import { getSafeErrorMessage, redactSensitive } from "../../../../../../lib/safeError";

export const runtime = "nodejs";

/** Minimum position (USD, at the vote-time price) a wallet must hold to vote - and still hold when the window closes. */
const MIN_VOTE_USD = 20;

/** How far a signed vote's timestamp may be from the server clock. */
const VOTE_SIGNATURE_MAX_AGE_SECONDS = 10 * 60;

function isCanaryRewardVoting(): boolean {
  const raw = String(process.env.CTS_CANARY_REWARD_VOTING ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** The vote message binds the vote and a timestamp (votes expire: a signature is only accepted for ±10 minutes). */
function milestoneSignalMessage(input: { commitmentId: string; milestoneId: string; vote: "approve" | "reject"; timestampUnix: number }): string {
  const vote = input.vote === "reject" ? "reject" : "approve";
  const title = vote === "reject" ? "Milestone Reject Signal" : "Milestone Approval Signal";
  return `Ship & Commit\n${title}\nCommitment: ${input.commitmentId}\nMilestone: ${input.milestoneId}\nVote: ${vote}\nTimestamp: ${Math.floor(input.timestampUnix)}`;
}

function shipMultiplierBpsFromUiAmount(shipUiAmount: number): number {
  if (!Number.isFinite(shipUiAmount) || shipUiAmount <= 0) return 10000;
  if (shipUiAmount >= 10_000_000) return 20000;
  if (shipUiAmount >= 100_000) return 13000;
  return 10000;
}

/** ceil(minUsd / priceUsd) in raw token units, or null when it cannot be represented sensibly. */
function minAmountRawForUsd(input: { minUsd: number; priceUsd: number; decimals: number }): bigint | null {
  const { minUsd, priceUsd, decimals } = input;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const raw = Math.ceil((minUsd / priceUsd) * 10 ** decimals);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1e30) return null;
  try {
    return BigInt(raw.toLocaleString("fullwide", { useGrouping: false }));
  } catch {
    return null;
  }
}

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  const id = ctx.params.id;
  const milestoneId = ctx.params.milestoneId;

  const body = (await req.json().catch(() => null)) as any;

  try {
    const rl = await checkRateLimit(req, { keyPrefix: "milestone:signal", limit: 60, windowSeconds: 60 });
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

    if (!record.tokenMint) {
      return NextResponse.json(
        {
          error: "Token mint required for holder voting",
          code: "token_mint_required",
          hint: "This project is missing a token mint. Ask the creator/admin to set the project token mint before voting.",
        },
        { status: 400 }
      );
    }

    const signerB58 = typeof body?.signerPubkey === "string" ? body.signerPubkey.trim() : "";
    if (!signerB58) {
      return NextResponse.json(
        {
          error: "signerPubkey required",
          code: "signer_pubkey_required",
          hint: "Connect your wallet and try again.",
        },
        { status: 400 }
      );
    }

    const vote: "approve" | "reject" = String(body?.vote ?? "approve") === "reject" ? "reject" : "approve";
    const serverNowUnix = Math.floor(Date.now() / 1000);

    const signatureB58 = typeof body?.signature === "string" ? body.signature.trim() : "";
    if (!signatureB58) {
      const message = milestoneSignalMessage({ commitmentId: id, milestoneId, vote, timestampUnix: serverNowUnix });
      return NextResponse.json(
        {
          error: "signature required",
          code: "signature_required",
          hint: "Sign the message with the same wallet you are voting from.",
          message,
          timestampUnix: serverNowUnix,
          signerPubkey: signerB58,
        },
        { status: 400 }
      );
    }

    let signerPk: PublicKey;
    try {
      signerPk = new PublicKey(signerB58);
    } catch {
      return NextResponse.json(
        {
          error: "Invalid signer pubkey",
          code: "invalid_signer_pubkey",
          hint: "Connect the correct wallet and try again.",
          signerPubkey: signerB58,
        },
        { status: 400 }
      );
    }

    let signature: Uint8Array;
    try {
      signature = bs58.decode(signatureB58);
    } catch {
      signature = new Uint8Array(0);
    }
    if (signature.length !== nacl.sign.signatureLength) {
      return NextResponse.json(
        {
          error: "Invalid signature encoding",
          code: "invalid_signature_encoding",
          hint: "Please re-sign the message and try again.",
        },
        { status: 400 }
      );
    }

    const timestampUnix = Math.floor(Number(body?.timestampUnix));
    if (!Number.isFinite(timestampUnix) || timestampUnix <= 0) {
      return NextResponse.json(
        {
          error: "timestampUnix required",
          code: "timestamp_required",
          hint: "Votes now include a timestamp. Refresh the page and sign again.",
          message: milestoneSignalMessage({ commitmentId: id, milestoneId, vote, timestampUnix: serverNowUnix }),
          timestampUnix: serverNowUnix,
        },
        { status: 400 }
      );
    }
    if (Math.abs(serverNowUnix - timestampUnix) > VOTE_SIGNATURE_MAX_AGE_SECONDS) {
      return NextResponse.json(
        { error: "Vote signature expired", code: "signature_expired", hint: "Sign the vote again.", nowUnix: serverNowUnix },
        { status: 400 }
      );
    }

    const expectedMessage = milestoneSignalMessage({ commitmentId: id, milestoneId, vote, timestampUnix });
    const providedMessage = typeof body?.message === "string" ? body.message : expectedMessage;
    if (providedMessage !== expectedMessage) {
      return NextResponse.json(
        { error: "Invalid message", code: "invalid_message", hint: "Refresh the page and sign the vote again.", message: expectedMessage },
        { status: 400 }
      );
    }

    const ok = nacl.sign.detached.verify(new TextEncoder().encode(expectedMessage), signature, signerPk.toBytes());
    if (!ok) {
      return NextResponse.json(
        {
          error: "Invalid signature",
          code: "invalid_signature",
          hint: "Make sure you are signing with the same wallet as signerPubkey (you may be connected to the wrong wallet).",
          signerPubkey: signerB58,
        },
        { status: 401 }
      );
    }

    try {
      if (record.creatorPubkey) {
        const creatorPk = new PublicKey(String(record.creatorPubkey));
        if (creatorPk.equals(signerPk)) {
          return NextResponse.json(
            {
              error: "Creators cannot vote on their own milestones",
              code: "creator_self_vote_blocked",
            },
            { status: 403 }
          );
        }
      }
    } catch {
    }

    const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
    const idx = milestones.findIndex((m: RewardMilestone) => m.id === milestoneId);
    if (idx < 0) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });

    const milestone = milestones[idx];
    if (String((milestone as any)?.autoKind ?? "") === "market_cap") {
      return NextResponse.json(
        {
          error: "Voting is disabled for market cap milestones",
          code: "vote_disabled_marketcap",
          hint: "This milestone is auto-resolved by the platform based on market cap. No holder voting is required.",
        },
        { status: 409 }
      );
    }

    if (milestone.status === "released") {
      return NextResponse.json(
        {
          error: "Milestone already released",
          code: "milestone_already_released",
          hint: "This milestone has already been paid out. Voting is no longer possible.",
        },
        { status: 409 }
      );
    }

    if (milestone.status !== "locked") {
      return NextResponse.json(
        {
          error: "Milestone is not in a votable state",
          code: "milestone_not_votable",
          hint: "Voting is only available while a milestone is pending holder approval.",
          status: milestone.status,
        },
        { status: 409 }
      );
    }
    if (milestone.completedAtUnix == null) {
      return NextResponse.json(
        {
          error: "Milestone not marked complete yet",
          code: "milestone_not_completed",
          hint: "Voting is only available after the creator marks the milestone complete (turns it in).",
        },
        { status: 400 }
      );
    }

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);

    const window = getRewardMilestoneVoteWindow(milestone, getRewardVoteCutoffSeconds());
    if (!window) {
      return NextResponse.json({ error: "Invalid vote window", code: "invalid_vote_window" }, { status: 409 });
    }

    if (nowUnix < window.startUnix) {
      return NextResponse.json(
        {
          error: "Voting is not open yet",
          code: "vote_not_open",
          hint: "Voting opens at the milestone deadline (and only if the creator has turned it in).",
          nowUnix,
          voteStartUnix: window.startUnix,
          voteEndUnix: window.endUnix,
        },
        { status: 409 }
      );
    }

    if (nowUnix >= window.endUnix) {
      return NextResponse.json(
        {
          error: "Voting window has closed",
          code: "vote_closed",
          hint: "The voting window has ended for this milestone.",
          nowUnix,
          voteStartUnix: window.startUnix,
          voteEndUnix: window.endUnix,
        },
        { status: 409 }
      );
    }

    let mintPk: PublicKey;
    try {
      mintPk = new PublicKey(record.tokenMint);
    } catch {
      return NextResponse.json(
        {
          error: "Invalid project token mint",
          code: "invalid_token_mint",
          hint: "This project has an invalid token mint configured. Ask the creator/admin to fix the token mint before voting.",
        },
        { status: 400 }
      );
    }

    let bal: { uiAmount: number; amountRaw: bigint; decimals: number };
    try {
      bal = await getTokenBalanceForMint({ connection, owner: signerPk, mint: mintPk });
    } catch {
      return NextResponse.json(
        {
          error: "RPC error while fetching token balance",
          code: "rpc_error",
          hint: "Voting is temporarily unavailable due to an RPC error. Please try again in a moment.",
        },
        { status: 503 }
      );
    }
    if (bal.amountRaw <= 0n) {
      return NextResponse.json(
        {
          error: "You are not a holder of the project token",
          code: "not_token_holder",
          hint: "Switch to a wallet that holds this project's token, then try again.",
          tokenMint: mintPk.toBase58(),
          signerPubkey: signerPk.toBase58(),
        },
        { status: 403 }
      );
    }

    const projectUiAmount = bal.uiAmount;
    let projectPriceUsd = 0;
    let projectValueUsd = 0;
    // The minimum the wallet must STILL hold when the window closes (re-checked then; see escrowStore).
    let minAmountRaw: bigint;

    if (isCanaryRewardVoting()) {
      // Canary mode: any non-zero holder may vote (no price feed / USD minimum); at close it must still hold > 0.
      projectValueUsd = 1;
      minAmountRaw = 1n;
    } else {
      // No token-count fallback: without a price (Jupiter -> DexScreener -> pump.fun bonding curve on-chain -> recent
      // cache) the $20 minimum cannot be verified, so the wallet is not eligible to vote right now.
      const price = await resolveTokenUsdPrice(mintPk.toBase58());
      if (!price) {
        return NextResponse.json(
          {
            error: "Token price unavailable, so the $20 voting minimum cannot be verified",
            code: "price_unavailable",
            hint: "No price source (Jupiter, DexScreener or the on-chain bonding curve) has a price for this token right now. Try again later.",
          },
          { status: 503 }
        );
      }
      const valueUsd = bal.uiAmount * price.priceUsd;
      projectPriceUsd = price.priceUsd;
      projectValueUsd = valueUsd;
      const min = minAmountRawForUsd({ minUsd: MIN_VOTE_USD, priceUsd: price.priceUsd, decimals: bal.decimals });
      if (!Number.isFinite(valueUsd) || valueUsd <= MIN_VOTE_USD || min == null) {
        return NextResponse.json(
          {
            error: "Token holdings below minimum required value to vote",
            code: "insufficient_holdings_value",
            hint: "Switch to a wallet with a larger position in the project token.",
            minUsd: MIN_VOTE_USD,
            priceUsd: price.priceUsd,
            uiAmount: bal.uiAmount,
            valueUsd,
          },
          { status: 403 }
        );
      }
      minAmountRaw = min > bal.amountRaw ? bal.amountRaw : min;
    }

    let shipUiAmount = 0;
    let shipMultiplierBps = 10000;
    const shipMint = String(process.env.CTS_SHIP_TOKEN_MINT ?? "").trim();
    if (shipMint.length) {
      try {
        const shipBal = await getTokenBalanceForMint({ connection, owner: signerPk, mint: new PublicKey(shipMint) });
        shipUiAmount = shipBal.uiAmount;
        shipMultiplierBps = shipMultiplierBpsFromUiAmount(shipUiAmount);
      } catch {
        shipUiAmount = 0;
        shipMultiplierBps = 10000;
      }
    }

    const { inserted } = await upsertRewardMilestoneSignal({
      commitmentId: id,
      milestoneId,
      signerPubkey: signerPk.toBase58(),
      vote,
      createdAtUnix: nowUnix,
      projectPriceUsd,
      projectValueUsd,
      voteAmountRaw: bal.amountRaw.toString(),
      tokenDecimals: bal.decimals,
      minAmountRaw: minAmountRaw.toString(),
    });

    // Vote rewards are NOT allocated here: they are created once per milestone after the window closes and every
    // voter's holdings were re-checked (lib/voteRewardDistributions.ts), so nothing is claimable while voting is open.

    await upsertRewardVoterSnapshot({
      commitmentId: id,
      milestoneId,
      signerPubkey: signerPk.toBase58(),
      createdAtUnix: nowUnix,
      projectMint: record.tokenMint,
      projectUiAmount,
      projectPriceUsd,
      projectValueUsd,
      shipUiAmount,
      shipMultiplierBps,
    });

    const voteCounts = await getRewardMilestoneVoteCounts(id);
    const approvalCounts = voteCounts.approvalCounts;
    const approvalThreshold = getRewardApprovalThreshold();

    const normalized = normalizeRewardMilestonesClaimable({
      milestones,
      nowUnix,
      approvalCounts,
      rejectCounts: voteCounts.rejectCounts,
      approvalThreshold,
      pendingCloseRecheck: voteCounts.pendingCloseRecheck,
    });

    // Compare-and-swap on the milestones we read: a concurrent completion/release/vote is never clobbered.
    const updated = normalized.changed
      ? await updateRewardTotalsAndMilestones({
          id,
          milestones: normalized.milestones,
          expectedMilestones: record.milestones ?? [],
        })
      : record;

    return NextResponse.json({
      ok: true,
      inserted,
      nowUnix,
      approvalCounts,
      approvalThreshold,
      commitment: publicView(updated),
    });
  } catch (e) {
    try {
      const raw = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
      console.error("milestone_signal_error", {
        commitmentId: id,
        milestoneId,
        signerPubkey: typeof body?.signerPubkey === "string" ? body.signerPubkey : undefined,
        vote: typeof body?.vote === "string" ? body.vote : undefined,
        error: redactSensitive(raw),
      });
    } catch {
    }
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
