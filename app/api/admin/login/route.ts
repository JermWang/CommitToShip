import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import {
  buildAdminSessionCookie,
  consumeAdminNonce,
  createAdminSession,
  expectedAdminLoginMessage,
  getAllowedAdminWallets,
  verifyAdminOrigin,
} from "../../../lib/adminSession";
import { getSafeErrorMessage } from "../../../lib/safeError";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    verifyAdminOrigin(req);

    const body = (await req.json().catch(() => null)) as any;

    const walletPubkeyRaw = typeof body?.walletPubkey === "string" ? body.walletPubkey.trim() : "";
    const nonce = typeof body?.nonce === "string" ? body.nonce.trim() : "";
    const signatureB58 = typeof body?.signatureB58 === "string" ? body.signatureB58.trim() : "";

    if (!walletPubkeyRaw || !nonce || !signatureB58) {
      return NextResponse.json({ error: "walletPubkey, nonce, signatureB58 are required" }, { status: 400 });
    }

    const walletPubkey = new PublicKey(walletPubkeyRaw).toBase58();

    const allowed = getAllowedAdminWallets();
    if (allowed.size === 0) return NextResponse.json({ error: "Admin wallets not configured" }, { status: 500 });
    if (!allowed.has(walletPubkey)) return NextResponse.json({ error: "Not an allowed admin wallet" }, { status: 403 });

    const expectedMessage = expectedAdminLoginMessage({ walletPubkey, nonce });

    const signature = bs58.decode(signatureB58);
    const okSig = nacl.sign.detached.verify(new TextEncoder().encode(expectedMessage), signature, new PublicKey(walletPubkey).toBytes());
    if (!okSig) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    const consumed = await consumeAdminNonce({ walletPubkey, nonce, maxAgeSeconds: 10 * 60 });
    if (!consumed.ok) return NextResponse.json({ error: consumed.reason }, { status: 401 });

    const sessionTtlSeconds = 7 * 24 * 60 * 60;
    const sess = await createAdminSession({ walletPubkey, sessionTtlSeconds });

    const res = NextResponse.json({ ok: true, walletPubkey });
    res.headers.set("set-cookie", buildAdminSessionCookie({ sessionId: sess.sessionId, maxAgeSeconds: sessionTtlSeconds }));
    return res;
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
