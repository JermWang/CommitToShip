import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { checkRateLimit } from "../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { auditLog } from "../../../lib/auditLog";
import { hasDatabase, getPool } from "../../../lib/db";
import { getAllowedAdminWallets, getAdminSessionWallet, verifyAdminOrigin } from "../../../lib/adminSession";
import { privyRefundWalletToFeePayer } from "../../../lib/privy";

export const runtime = "nodejs";

const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // mainnet

function isCronAuthorized(req: Request): boolean {
  const secret = String(process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = String(req.headers.get("x-cron-secret") ?? "").trim();
  if (!header) return false;
  return header === secret;
}

async function isAdminAuthorized(req: Request): Promise<boolean> {
  try {
    verifyAdminOrigin(req);
  } catch {
    return false;
  }

  const allowed = getAllowedAdminWallets();
  const adminWallet = await getAdminSessionWallet(req);
  if (!adminWallet) return false;
  return allowed.has(adminWallet);
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "launch:sweep", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const cronOk = isCronAuthorized(req);
    const adminOk = cronOk ? true : await isAdminAuthorized(req);
    if (!adminOk) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as any;

    const keepLamports = body?.keepLamports != null ? Number(body.keepLamports) : 10_000;

    const walletId = typeof body?.walletId === "string" ? body.walletId.trim() : "";
    const creatorWallet = typeof body?.creatorWallet === "string" ? body.creatorWallet.trim() : "";

    if (walletId && creatorWallet) {
      const fromPubkey = new PublicKey(creatorWallet);
      const result = await privyRefundWalletToFeePayer({ walletId, fromPubkey, caip2: SOLANA_CAIP2, keepLamports });
      await auditLog("launch_sweep_one", { walletId, creatorWallet, ok: result.ok, error: result.ok ? undefined : result.error });
      return NextResponse.json({ ok: true, walletId, creatorWallet, result });
    }

    if (!hasDatabase()) {
      return NextResponse.json({ error: "DATABASE_URL is required for batch sweep" }, { status: 400 });
    }

    const sinceUnix = body?.sinceUnix != null ? Number(body.sinceUnix) : Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const limitRaw = body?.limit != null ? Number(body.limit) : 50;
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 50));

    const pool = getPool();

    const { rows } = await pool.query(
      `
      select
        f.fields->>'walletId' as wallet_id,
        f.fields->>'creatorWallet' as creator_wallet,
        max(f.ts_unix) as ts_unix
      from public.audit_logs f
      where f.event = 'launch_funding_success'
        and f.ts_unix >= $1
        and not exists (
          select 1 from public.audit_logs s
          where s.event in ('launch_onchain_success', 'launch_success')
            and s.fields->>'walletId' = f.fields->>'walletId'
        )
        and not exists (
          select 1 from public.audit_logs r
          where r.event = 'launch_refund_attempt'
            and r.fields->>'walletId' = f.fields->>'walletId'
            and r.fields->>'ok' = 'true'
        )
      group by f.fields->>'walletId', f.fields->>'creatorWallet'
      order by ts_unix desc
      limit $2
      `,
      [String(sinceUnix), String(limit)]
    );

    const results: any[] = [];
    for (const row of rows) {
      const wid = String(row.wallet_id ?? "").trim();
      const cwa = String(row.creator_wallet ?? "").trim();
      if (!wid || !cwa) continue;

      let ok = false;
      let error = "";
      let refundSignature = "";
      let refundedLamports = 0;

      try {
        const fromPubkey = new PublicKey(cwa);
        const r = await privyRefundWalletToFeePayer({ walletId: wid, fromPubkey, caip2: SOLANA_CAIP2, keepLamports });
        ok = r.ok;
        if (!r.ok) error = r.error;
        if (r.ok) {
          refundSignature = r.signature;
          refundedLamports = r.refundedLamports;
        }
      } catch (e) {
        ok = false;
        error = getSafeErrorMessage(e);
      }

      results.push({ walletId: wid, creatorWallet: cwa, ok, refundSignature, refundedLamports, error });
    }

    const swept = results.filter((r) => r.ok).length;
    await auditLog("launch_sweep", { cronOk, sinceUnix, limit, swept, total: results.length });

    return NextResponse.json({ ok: true, swept, total: results.length, results });
  } catch (e) {
    const msg = getSafeErrorMessage(e);
    await auditLog("launch_sweep_error", { error: msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
