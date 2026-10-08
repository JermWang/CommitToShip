import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { checkRateLimit } from "../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { apiError } from "../../../lib/apiError";
import { auditLog } from "../../../lib/auditLog";
import { getAllowedAdminWallets, getAdminSessionWallet, verifyAdminOrigin } from "../../../lib/adminSession";
import {
  getLaunchTreasuryWallet,
  getLaunchTreasuryWalletByAddress,
  listLaunchTreasuryWallets,
  refundLaunchWalletToPayer,
  type LaunchTreasuryWalletRecord,
} from "../../../lib/launchTreasuryStore";

export const runtime = "nodejs";

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

/**
 * POST /api/launch/sweep (admin)
 *
 * Returns abandoned launch-wallet top-ups to the payers that sent them. Only wallets recorded in
 * launch_treasury_wallets can be touched (wallet id, source and destination come from that table, never from the
 * request); a wallet that is a commitment escrow/authority (it launched a token) or whose payer has a launch running,
 * pending or landed is skipped. Single: { payerWallet } or { creatorWallet }. Batch: { sinceUnix?, limit? }.
 */
export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "launch:sweep", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    if (!(await isAdminAuthorized(req))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as any;

    const keepLamportsRaw = body?.keepLamports != null ? Number(body.keepLamports) : 10_000;
    const keepLamports = Math.max(5_000, Math.floor(Number.isFinite(keepLamportsRaw) ? keepLamportsRaw : 10_000));

    if (typeof body?.walletId === "string" && body.walletId.trim()) {
      return NextResponse.json({ error: "walletId is not accepted: launch wallets are resolved from our records" }, { status: 400 });
    }

    const payerWallet = typeof body?.payerWallet === "string" ? body.payerWallet.trim() : "";
    const creatorWallet = typeof body?.creatorWallet === "string" ? body.creatorWallet.trim() : "";

    if (payerWallet || creatorWallet) {
      const record: LaunchTreasuryWalletRecord | null = payerWallet
        ? await getLaunchTreasuryWallet(new PublicKey(payerWallet).toBase58())
        : await getLaunchTreasuryWalletByAddress(new PublicKey(creatorWallet).toBase58());
      if (!record) return NextResponse.json({ error: "Not a launch wallet we created" }, { status: 404 });

      const result = await refundLaunchWalletToPayer({ record, keepLamports });
      await auditLog("launch_sweep_one", {
        walletId: record.walletId,
        creatorWallet: record.treasuryWallet,
        payerWallet: record.payerWallet,
        ok: result.ok,
        signature: result.ok ? result.signature : undefined,
        error: result.ok ? undefined : result.error,
      });
      if (!result.ok && result.status === 409) {
        return NextResponse.json({ error: result.error, code: result.code, commitmentId: result.commitmentId ?? null }, { status: 409 });
      }
      return NextResponse.json({ ok: true, creatorWallet: record.treasuryWallet, payerWallet: record.payerWallet, result });
    }

    const sinceRaw = body?.sinceUnix != null ? Number(body.sinceUnix) : NaN;
    const sinceUnix = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? Math.floor(sinceRaw) : Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const limitRaw = body?.limit != null ? Number(body.limit) : 50;
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 50));

    // Leave recently prepared wallets alone: their payer may be about to launch with that top-up.
    const minAgeRaw = body?.minAgeSeconds != null ? Number(body.minAgeSeconds) : 3600;
    const minAgeSeconds = Math.max(600, Number.isFinite(minAgeRaw) ? Math.floor(minAgeRaw) : 3600);
    const cutoff = Math.floor(Date.now() / 1000) - minAgeSeconds;
    const records = (await listLaunchTreasuryWallets({ sinceUnix, limit })).filter((r) => r.createdAtUnix <= cutoff);

    const results: any[] = [];
    for (const record of records) {
      let ok = false;
      let skipped = "";
      let error = "";
      let refundSignature = "";
      let refundedLamports = 0;
      try {
        const r = await refundLaunchWalletToPayer({ record, keepLamports });
        if (r.ok) {
          ok = true;
          refundSignature = r.signature;
          refundedLamports = r.refundedLamports;
        } else if (r.status === 409) {
          skipped = r.code;
        } else {
          error = r.error;
        }
      } catch (e) {
        error = getSafeErrorMessage(e);
      }
      results.push({ creatorWallet: record.treasuryWallet, payerWallet: record.payerWallet, ok, skipped: skipped || undefined, refundSignature, refundedLamports, error });
    }

    const swept = results.filter((r) => r.ok).length;
    await auditLog("launch_sweep", { sinceUnix, limit, swept, total: results.length });

    return NextResponse.json({ ok: true, swept, total: results.length, results });
  } catch (e) {
    await auditLog("launch_sweep_error", { error: getSafeErrorMessage(e) });
    return apiError(e, "launch/sweep");
  }
}
