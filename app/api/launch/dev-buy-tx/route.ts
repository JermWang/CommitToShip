import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";

import { checkRateLimit } from "../../../lib/rateLimit";
import { auditLog } from "../../../lib/auditLog";
import { apiError } from "../../../lib/apiError";
import { getConnection } from "../../../lib/solana";
import { buildUnsignedPumpfunBuyTx } from "../../../lib/pumpfun";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { authorizeLaunchAccess } from "../../../lib/creatorAuth";

export const runtime = "nodejs";

export async function GET() {
  const res = NextResponse.json({ error: "Method Not Allowed. Use POST /api/launch/dev-buy-tx." }, { status: 405 });
  res.headers.set("allow", "POST, OPTIONS");
  return res;
}

export async function OPTIONS(req: Request) {
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
  res.headers.set("access-control-allow-origin", origin);
  res.headers.set("access-control-allow-methods", "POST, OPTIONS");
  res.headers.set("access-control-allow-headers", "content-type");
  res.headers.set("access-control-allow-credentials", "true");
  res.headers.set("vary", "origin");
  return res;
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "launch:devBuy", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    verifyAdminOrigin(req);

    const body = (await req.json().catch(() => ({}))) as any;

    const payerWallet = typeof body?.payerWallet === "string" ? body.payerWallet.trim() : "";
    const tokenMint = typeof body?.tokenMint === "string" ? body.tokenMint.trim() : "";
    const creatorWallet = typeof body?.creatorWallet === "string" ? body.creatorWallet.trim() : "";

    const devBuySolParsed = Number(body?.devBuySol ?? 0);
    const devBuySol = Number.isFinite(devBuySolParsed) && devBuySolParsed > 0 ? Math.min(devBuySolParsed, 100) : 0;

    if (!payerWallet) return NextResponse.json({ error: "payerWallet is required" }, { status: 400 });
    if (!tokenMint) return NextResponse.json({ error: "tokenMint is required" }, { status: 400 });

    try {
      new PublicKey(payerWallet);
    } catch {
      return NextResponse.json({ error: "Invalid payerWallet" }, { status: 400 });
    }

    const denied = await authorizeLaunchAccess(req, { body, payerWallet, auditEvent: "launch_devbuy_denied" });
    if (denied) return NextResponse.json({ error: denied.error, hint: denied.hint }, { status: denied.status });

    if (devBuySol <= 0) {
      return NextResponse.json({ ok: true, devBuySol: 0, txBase64: null, txFormat: null });
    }

    let payerPubkey: PublicKey;
    let mintPubkey: PublicKey;
    // creatorWallet is optional and only cross-checked: the creator (whose vault the buy pays) is read from the
    // token's bonding curve on-chain, never trusted from the request.
    let creatorCheck: PublicKey | undefined;
    try {
      payerPubkey = new PublicKey(payerWallet);
      mintPubkey = new PublicKey(tokenMint);
      creatorCheck = creatorWallet ? new PublicKey(creatorWallet) : undefined;
    } catch {
      return NextResponse.json({ error: "Invalid payerWallet/tokenMint/creatorWallet" }, { status: 400 });
    }

    const devBuyLamports = Math.floor(devBuySol * 1_000_000_000);
    if (!Number.isFinite(devBuyLamports) || devBuyLamports <= 0) {
      return NextResponse.json({ error: "devBuySol is invalid" }, { status: 400 });
    }

    const connection = getConnection();
    const { tx, creator } = await buildUnsignedPumpfunBuyTx({
      connection,
      user: payerPubkey,
      mint: mintPubkey,
      creator: creatorCheck,
      spendableSolInLamports: BigInt(devBuyLamports),
      minTokensOut: 0n,
      computeUnitLimit: 300_000,
      computeUnitPriceMicroLamports: 100_000,
    });

    const txBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const txBase64 = Buffer.from(Uint8Array.from(txBytes)).toString("base64");

    await auditLog("launch_devbuy_tx", {
      payerWallet,
      tokenMint,
      creatorWallet: creator.toBase58(),
      devBuySol,
      devBuyLamports,
    });

    return NextResponse.json({ ok: true, devBuySol, devBuyLamports, txBase64, txFormat: "base64" });
  } catch (e) {
    await auditLog("launch_devbuy_tx_error", { error: e instanceof Error ? e.message : String(e) });
    return apiError(e, "launch/dev-buy-tx");
  }
}
