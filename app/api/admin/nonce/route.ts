import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { createAdminNonce, expectedAdminLoginMessage, getAllowedAdminWallets, verifyAdminOrigin } from "../../../lib/adminSession";
import { getSafeErrorMessage } from "../../../lib/safeError";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
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
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
