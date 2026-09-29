import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { auditLog } from "../../../lib/auditLog";
import { checkRateLimit } from "../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { getConnection, getTokenBalanceForMint } from "../../../lib/solana";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "wallet:ship-balance", limit: 60, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const body = (await req.json().catch(() => null)) as any;
    const walletPubkey = typeof body?.walletPubkey === "string" ? body.walletPubkey.trim() : "";
    if (!walletPubkey) return NextResponse.json({ error: "walletPubkey required" }, { status: 400 });

    let owner: PublicKey;
    try {
      owner = new PublicKey(walletPubkey);
    } catch {
      return NextResponse.json({ error: "Invalid walletPubkey" }, { status: 400 });
    }

    const mintRaw = String(process.env.CTS_SHIP_TOKEN_MINT ?? "").trim();
    if (!mintRaw) {
      // No $SHIP mint configured yet: report a zero balance instead of failing the dashboard.
      return NextResponse.json({ ok: true, walletPubkey, uiAmount: 0, amountRaw: "0", configured: false });
    }

    const mint = new PublicKey(mintRaw);
    const connection = getConnection();
    const bal = await getTokenBalanceForMint({ connection, owner, mint });

    await auditLog("wallet_ship_balance_ok", { walletPubkey, amountRaw: bal.amountRaw.toString() });

    return NextResponse.json({
      ok: true,
      walletPubkey,
      mint: mint.toBase58(),
      amountRaw: bal.amountRaw.toString(),
      decimals: bal.decimals,
      uiAmount: bal.uiAmount,
    });
  } catch (e) {
    await auditLog("wallet_ship_balance_error", { error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
