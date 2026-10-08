import { NextResponse } from "next/server";
import crypto from "crypto";

import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { checkRateLimit } from "../../../../lib/rateLimit";
import { apiError } from "../../../../lib/apiError";
import { ASSET_MAX_BYTES, createUploadTicket, extFromContentType } from "../../../../lib/assetStorage";

export const runtime = "nodejs";

function expectedAvatarUploadMessage(input: { walletPubkey: string; timestampUnix: number; contentType: string }): string {
  return `Ship & Commit\nAvatar Upload\nWallet: ${input.walletPubkey}\nTimestamp: ${input.timestampUnix}\nContentType: ${input.contentType}`;
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "avatar:upload-url", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const body = (await req.json().catch(() => null)) as any;

    const walletPubkeyRaw = typeof body?.walletPubkey === "string" ? body.walletPubkey.trim() : "";
    const timestampUnix = Number(body?.timestampUnix);
    const signatureB58 = typeof body?.signatureB58 === "string" ? body.signatureB58.trim() : "";
    const contentType = typeof body?.contentType === "string" ? body.contentType.trim() : "image/png";

    if (!walletPubkeyRaw) return NextResponse.json({ error: "walletPubkey is required" }, { status: 400 });
    if (!Number.isFinite(timestampUnix) || timestampUnix <= 0) {
      return NextResponse.json({ error: "timestampUnix is required" }, { status: 400 });
    }
    if (!signatureB58) return NextResponse.json({ error: "signatureB58 is required" }, { status: 400 });
    if (!contentType.toLowerCase().startsWith("image/")) {
      return NextResponse.json({ error: "contentType must be an image" }, { status: 400 });
    }

    const nowUnix = Math.floor(Date.now() / 1000);
    if (Math.abs(nowUnix - Math.floor(timestampUnix)) > 5 * 60) {
      return NextResponse.json({ error: "Signature timestamp expired" }, { status: 400 });
    }

    const walletPubkey = new PublicKey(walletPubkeyRaw).toBase58();

    const msg = expectedAvatarUploadMessage({ walletPubkey, timestampUnix: Math.floor(timestampUnix), contentType });
    const signature = bs58.decode(signatureB58);
    const ok = nacl.sign.detached.verify(new TextEncoder().encode(msg), signature, new PublicKey(walletPubkey).toBytes());
    if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    const bucket = "avatars";
    const ext = extFromContentType(contentType);
    const id = crypto.randomBytes(12).toString("hex");
    const path = `${walletPubkey}/${id}.${ext}`;

    const ticket = await createUploadTicket(req, { bucket, path, contentType, maxBytes: ASSET_MAX_BYTES.avatar });

    return NextResponse.json(ticket);
  } catch (e) {
    return apiError(e, "avatar/upload-url");
  }
}
