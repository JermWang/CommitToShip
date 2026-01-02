import { NextResponse } from "next/server";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";

import { checkRateLimit } from "../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { getConnection } from "../../../lib/solana";
import { getOrCreateLaunchTreasuryWallet } from "../../../lib/launchTreasuryStore";
import { auditLog } from "../../../lib/auditLog";
import { getAdminCookieName, getAdminSessionWallet, getAllowedAdminWallets, verifyAdminOrigin } from "../../../lib/adminSession";

export const runtime = "nodejs";

function isPublicLaunchEnabled(): boolean {
  const raw = String(process.env.CTS_PUBLIC_LAUNCHES ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export async function GET() {
  const res = NextResponse.json({ error: "Method Not Allowed. Use POST /api/launch/prepare." }, { status: 405 });
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

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "launch:prepare", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    verifyAdminOrigin(req);

    if (!isPublicLaunchEnabled()) {
      const cookieHeader = String(req.headers.get("cookie") ?? "");
      const hasAdminCookie = cookieHeader.includes(`${getAdminCookieName()}=`);
      const allowed = getAllowedAdminWallets();
      const adminWallet = await getAdminSessionWallet(req);

      if (!adminWallet) {
        await auditLog("admin_launch_prepare_denied", { hasAdminCookie });
        return NextResponse.json(
          {
            error: hasAdminCookie
              ? "Admin session not found or expired. Try Admin Sign-In again."
              : "Admin Sign-In required",
          },
          { status: 401 }
        );
      }

      if (!allowed.has(adminWallet)) {
        await auditLog("admin_launch_prepare_denied", { adminWallet });
        return NextResponse.json({ error: "Not an allowed admin wallet" }, { status: 401 });
      }
    }

    const body = (await req.json().catch(() => null)) as any;

    const payerWallet = typeof body?.payerWallet === "string" ? body.payerWallet.trim() : "";
    const devBuySol = Number(body?.devBuySol ?? 0.01);

    if (!payerWallet) return NextResponse.json({ error: "payerWallet is required" }, { status: 400 });

    let payerPubkey: PublicKey;
    try {
      payerPubkey = new PublicKey(payerWallet);
    } catch {
      return NextResponse.json({ error: "Invalid payer wallet address" }, { status: 400 });
    }
    const { record: treasury, created } = await getOrCreateLaunchTreasuryWallet({ payerWallet: payerPubkey.toBase58() });
    const walletId = treasury.walletId;
    const treasuryWallet = treasury.treasuryWallet;
    const treasuryPubkey = new PublicKey(treasuryWallet);

    const devBuyLamports = Math.floor(devBuySol * 1_000_000_000);
    const requiredLamports = devBuyLamports + 10_000_000;
    const balanceBufferLamports = 50_000;

    const connection = getConnection();
    const rentExemptMinRaw = await connection.getMinimumBalanceForRentExemption(0);
    const rentExemptMin = Number.isFinite(rentExemptMinRaw) && rentExemptMinRaw > 0 ? rentExemptMinRaw : 890_880;
    const currentLamports = await connection.getBalance(treasuryPubkey, "confirmed");
    const missingLamports = Math.max(0, requiredLamports + balanceBufferLamports + rentExemptMin - currentLamports);
    const needsFunding = missingLamports > 0;

    let txBase64: string | null = null;
    let blockhash = "";
    let lastValidBlockHeight = 0;

    if (needsFunding) {
      const latest = await connection.getLatestBlockhash("confirmed");
      blockhash = latest.blockhash;
      lastValidBlockHeight = latest.lastValidBlockHeight;

      const tx = new Transaction();
      tx.feePayer = payerPubkey;
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.add(
        SystemProgram.transfer({
          fromPubkey: payerPubkey,
          toPubkey: treasuryPubkey,
          lamports: missingLamports,
        })
      );

      const txBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      txBase64 = Buffer.from(Uint8Array.from(txBytes)).toString("base64");
    }

    await auditLog("launch_prepare", {
      walletId,
      treasuryWallet,
      payerWallet: payerPubkey.toBase58(),
      requiredLamports,
      currentLamports,
      missingLamports,
      needsFunding,
      createdTreasury: created,
      devBuySol,
    });

    return NextResponse.json({
      ok: true,
      walletId,
      treasuryWallet,
      payerWallet: payerPubkey.toBase58(),
      requiredLamports,
      currentLamports,
      missingLamports,
      needsFunding,
      txBase64,
      txFormat: txBase64 ? "base64" : null,
      txType: txBase64 ? "fund_treasury_wallet" : null,
      blockhash: blockhash || null,
      lastValidBlockHeight: lastValidBlockHeight || null,
    });
  } catch (e) {
    await auditLog("launch_prepare_error", { error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
