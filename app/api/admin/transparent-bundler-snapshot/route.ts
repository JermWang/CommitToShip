import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { auditLog } from "../../../lib/auditLog";
import { isAdminRequestAsync } from "../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { checkRateLimit } from "../../../lib/rateLimit";
import { getConnection, getTokenBalanceForMint, getTokenSupplyForMint } from "../../../lib/solana";
import { getSafeErrorMessage } from "../../../lib/safeError";
import {
  computeSnapshotFromRaw,
  insertSupplySnapshot,
  insertWalletBalanceSnapshots,
  listActiveDeclaredWallets,
  listTokenMintsWithActiveDeclaredWallets,
} from "../../../lib/transparentBundlerStore";
import { isCronAuthorized } from "../../../lib/cronAuth";
import { apiError } from "../../../lib/apiError";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "admin:tb:snapshot", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const cronOk = isCronAuthorized(req);
    if (!cronOk) {
      verifyAdminOrigin(req);
      if (!(await isAdminRequestAsync(req))) {
        await auditLog("admin_tb_snapshot_denied", {});
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const body = (await req.json().catch(() => null)) as any;
    const tokenMintFilter = typeof body?.tokenMint === "string" ? body.tokenMint.trim() : "";
    const limitRaw = body?.limit != null ? Number(body.limit) : undefined;

    const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 200;

    const tokenMints = tokenMintFilter
      ? [new PublicKey(tokenMintFilter).toBase58()]
      : await listTokenMintsWithActiveDeclaredWallets({ limit });

    const connection = getConnection();
    const nowUnix = Math.floor(Date.now() / 1000);

    const results: any[] = [];

    for (const tokenMint of tokenMints) {
      try {
        const wallets = await listActiveDeclaredWallets({ tokenMint });
        if (!wallets.length) {
          results.push({ tokenMint, ok: true, skipped: true, reason: "no_active_wallets" });
          continue;
        }

        const supply = await getTokenSupplyForMint({ connection, mint: new PublicKey(tokenMint) });

        const balances: Array<{ walletPubkey: string; balanceRaw: bigint }> = [];
        for (const w of wallets) {
          const bal = await getTokenBalanceForMint({ connection, owner: new PublicKey(w.walletPubkey), mint: new PublicKey(tokenMint) });
          balances.push({ walletPubkey: w.walletPubkey, balanceRaw: bal.amountRaw });
        }

        const computed = await computeSnapshotFromRaw({
          tokenMint,
          snapshotAtUnix: nowUnix,
          decimals: supply.decimals,
          totalSupplyRaw: supply.amountRaw,
          balances,
          source: "scheduled_daily",
          balanceSource: "rpc",
        });

        await insertSupplySnapshot(computed.snapshot);
        await insertWalletBalanceSnapshots({ tokenMint, snapshotAtUnix: nowUnix, balances: computed.walletBalances });

        results.push({ tokenMint, ok: true, declaredControlPct: computed.snapshot.declaredControlPct });
      } catch (e) {
        results.push({ tokenMint, ok: false, error: getSafeErrorMessage(e) });
      }
    }

    await auditLog("admin_tb_snapshot_completed", { cron: cronOk, tokenMint: tokenMintFilter || null, count: tokenMints.length });

    return NextResponse.json({ ok: true, count: tokenMints.length, results });
  } catch (e) {
    await auditLog("admin_tb_snapshot_error", { error: e });
    return apiError(e, "admin/transparent-bundler-snapshot");
  }
}
