import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { createAdminNonce, expectedAdminLoginMessage, getAllowedAdminWallets, verifyAdminOrigin } from "../../../lib/adminSession";
import { checkRateLimit } from "../../../lib/rateLimit";
import { apiError } from "../../../lib/apiError";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "admin:nonce", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    verifyAdminOrigin(req);

    const body = (await req.json().catch(() => null)) as any;
    const walletPubkeyRaw = typeof body?.walletPubkey === "string" ? body.walletPubkey.trim() : "";
    if (!walletPubkeyRaw) return NextResponse.json({ error: "walletPubkey required" }, { status: 400 });

    const walletPubkey = new PublicKey(walletPubkeyRaw).toBase58();

    const allowed = getAllowedAdminWallets();
    if (allowed.size === 0) return NextResponse.json({ error: "Admin wallets not configured" }, { status: 500 });
    if (!allowed.has(walletPubkey)) return NextResponse.json({ error: "Not an allowed admin wallet" }, { status: 403 });

    const { nonce } = await createAdminNonce({ walletPubkey });
    const message = expectedAdminLoginMessage({ walletPubkey, nonce });

    return NextResponse.json({ walletPubkey, nonce, message });
  } catch (e) {
    return apiError(e, "admin/nonce");
  }
}
