import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import crypto from "crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { RewardMilestone, getCommitment, publicView, updateRewardTotalsAndMilestones } from "../../../../../lib/escrowStore";
import { checkRateLimit } from "../../../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../../../lib/safeError";
import { fetchDexScreenerPairsByTokenMint, pickBestDexScreenerPair } from "../../../../../lib/dexScreener";

export const runtime = "nodejs";

function milestoneAddMarketCapMessage(input: {
  commitmentId: string;
  requestId: string;
  title: string;
  unlockPercent: number;
  thresholdUsd: number;
}): string {
  return `Ship & Commit\nAdd Market Cap Milestone\nCommitment: ${input.commitmentId}\nRequest: ${input.requestId}\nTitle: ${input.title}\nUnlockPercent: ${input.unlockPercent}\nThresholdUsd: ${input.thresholdUsd}`;
}

function milestoneIdFromRequest(input: { commitmentId: string; requestId: string }): string {
  const h = crypto.createHash("sha256");
  h.update(`${input.commitmentId}:${input.requestId}`, "utf8");
  return h.digest("hex").slice(0, 16);
}

function sumUnlockPercents(milestones: RewardMilestone[]): number {
  return milestones.reduce((acc, m) => acc + (Number(m.unlockPercent ?? 0) || 0), 0);
}

export async function POST(req: Request, ctx: { params: { id: string } }) {
  const id = ctx.params.id;

  const body = (await req.json().catch(() => null)) as any;

  try {
    const rl = await checkRateLimit(req, { keyPrefix: "milestone:add-marketcap", limit: 20, windowSeconds: 60 });
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

    if (!record.tokenMint) {
      return NextResponse.json({ error: "tokenMint required for market cap milestones" }, { status: 400 });
    }

    const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const unlockPercentRaw = Number(body?.unlockPercent);
    const thresholdUsdRaw = Number(body?.thresholdUsd);

    if (!requestId) return NextResponse.json({ error: "requestId required" }, { status: 400 });
    if (requestId.length > 80) return NextResponse.json({ error: "requestId too long" }, { status: 400 });

    if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
    if (title.length > 80) return NextResponse.json({ error: "title too long (max 80 chars)" }, { status: 400 });

    if (!Number.isFinite(unlockPercentRaw) || unlockPercentRaw <= 0 || unlockPercentRaw > 100) {
      return NextResponse.json({ error: "unlockPercent must be between 1 and 100" }, { status: 400 });
    }

    if (!Number.isFinite(thresholdUsdRaw) || thresholdUsdRaw <= 0) {
      return NextResponse.json({ error: "thresholdUsd must be > 0" }, { status: 400 });
    }

    const unlockPercent = Math.floor(unlockPercentRaw);
    const thresholdUsd = Math.floor(thresholdUsdRaw);

    const signatureB58 = typeof body?.signature === "string" ? body.signature.trim() : "";
    if (!signatureB58) {
      const message = milestoneAddMarketCapMessage({ commitmentId: id, requestId, title, unlockPercent, thresholdUsd });
      return NextResponse.json(
        {
          error: "signature required",
          message,
          creatorPubkey: record.creatorPubkey,
        },
        { status: 400 }
      );
    }

    const expectedMessage = milestoneAddMarketCapMessage({ commitmentId: id, requestId, title, unlockPercent, thresholdUsd });
    const providedMessage = typeof body?.message === "string" ? body.message : expectedMessage;
    if (providedMessage !== expectedMessage) {
      return NextResponse.json({ error: "Invalid message" }, { status: 400 });
    }

    const signature = bs58.decode(signatureB58);
    const creatorPk = new PublicKey(record.creatorPubkey);
    const ok = nacl.sign.detached.verify(new TextEncoder().encode(expectedMessage), signature, creatorPk.toBytes());
    if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    // A market-cap goal has to be a real goal: reject thresholds the token has already reached.
    // (Best effort - if the price feed is unreachable we don't block the creator.)
    try {
      const { pairs } = await fetchDexScreenerPairsByTokenMint({ tokenMint: record.tokenMint, timeoutMs: 4000 });
      const best = pickBestDexScreenerPair({ pairs, chainId: "solana", minLiquidityUsd: 1000 });
      const currentMarketCap = Number(best?.marketCap ?? best?.fdv ?? 0);
      if (Number.isFinite(currentMarketCap) && currentMarketCap > 0 && thresholdUsd <= currentMarketCap) {
        return NextResponse.json(
          {
            error: `Market cap goal must be above the current market cap (~$${Math.round(currentMarketCap).toLocaleString("en-US")})`,
            currentMarketCapUsd: Math.round(currentMarketCap),
          },
          { status: 400 }
        );
      }
    } catch {
      // price feed unavailable - allow
    }

    const milestones: RewardMilestone[] = Array.isArray(record.milestones) ? (record.milestones.slice() as RewardMilestone[]) : [];
    if (milestones.length >= 50) {
      return NextResponse.json({ error: "Maximum 50 milestones allowed" }, { status: 400 });
    }

    const milestoneId = milestoneIdFromRequest({ commitmentId: id, requestId });
    const existingIdx = milestones.findIndex((m) => m.id === milestoneId);
    if (existingIdx >= 0) {
      return NextResponse.json({ ok: true, duplicate: true, commitment: publicView(record) });
    }

    const nextMilestone: RewardMilestone = {
      id: milestoneId,
      title,
      unlockLamports: 0,
      unlockPercent,
      status: "locked",
      autoKind: "market_cap",
      marketCapThresholdUsd: thresholdUsd,
      marketCapChainId: "solana",
      requireNoMintAuthority: true,
      autoTrackingStartedAtUnix: Math.floor(Date.now() / 1000),
    };

    const nextMilestones = milestones.concat([nextMilestone]);

    const totalUnlockPercent = sumUnlockPercents(nextMilestones);
    if (totalUnlockPercent > 100) {
      return NextResponse.json({ error: `Total allocation cannot exceed 100% (currently ${totalUnlockPercent}%)` }, { status: 400 });
    }

    const updated = await updateRewardTotalsAndMilestones({
      id,
      milestones: nextMilestones,
      status: record.status === "completed" ? "active" : record.status,
    });

    return NextResponse.json({ ok: true, milestoneId, commitment: publicView(updated) });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
