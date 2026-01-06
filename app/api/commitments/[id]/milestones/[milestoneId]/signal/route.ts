import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import {
  RewardMilestone,
  getCommitment,
  getRewardApprovalThreshold,
  getRewardMilestoneVoteCounts,
  normalizeRewardMilestonesClaimable,
  publicView,
  updateRewardTotalsAndMilestones,
  upsertRewardMilestoneSignal,
  upsertRewardVoterSnapshot,
} from "../../../../../../lib/escrowStore";
import { getChainUnixTime, getConnection, getTokenBalanceForMint, hasAnyTokenBalanceForMint } from "../../../../../../lib/solana";
import { getCachedJupiterPriceUsd, getCachedJupiterPriceUsdAllowStale, setCachedJupiterPriceUsd } from "../../../../../../lib/priceCache";
import { checkRateLimit } from "../../../../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../../../../lib/safeError";

export const runtime = "nodejs";

function isCanaryRewardVoting(): boolean {
  const raw = String(process.env.CTS_CANARY_REWARD_VOTING ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function milestoneSignalMessage(input: { commitmentId: string; milestoneId: string; vote: "approve" | "reject" }): string {
  const vote = input.vote === "reject" ? "reject" : "approve";
  const title = vote === "reject" ? "Milestone Reject Signal" : "Milestone Approval Signal";
  return `Commit To Ship\n${title}\nCommitment: ${input.commitmentId}\nMilestone: ${input.milestoneId}\nVote: ${vote}`;
}

function legacyApproveSignalMessage(input: { commitmentId: string; milestoneId: string }): string {
  return `Commit To Ship\nMilestone Approval Signal\nCommitment: ${input.commitmentId}\nMilestone: ${input.milestoneId}`;
}

function getVoteCutoffSeconds(): number {
  const raw = Number(process.env.REWARD_VOTE_CUTOFF_SECONDS ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 24 * 60 * 60;
}

function getVoteWindowUnix(input: { milestone: RewardMilestone; cutoffSeconds: number }): { startUnix: number; endUnix: number } | null {
  const completedAtUnix = Number(input.milestone.completedAtUnix ?? 0);
  if (!Number.isFinite(completedAtUnix) || completedAtUnix <= 0) return null;
  const reviewOpenedAtUnix = Number((input.milestone as any).reviewOpenedAtUnix ?? 0);
  const dueAtUnix = Number((input.milestone as any).dueAtUnix ?? 0);
  const hasReview = Number.isFinite(reviewOpenedAtUnix) && reviewOpenedAtUnix > 0;
  const hasDue = Number.isFinite(dueAtUnix) && dueAtUnix > 0;

  const startUnix = hasReview
    ? Math.floor(reviewOpenedAtUnix)
    : hasDue
      ? Math.floor(dueAtUnix)
      : completedAtUnix;

  const endUnix = hasReview
    ? startUnix + input.cutoffSeconds
    : hasDue
      ? Math.floor(dueAtUnix) + input.cutoffSeconds
      : completedAtUnix + input.cutoffSeconds;
  if (!Number.isFinite(endUnix) || endUnix <= startUnix) return null;
  return { startUnix, endUnix };
}

function shipMultiplierBpsFromUiAmount(shipUiAmount: number): number {
  if (!Number.isFinite(shipUiAmount) || shipUiAmount <= 0) return 10000;
  if (shipUiAmount >= 10_000_000) return 20000;
  if (shipUiAmount >= 100_000) return 13000;
  return 10000;
}

async function getJupiterUsdPriceForMint(mint: string): Promise<number | null> {
  const url = `https://price.jup.ag/v4/price?ids=${encodeURIComponent(mint)}`;
  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json().catch(() => null)) as any;
  const price = json?.data?.[mint]?.price;
  if (typeof price === "number" && Number.isFinite(price) && price > 0) return price;
  return null;
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

    const signatureB58 = typeof body?.signature === "string" ? body.signature.trim() : "";
    if (!signatureB58) {
      const message = milestoneSignalMessage({ commitmentId: id, milestoneId, vote });
      return NextResponse.json(
        {
          error: "signature required",
          code: "signature_required",
          hint: "Sign the message with the same wallet you are voting from.",
          message,
          signerPubkey: signerB58,
        },
        { status: 400 }
      );
    }

    const expectedMessage = milestoneSignalMessage({ commitmentId: id, milestoneId, vote });
    const providedMessage = typeof body?.message === "string" ? body.message : expectedMessage;

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
      return NextResponse.json(
        {
          error: "Invalid signature encoding",
          code: "invalid_signature_encoding",
          hint: "Please re-sign the message and try again.",
        },
        { status: 400 }
      );
    }

    const ok = (() => {
      if (providedMessage === expectedMessage) {
        return nacl.sign.detached.verify(new TextEncoder().encode(expectedMessage), signature, signerPk.toBytes());
      }
      if (vote === "approve") {
        const legacy = legacyApproveSignalMessage({ commitmentId: id, milestoneId });
        if (providedMessage === legacy) {
          return nacl.sign.detached.verify(new TextEncoder().encode(legacy), signature, signerPk.toBytes());
        }
      }
      return false;
    })();
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

    const cutoffSeconds = getVoteCutoffSeconds();
    const window = getVoteWindowUnix({ milestone, cutoffSeconds });
    if (!window) {
      return NextResponse.json(
        {
          error: "Invalid vote window",
          code: "invalid_vote_window",
        },
        { status: 500 }
      );
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

    const withinCutoff = true;

    let projectUiAmount = 0;
    let shipUiAmount = 0;
    let shipMultiplierBps = 10000;
    let projectPriceUsd = 0;
    let projectValueUsd = 0;

    if (record.tokenMint) {
      const mintPk = new PublicKey(record.tokenMint);

      const isHolder = await hasAnyTokenBalanceForMint({ connection, owner: signerPk, mint: mintPk });
      if (!isHolder) {
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

      const bal = await getTokenBalanceForMint({ connection, owner: signerPk, mint: mintPk });
      if (bal.uiAmount <= 0) {
        return NextResponse.json(
          {
            error: "You have no balance of the project token",
            code: "no_token_balance",
            hint: "Switch wallets or acquire the project token to vote.",
            tokenMint: mintPk.toBase58(),
            signerPubkey: signerPk.toBase58(),
          },
          { status: 403 }
        );
      }

      projectUiAmount = bal.uiAmount;

      if (isCanaryRewardVoting()) {
        // Canary mode: allow any non-zero holder to vote without requiring
        // price feeds or a minimum USD value.
        projectPriceUsd = 0;
        projectValueUsd = 1;
      } else {
        const minUsd = 20;

        const mintB58 = mintPk.toBase58();
        let priceUsd = await getCachedJupiterPriceUsd(mintB58);
        if (priceUsd == null) {
          priceUsd = await getJupiterUsdPriceForMint(mintB58);
          if (priceUsd != null) {
            await setCachedJupiterPriceUsd(mintB58, priceUsd);
          }
        }

        if (priceUsd == null) {
          priceUsd = await getCachedJupiterPriceUsdAllowStale(mintB58);
        }

        // Fallback: If price is unavailable, allow voting with minimum token balance check
        // This prevents price feed outages from blocking voting entirely
        const minTokensForFallback = 1000; // Minimum tokens required if no price available
        
        if (priceUsd == null) {
          // Price unavailable - use token balance fallback
          if (bal.uiAmount < minTokensForFallback) {
            return NextResponse.json(
              {
                error: "Token price unavailable and holdings below minimum token threshold",
                code: "price_unavailable_insufficient_tokens",
                minTokensForFallback,
                uiAmount: bal.uiAmount,
                hint: "Price feed is temporarily unavailable. You need at least " + minTokensForFallback + " tokens to vote.",
              },
              { status: 403 }
            );
          }
          // Allow voting with fallback - use minUsd as the assumed value
          projectPriceUsd = 0;
          projectValueUsd = minUsd; // Assign minimum value for voting weight
        } else {
          const valueUsd = bal.uiAmount * priceUsd;
          projectPriceUsd = priceUsd;
          projectValueUsd = valueUsd;
          if (!Number.isFinite(valueUsd) || valueUsd <= minUsd) {
            return NextResponse.json(
              {
                error: "Token holdings below minimum required value to vote",
                code: "insufficient_holdings_value",
                hint: "Switch to a wallet with a larger position in the project token.",
                minUsd,
                priceUsd,
                uiAmount: bal.uiAmount,
                valueUsd,
              },
              { status: 403 }
            );
          }
        }
      }

      const shipMint = String(process.env.CTS_SHIP_TOKEN_MINT ?? "").trim();
      if (shipMint.length) {
        try {
          const shipMintPk = new PublicKey(shipMint);
          const shipBal = await getTokenBalanceForMint({ connection, owner: signerPk, mint: shipMintPk });
          shipUiAmount = shipBal.uiAmount;
          shipMultiplierBps = shipMultiplierBpsFromUiAmount(shipUiAmount);
        } catch {
          shipUiAmount = 0;
          shipMultiplierBps = 10000;
        }
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
    });

    if (withinCutoff && record.tokenMint) {
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
    }

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

    const updated = normalized.changed
      ? await updateRewardTotalsAndMilestones({
          id,
          milestones: normalized.milestones,
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
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
