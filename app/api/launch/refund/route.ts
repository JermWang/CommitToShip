import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { checkRateLimit } from "../../../lib/rateLimit";
import { auditLog } from "../../../lib/auditLog";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { getAdminCookieName, getAdminSessionWallet, getAllowedAdminWallets, verifyAdminOrigin } from "../../../lib/adminSession";
import { getConnection } from "../../../lib/solana";
import { getPool, hasDatabase } from "../../../lib/db";
import { privyRefundWalletToDestination } from "../../../lib/privy";

export const runtime = "nodejs";

const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // mainnet

export async function GET() {
  const res = NextResponse.json({ error: "Method Not Allowed. Use POST /api/launch/refund." }, { status: 405 });
  res.headers.set("allow", "POST, OPTIONS");
  return res;
}

export async function OPTIONS(req: Request) {
  const expected = String(process.env.APP_ORIGIN ?? "").trim();
  const origin = req.headers.get("origin") ?? "";

  try {
    verifyAdminOrigin(req);
  } catch {
    const res = new NextResponse(null, { status: 204 });
    res.headers.set("allow", "POST, OPTIONS");
    return res;
  }

  const res = new NextResponse(null, { status: 204 });
  res.headers.set("allow", "POST, OPTIONS");
  res.headers.set("access-control-allow-origin", origin || expected);
  res.headers.set("access-control-allow-methods", "POST, OPTIONS");
  res.headers.set("access-control-allow-headers", "content-type");
  res.headers.set("access-control-allow-credentials", "true");
  res.headers.set("vary", "origin");
  return res;
}

async function requireAdmin(req: Request): Promise<{ ok: true; adminWallet: string } | { ok: false; res: NextResponse }> {
  verifyAdminOrigin(req);

  const cookieHeader = String(req.headers.get("cookie") ?? "");
  const hasAdminCookie = cookieHeader.includes(`${getAdminCookieName()}=`);
  const allowed = getAllowedAdminWallets();
  const adminWallet = await getAdminSessionWallet(req);

  if (!adminWallet) {
    await auditLog("admin_launch_refund_denied", { hasAdminCookie });
    return {
      ok: false,
      res: NextResponse.json(
        {
          error: hasAdminCookie ? "Admin session not found or expired. Try Admin Sign-In again." : "Admin Sign-In required",
        },
        { status: 401 }
      ),
    };
  }

  if (!allowed.has(adminWallet)) {
    await auditLog("admin_launch_refund_denied", { adminWallet });
    return { ok: false, res: NextResponse.json({ error: "Not an allowed admin wallet" }, { status: 401 }) };
  }

  return { ok: true, adminWallet };
}

function extractSystemTransferParties(parsedTx: any): { source: string; destination: string; lamports: number } | null {
  const ixs = (parsedTx?.transaction?.message?.instructions ?? []) as any[];
  const transfer = ixs.find((ix) => ix?.program === "system" && ix?.parsed?.type === "transfer");
  const info = transfer?.parsed?.info;
  const source = typeof info?.source === "string" ? info.source : "";
  const destination = typeof info?.destination === "string" ? info.destination : "";
  const lamports = Number(info?.lamports ?? 0);
  if (!source || !destination || !Number.isFinite(lamports) || lamports <= 0) return null;
  return { source, destination, lamports };
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "launch:refund", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const admin = await requireAdmin(req);
    if (!admin.ok) return admin.res;

    const body = (await req.json().catch(() => ({}))) as any;

    const keepLamportsRaw = body?.keepLamports != null ? Number(body.keepLamports) : 10_000;
    const keepLamports = Math.max(5_000, Math.floor(Number.isFinite(keepLamportsRaw) ? keepLamportsRaw : 10_000));

    let walletId = typeof body?.walletId === "string" ? body.walletId.trim() : "";
    let creatorWallet = typeof body?.creatorWallet === "string" ? body.creatorWallet.trim() : "";
    let payerWallet = typeof body?.payerWallet === "string" ? body.payerWallet.trim() : "";

    const fundingSig = typeof body?.fundingSig === "string" ? body.fundingSig.trim() : "";

    if (!walletId || !creatorWallet || !payerWallet) {
      if (!fundingSig) {
        return NextResponse.json({ error: "Provide either (walletId, creatorWallet, payerWallet) or fundingSig" }, { status: 400 });
      }

      const connection = getConnection();
      const parsed = await connection.getParsedTransaction(fundingSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      } as any);

      if (!parsed) {
        return NextResponse.json({ error: "Funding transaction not found/confirmed" }, { status: 400 });
      }

      const parties = extractSystemTransferParties(parsed);
      if (!parties) {
        return NextResponse.json({ error: "Funding transaction is not a simple SystemProgram transfer" }, { status: 400 });
      }

      payerWallet = parties.source;
      creatorWallet = parties.destination;

      if (!hasDatabase()) {
        return NextResponse.json({ error: "DATABASE_URL is required to resolve walletId from fundingSig" }, { status: 400 });
      }

      const pool = getPool();
      const { rows } = await pool.query(
        `
        select
          fields->>'walletId' as wallet_id,
          fields->>'creatorWallet' as creator_wallet,
          fields->>'payerWallet' as payer_wallet,
          ts_unix
        from public.audit_logs
        where event = 'launch_prepare'
          and fields->>'creatorWallet' = $1
          and fields->>'payerWallet' = $2
        order by ts_unix desc
        limit 1
        `,
        [creatorWallet, payerWallet]
      );

      const row = rows?.[0];
      walletId = String(row?.wallet_id ?? "").trim();

      if (!walletId) {
        return NextResponse.json(
          {
            error: "Could not resolve walletId for this funding transaction. It may predate the new flow or logs are missing.",
            creatorWallet,
            payerWallet,
          },
          { status: 404 }
        );
      }
    }

    const fromPubkey = new PublicKey(creatorWallet);
    const toPubkey = new PublicKey(payerWallet);

    const refund = await privyRefundWalletToDestination({
      walletId,
      fromPubkey,
      toPubkey,
      caip2: SOLANA_CAIP2,
      keepLamports,
    });

    await auditLog("launch_refund_manual", {
      walletId,
      creatorWallet,
      payerWallet,
      keepLamports,
      ok: refund.ok,
      refundSignature: refund.ok ? refund.signature : undefined,
      refundedLamports: refund.ok ? refund.refundedLamports : undefined,
      refundError: refund.ok ? undefined : refund.error,
      fundingSig: fundingSig || undefined,
    });

    return NextResponse.json({ ok: true, walletId, creatorWallet, payerWallet, refund });
  } catch (e) {
    const msg = getSafeErrorMessage(e);
    await auditLog("launch_refund_error", { error: msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
