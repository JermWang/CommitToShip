import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { checkRateLimit } from "../../../lib/rateLimit";
import { auditLog } from "../../../lib/auditLog";
import { apiError } from "../../../lib/apiError";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { getAdminCookieName, getAdminSessionWallet, getAllowedAdminWallets, verifyAdminOrigin } from "../../../lib/adminSession";
import { getConnection } from "../../../lib/solana";
import {
  getLaunchTreasuryWallet,
  getLaunchTreasuryWalletByAddress,
  refundLaunchWalletToPayer,
  type LaunchTreasuryWalletRecord,
} from "../../../lib/launchTreasuryStore";

export const runtime = "nodejs";

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
/**
 * POST /api/launch/refund (admin)
 *
 * Returns the SOL in a payer's launch wallet to that payer. Identify the launch wallet by `payerWallet`, by its
 * address (`creatorWallet`) or by the payer's top-up transaction (`fundingSig`). The Privy wallet id, the source and
 * the destination are ALWAYS resolved from launch_treasury_wallets - never taken from the request - and a launch
 * wallet that is a commitment escrow (it launched a token) or has a launch running/pending is refused.
 */
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

    if (typeof body?.walletId === "string" && body.walletId.trim()) {
      return NextResponse.json({ error: "walletId is not accepted: the launch wallet is resolved from our records" }, { status: 400 });
    }

    let payerWallet = typeof body?.payerWallet === "string" ? body.payerWallet.trim() : "";
    const creatorWallet = typeof body?.creatorWallet === "string" ? body.creatorWallet.trim() : "";
    const fundingSig = typeof body?.fundingSig === "string" ? body.fundingSig.trim() : "";

    if (!payerWallet && !creatorWallet && !fundingSig) {
      return NextResponse.json({ error: "Provide payerWallet, creatorWallet (launch wallet address) or fundingSig" }, { status: 400 });
    }

    let record: LaunchTreasuryWalletRecord | null = null;

    if (payerWallet) {
      record = await getLaunchTreasuryWallet(new PublicKey(payerWallet).toBase58());
    } else if (creatorWallet) {
      record = await getLaunchTreasuryWalletByAddress(new PublicKey(creatorWallet).toBase58());
    } else {
      const connection = getConnection();
      const parsed = await connection.getParsedTransaction(fundingSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!parsed) return NextResponse.json({ error: "Funding transaction not found/confirmed" }, { status: 400 });
      const parties = extractSystemTransferParties(parsed);
      if (!parties) return NextResponse.json({ error: "Funding transaction is not a simple SystemProgram transfer" }, { status: 400 });
      // A payer -> launch wallet top-up: the destination must be a launch wallet we created FOR that source.
      record = await getLaunchTreasuryWalletByAddress(parties.destination);
      if (record && record.payerWallet !== parties.source) {
        return NextResponse.json({ error: "Funding transaction was not sent by this launch wallet's payer" }, { status: 400 });
      }
    }

    if (!record) return NextResponse.json({ error: "No launch wallet found for that payer/address" }, { status: 404 });
    if (creatorWallet && new PublicKey(creatorWallet).toBase58() !== record.treasuryWallet) {
      return NextResponse.json({ error: "creatorWallet is not this payer's launch wallet" }, { status: 400 });
    }
    payerWallet = record.payerWallet;

    const refund = await refundLaunchWalletToPayer({ record, keepLamports });

    await auditLog("launch_refund_manual", {
      adminWallet: admin.adminWallet,
      walletId: record.walletId,
      creatorWallet: record.treasuryWallet,
      payerWallet,
      keepLamports,
      ok: refund.ok,
      refundSignature: refund.ok ? refund.signature : undefined,
      refundedLamports: refund.ok ? refund.refundedLamports : undefined,
      refundError: refund.ok ? undefined : refund.error,
      refusedCode: refund.ok ? undefined : refund.code,
      fundingSig: fundingSig || undefined,
    });

    if (!refund.ok && refund.status === 409) {
      return NextResponse.json({ error: refund.error, code: refund.code, commitmentId: refund.commitmentId ?? null }, { status: 409 });
    }

    return NextResponse.json({ ok: true, creatorWallet: record.treasuryWallet, payerWallet, refund });
  } catch (e) {
    await auditLog("launch_refund_error", { error: getSafeErrorMessage(e) });
    return apiError(e, "launch/refund");
  }
}
