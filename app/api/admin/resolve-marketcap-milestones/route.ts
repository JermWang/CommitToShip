import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { auditLog } from "../../../lib/auditLog";
import { isAdminRequestAsync } from "../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { checkRateLimit } from "../../../lib/rateLimit";
import {
  RewardMilestone,
  listCommitments,
  publicView,
  sumReleasedLamports,
  updateRewardTotalsAndMilestones,
} from "../../../lib/escrowStore";
import { fetchDexScreenerPairsByTokenMint, pickBestDexScreenerPair } from "../../../lib/dexScreener";
import { findFirstTokenMarketSnapshotAbovePrice, getCanonicalPair, insertTokenMarketSnapshot, upsertCanonicalPair } from "../../../lib/tokenMarketStore";
import {
  getBalanceLamports,
  getChainUnixTime,
  getConnection,
  getMintAuthorityBase58,
  verifyTokenExistsOnChain,
} from "../../../lib/solana";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { tryAcquireMarketCapMilestoneConfirmation } from "../../../lib/marketCapMilestonesStore";

export const runtime = "nodejs";

function isCronAuthorized(req: Request): boolean {
  const secret = String(process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = String(req.headers.get("x-cron-secret") ?? "").trim();
  if (!header) return false;
  return header === secret;
}

function computeUnlockedLamports(milestones: RewardMilestone[]): number {
  return milestones.reduce((acc, m) => {
    if (m.status === "claimable" || m.status === "released") return acc + Number(m.unlockLamports || 0);
    return acc;
  }, 0);
}

function isMarketCapMilestonesEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_MARKETCAP_MILESTONES ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function getClaimDelaySeconds(): number {
  const rawStr = process.env.REWARD_CLAIM_DELAY_SECONDS;
  if (rawStr == null || String(rawStr).trim() === "") return 48 * 60 * 60;
  const raw = Number(rawStr);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 48 * 60 * 60;
}

function getMinLiquidityUsd(): number {
  const raw = Number(process.env.CTS_MC_MIN_LIQUIDITY_USD ?? "");
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 50_000;
}

function getMinVolumeH1Usd(): number {
  const rawStr = process.env.CTS_MC_MIN_VOLUME_H1_USD;
  if (rawStr == null || String(rawStr).trim() === "") return 0;
  const raw = Number(rawStr);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 0;
}

function getMinMinutesAbove(): number {
  const raw = Number(process.env.CTS_MC_MIN_MINUTES_ABOVE ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 15;
}

function getMinSamples(): number {
  const raw = Number(process.env.CTS_MC_MIN_SAMPLES ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 10;
}

function getMaxGapSeconds(): number {
  const raw = Number(process.env.CTS_MC_MAX_GAP_SECONDS ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 120;
}

function getLookbackSeconds(): number {
  const rawStr = process.env.CTS_MC_LOOKBACK_SECONDS;
  if (rawStr != null && String(rawStr).trim() !== "") {
    const raw = Number(rawStr);
    if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  }
  return 365 * 24 * 60 * 60;
}

function computeUnlockLamports(input: { milestone: RewardMilestone; totalFundedLamports: number }): number {
  const currentUnlockLamports = Number(input.milestone.unlockLamports ?? 0);
  const currentUnlockPercent = Number((input.milestone as any).unlockPercent ?? 0);
  if (Number.isFinite(currentUnlockLamports) && currentUnlockLamports > 0) return Math.floor(currentUnlockLamports);
  if (Number.isFinite(currentUnlockPercent) && currentUnlockPercent > 0) {
    return Math.floor((input.totalFundedLamports * currentUnlockPercent) / 100);
  }
  return 0;
}

function supplyUiAmount(input: { supplyRaw: bigint; decimals: number }): number {
  const d = BigInt(Math.max(0, Math.min(18, Math.floor(input.decimals))));
  const div = 10n ** d;
  const whole = input.supplyRaw / div;
  const frac = input.supplyRaw % div;
  const fracStr = frac.toString().padStart(Number(d), "0").slice(0, 9);
  const wholeNum = Number(whole);
  const fracNum = fracStr.length ? Number(`0.${fracStr}`) : 0;
  return (Number.isFinite(wholeNum) ? wholeNum : 0) + (Number.isFinite(fracNum) ? fracNum : 0);
}

async function ingestLatestSnapshot(input: { tokenMint: string; chainId: string; minLiquidityUsd: number; nowUnix: number }) {
  const tokenMint = String(input.tokenMint ?? "").trim();
  const chainId = String(input.chainId ?? "").trim().toLowerCase();

  const existingCanonical = await getCanonicalPair({ tokenMint, chainId });

  const { pairs } = await fetchDexScreenerPairsByTokenMint({ tokenMint });

  const canonicalPairAddress = String(existingCanonical?.pairAddress ?? "").trim();
  const canonicalFromFeed = canonicalPairAddress.length
    ? pairs.find((p) => String(p?.pairAddress ?? "").trim() === canonicalPairAddress) ?? null
    : null;

  const best = canonicalFromFeed ?? pickBestDexScreenerPair({ pairs, chainId, minLiquidityUsd: input.minLiquidityUsd });
  if (!best) {
    return { ok: false as const, tokenMint, error: "No suitable pair" };
  }

  const pairAddress = String(best.pairAddress ?? "").trim();
  const dexId = String(best.dexId ?? "").trim();
  const priceUsd = Number(best.priceUsd ?? 0);
  const liquidityUsd = Number(best.liquidity?.usd ?? 0);
  const volumeH1Usd = Number(best.volume?.h1 ?? 0);
  const volumeH24Usd = Number(best.volume?.h24 ?? 0);

  if (!pairAddress || !dexId) {
    return { ok: false as const, tokenMint, error: "Invalid pair" };
  }
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    return { ok: false as const, tokenMint, error: "Invalid price" };
  }

  // Freeze canonical pair once chosen; future upserts won't change pairAddress/dexId.
  await upsertCanonicalPair({ tokenMint, chainId, pairAddress, dexId, url: best.url ?? null });

  await insertTokenMarketSnapshot({
    tokenMint,
    chainId,
    pairAddress,
    dexId,
    fetchedAtUnix: input.nowUnix,
    priceUsd,
    liquidityUsd: Number.isFinite(liquidityUsd) ? liquidityUsd : 0,
    volumeH1Usd: Number.isFinite(volumeH1Usd) ? volumeH1Usd : 0,
    volumeH24Usd: Number.isFinite(volumeH24Usd) ? volumeH24Usd : 0,
    fdvUsd: best.fdv == null ? null : Number(best.fdv),
    marketCapUsd: best.marketCap == null ? null : Number(best.marketCap),
  });

  return { ok: true as const, tokenMint, pairAddress, dexId };
}

function isMarketCapMilestone(m: RewardMilestone): boolean {
  return String((m as any).autoKind ?? "") === "market_cap";
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "admin:resolve-marketcap", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    if (!isMarketCapMilestonesEnabled()) {
      return NextResponse.json(
        {
          error: "Market cap milestones are disabled",
          hint: "Set CTS_ENABLE_MARKETCAP_MILESTONES=1 (or true) to enable automated market cap milestones.",
        },
        { status: 503 }
      );
    }

    const cronOk = isCronAuthorized(req);
    if (!cronOk) {
      verifyAdminOrigin(req);
      if (!(await isAdminRequestAsync(req))) {
        await auditLog("admin_resolve_marketcap_denied", {});
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const body = (await req.json().catch(() => null)) as any;
    const commitmentIdFilter = typeof body?.commitmentId === "string" ? body.commitmentId.trim() : "";
    const limit = body?.limit != null ? Number(body.limit) : undefined;

    const chainId = "solana";
    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);

    const minLiquidityUsd = getMinLiquidityUsd();
    const minVolumeH1Usd = getMinVolumeH1Usd();
    void getMinMinutesAbove;
    void getMinSamples;
    void getMaxGapSeconds;
    const claimDelaySeconds = getClaimDelaySeconds();
    const lookbackSeconds = getLookbackSeconds();

    const all = await listCommitments();
    const targets = all.filter((c) => {
      if (c.kind !== "creator_reward") return false;
      if (!c.tokenMint) return false;
      if (commitmentIdFilter && c.id !== commitmentIdFilter) return false;
      const milestones = Array.isArray(c.milestones) ? c.milestones : [];
      return milestones.some((m) => isMarketCapMilestone(m) && m.status === "locked" && m.completedAtUnix == null);
    });

    const capped = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? targets.slice(0, Math.min(200, Math.floor(limit))) : targets;

    const results: any[] = [];
    let confirmedCount = 0;

    for (const c of capped) {
      const tokenMint = String(c.tokenMint ?? "").trim();
      if (!tokenMint) continue;

      const ingest = await ingestLatestSnapshot({ tokenMint, chainId, minLiquidityUsd, nowUnix });
      if (!ingest.ok) {
        results.push({ id: c.id, ok: false, step: "ingest", error: ingest.error });
        continue;
      }

      const canonical = await getCanonicalPair({ tokenMint, chainId });
      if (!canonical) {
        results.push({ id: c.id, ok: false, step: "canonical", error: "Canonical pair missing" });
        continue;
      }

      const mintInfo = await verifyTokenExistsOnChain({ connection, mint: new PublicKey(tokenMint) });
      if (!mintInfo.exists || !mintInfo.isMintAccount || !mintInfo.supply || mintInfo.decimals == null) {
        results.push({ id: c.id, ok: false, step: "mint", error: "Mint not found" });
        continue;
      }

      const mintAuthority = await getMintAuthorityBase58({ connection, mint: new PublicKey(tokenMint) });

      let supplyRaw = 0n;
      try {
        supplyRaw = BigInt(mintInfo.supply);
      } catch {
        supplyRaw = 0n;
      }

      const supplyUi = supplyUiAmount({ supplyRaw, decimals: Number(mintInfo.decimals) });

      const sinceUnix = Math.max(1, nowUnix - lookbackSeconds);

      const milestones: RewardMilestone[] = Array.isArray(c.milestones) ? (c.milestones.slice() as RewardMilestone[]) : [];

      let anyChanged = false;

      for (let i = 0; i < milestones.length; i++) {
        const m = milestones[i];
        if (!isMarketCapMilestone(m)) continue;
        if (m.status !== "locked") continue;
        if (m.completedAtUnix != null) continue;

        const thresholdUsd = Number((m as any).marketCapThresholdUsd ?? 0);
        if (!Number.isFinite(thresholdUsd) || thresholdUsd <= 0) continue;

        const requireNoMintAuthority = String((m as any).requireNoMintAuthority ?? "true").toLowerCase() !== "false";
        if (requireNoMintAuthority && mintAuthority) {
          results.push({ id: c.id, milestoneId: m.id, ok: true, step: "evaluate", confirmed: false, reason: "mint_authority_present" });
          continue;
        }

        if (!Number.isFinite(supplyUi) || supplyUi <= 0) {
          results.push({ id: c.id, milestoneId: m.id, ok: false, step: "evaluate", error: "Invalid token supply" });
          continue;
        }

        const minPriceUsd = thresholdUsd / supplyUi;
        const hit = await findFirstTokenMarketSnapshotAbovePrice({
          tokenMint,
          chainId,
          pairAddress: canonical.pairAddress,
          sinceUnix,
          minPriceUsd,
          minLiquidityUsd,
          minVolumeH1Usd,
        });

        if (!hit) {
          results.push({ id: c.id, milestoneId: m.id, ok: true, step: "evaluate", confirmed: false, reason: "threshold_not_hit", sinceUnix });
          continue;
        }

        const escrowPk = new PublicKey(c.escrowPubkey);
        const balanceLamports = await getBalanceLamports(connection, escrowPk);
        const releasedLamports = sumReleasedLamports(milestones);
        const totalFundedLamports = Math.max(0, Number(balanceLamports) + releasedLamports);

        const unlockLamports = computeUnlockLamports({ milestone: m, totalFundedLamports });
        if (!Number.isFinite(unlockLamports) || unlockLamports <= 0) {
          results.push({ id: c.id, milestoneId: m.id, ok: false, step: "unlock", error: "Invalid unlock amount" });
          continue;
        }

        const hitAtUnix = Number(hit.fetchedAtUnix);
        const hitMarketCapUsd = Number(hit.priceUsd) * supplyUi;
        const completedAtUnix = Number.isFinite(hitAtUnix) && hitAtUnix > 0 ? Math.min(nowUnix, Math.floor(hitAtUnix)) : nowUnix;
        const desiredClaimableAtUnix = completedAtUnix + claimDelaySeconds;
        const nextStatus = nowUnix >= desiredClaimableAtUnix ? ("claimable" as const) : ("approved" as const);

        const evidence = {
          tokenMint,
          chainId,
          thresholdUsd,
          confirmedAtUnix: nowUnix,
          hitAtUnix: completedAtUnix,
          hit: {
            fetchedAtUnix: hit.fetchedAtUnix,
            priceUsd: hit.priceUsd,
            liquidityUsd: hit.liquidityUsd,
            volumeH1Usd: hit.volumeH1Usd,
            volumeH24Usd: hit.volumeH24Usd,
            marketCapUsd: hitMarketCapUsd,
          },
          canonicalPair: {
            pairAddress: canonical.pairAddress,
            dexId: canonical.dexId,
            url: canonical.url ?? null,
          },
          supply: {
            supplyRaw: mintInfo.supply,
            decimals: mintInfo.decimals,
            supplyUi,
            mintAuthority: mintAuthority ?? null,
          },
          floors: {
            minLiquidityUsd,
            minVolumeH1Usd,
            lookbackSeconds,
          },
          observed: {
            sinceUnix,
            minPriceUsd,
          },
        };

        const confirmation = {
          commitmentId: c.id,
          milestoneId: m.id,
          tokenMint,
          confirmedAtUnix: nowUnix,
          totalFundedLamports,
          unlockLamports,
          thresholdUsd,
          chainId,
          pairAddress: canonical.pairAddress,
          dexId: canonical.dexId,
          evidenceJson: JSON.stringify(evidence),
        };

        const acquired = await tryAcquireMarketCapMilestoneConfirmation({ confirmation });
        if (!acquired.acquired) {
          const ex = acquired.existing;
          if (ex.tokenMint !== tokenMint || Number(ex.thresholdUsd) !== thresholdUsd) {
            results.push({ id: c.id, milestoneId: m.id, ok: false, step: "confirm", error: "Existing confirmation mismatch" });
            continue;
          }

          results.push({ id: c.id, milestoneId: m.id, ok: true, step: "confirm", confirmed: true, idempotent: true });
          continue;
        }

        milestones[i] = {
          ...m,
          unlockLamports,
          completedAtUnix,
          approvedAtUnix: completedAtUnix,
          claimableAtUnix: desiredClaimableAtUnix,
          becameClaimableAtUnix: nextStatus === "claimable" ? (m.becameClaimableAtUnix ?? nowUnix) : m.becameClaimableAtUnix,
          status: nextStatus,
          autoConfirmedAtUnix: nowUnix,
          autoEvidence: evidence,
        };

        anyChanged = true;
        confirmedCount++;

        await auditLog("marketcap_milestone_confirmed", {
          commitmentId: c.id,
          milestoneId: m.id,
          tokenMint,
          thresholdUsd,
          chainId,
          pairAddress: canonical.pairAddress,
          dexId: canonical.dexId,
          confirmedAtUnix: nowUnix,
          hitAtUnix: completedAtUnix,
          claimableAtUnix: desiredClaimableAtUnix,
          unlockLamports,
          hitPriceUsd: Number(hit.priceUsd),
          hitMarketCapUsd,
          hitLiquidityUsd: Number(hit.liquidityUsd),
          hitVolumeH1Usd: Number(hit.volumeH1Usd),
          mintAuthority: mintAuthority ?? null,
        });

        results.push({ id: c.id, milestoneId: m.id, ok: true, step: "confirm", confirmed: true, unlockLamports });
      }

      if (anyChanged) {
        const unlockedLamports = computeUnlockedLamports(milestones);
        const releasedLamports = sumReleasedLamports(milestones);
        const escrowPk = new PublicKey(c.escrowPubkey);
        const balanceLamportsAfter = await getBalanceLamports(connection, escrowPk);
        const totalFundedLamports = Math.max(0, Number(balanceLamportsAfter) + releasedLamports);

        const updated = await updateRewardTotalsAndMilestones({
          id: c.id,
          milestones,
          unlockedLamports,
          totalFundedLamports,
          status: c.status === "created" ? "active" : c.status,
        });
        anyChanged = false;
        void updated;
      }

      results.push({ id: c.id, ok: true, commitment: publicView(c) });
    }

    await auditLog("admin_resolve_marketcap_completed", {
      cron: cronOk,
      nowUnix,
      commitmentId: commitmentIdFilter || null,
      targetCount: capped.length,
      confirmedCount,
    });

    return NextResponse.json({ ok: true, nowUnix, targetCount: capped.length, confirmedCount, results });
  } catch (e) {
    await auditLog("admin_resolve_marketcap_error", { error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
