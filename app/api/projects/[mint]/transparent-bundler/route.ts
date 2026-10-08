import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { checkRateLimit } from "../../../../lib/rateLimit";
import { apiError } from "../../../../lib/apiError";
import { getConnection, getTokenBalanceForMint, getTokenSupplyForMint } from "../../../../lib/solana";
import {
  computeSnapshotFromRaw,
  getLatestSupplySnapshot,
  insertSupplySnapshot,
  insertWalletBalanceSnapshots,
  listActiveDeclaredWallets,
  listDeclaredWallets,
  listSupplySnapshots,
} from "../../../../lib/transparentBundlerStore";

export const runtime = "nodejs";

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function maxAgeSeconds(): number {
  const raw = Number(process.env.CTS_TB_ON_DEMAND_MAX_AGE_SECONDS ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 6 * 60 * 60;
}

function parseRangeDays(raw: string | null): number {
  const s = String(raw ?? "").trim().toLowerCase();
  const m = s.match(/^([0-9]{1,4})d$/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return Math.min(3650, Math.floor(n));
  }
  return 30;
}

function trendStats(series: Array<{ ts: number; pct: number }>) {
  const sorted = series.slice().sort((a, b) => a.ts - b.ts);
  const last = sorted[sorted.length - 1];
  if (!last) {
    return {
      delta7d: 0,
      slope30d: 0,
      perDay7dAvg: 0,
      perWeek4wAvg: 0,
    };
  }

  const tNow = last.ts;

  function pctAtOrBefore(t: number): number {
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].ts <= t) return sorted[i].pct;
    }
    return sorted[0]?.pct ?? last.pct;
  }

  const pctNow = last.pct;
  const pct7d = pctAtOrBefore(tNow - 7 * 24 * 60 * 60);
  const pct30d = pctAtOrBefore(tNow - 30 * 24 * 60 * 60);

  const delta7d = pctNow - pct7d;
  const slope30d = (pctNow - pct30d) / 30;

  const perDay7dAvg = delta7d / 7;
  const perWeek4wAvg = (pctNow - pctAtOrBefore(tNow - 28 * 24 * 60 * 60)) / 4;

  return { delta7d, slope30d, perDay7dAvg, perWeek4wAvg };
}

export async function GET(req: Request, ctx: { params: { mint: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "tb:get", limit: 60, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const mintRaw = String(ctx?.params?.mint ?? "").trim();
    if (!mintRaw) return NextResponse.json({ error: "mint is required" }, { status: 400 });
    const tokenMint = new PublicKey(mintRaw).toBase58();

    const u = new URL(req.url);
    const rangeDays = parseRangeDays(u.searchParams.get("range"));

    const latest = await getLatestSupplySnapshot(tokenMint);

    const t = nowUnix();
    const stale = !latest || t - latest.snapshotAtUnix > maxAgeSeconds();

    if (stale) {
      const refreshRl = await checkRateLimit(req, { keyPrefix: `tb:refresh:${tokenMint}`, limit: 5, windowSeconds: 60 });
      if (refreshRl.allowed) {
        const wallets = await listActiveDeclaredWallets({ tokenMint });
        if (wallets.length) {
          const connection = getConnection();
          const supply = await getTokenSupplyForMint({ connection, mint: new PublicKey(tokenMint) });

          const balances: Array<{ walletPubkey: string; balanceRaw: bigint }> = [];
          for (const w of wallets) {
            const bal = await getTokenBalanceForMint({ connection, owner: new PublicKey(w.walletPubkey), mint: new PublicKey(tokenMint) });
            balances.push({ walletPubkey: w.walletPubkey, balanceRaw: bal.amountRaw });
          }

          const computed = await computeSnapshotFromRaw({
            tokenMint,
            snapshotAtUnix: t,
            decimals: supply.decimals,
            totalSupplyRaw: supply.amountRaw,
            balances,
            source: "on_demand_cached",
            balanceSource: "rpc",
          });

          await insertSupplySnapshot(computed.snapshot);
          await insertWalletBalanceSnapshots({ tokenMint, snapshotAtUnix: t, balances: computed.walletBalances });
        }
      }
    }

    const sinceUnix = t - rangeDays * 24 * 60 * 60;
    const snapshots = await listSupplySnapshots({ tokenMint, sinceUnix, limit: Math.min(2000, rangeDays + 10) });

    const allWallets = await listDeclaredWallets({ tokenMint });

    const current = snapshots.length ? snapshots[snapshots.length - 1] : latest;

    const series = snapshots.map((s) => ({ ts: s.snapshotAtUnix, pct: s.declaredControlPct }));
    const stats = trendStats(series);

    const disclaimer = "This reflects wallets declared and verified by the team. It does not claim completeness.";

    return NextResponse.json({
      ok: true,
      tokenMint,
      current: current
        ? {
            snapshotAtUnix: current.snapshotAtUnix,
            totalSupplyRaw: current.totalSupplyRaw,
            totalSupplyUi: current.totalSupplyUi,
            declaredControlRaw: current.declaredControlRaw,
            declaredControlUi: current.declaredControlUi,
            declaredControlPct: current.declaredControlPct,
            decimals: current.decimals,
          }
        : null,
      timeseries: snapshots.map((s) => ({
        ts: s.snapshotAtUnix,
        totalSupplyUi: s.totalSupplyUi,
        declaredControlUi: s.declaredControlUi,
        pct: s.declaredControlPct,
        source: s.source,
      })),
      trend: { delta_7d: stats.delta7d, slope_30d: stats.slope30d },
      velocity: { per_day_7d_avg: stats.perDay7dAvg, per_week_4w_avg: stats.perWeek4wAvg },
      wallets: allWallets.map((w) => ({
        walletPubkey: w.walletPubkey,
        label: w.label ?? null,
        status: w.status,
        addedAtUnix: w.addedAtUnix,
        deprecatedAtUnix: w.deprecatedAtUnix ?? null,
        verifiedAtUnix: w.verifiedAtUnix,
      })),
      disclaimer,
    });
  } catch (e) {
    return apiError(e, "projects/[mint]/transparent-bundler");
  }
}
