import { NextResponse } from "next/server";

import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { getProfile, upsertProfile } from "../../../lib/profilesStore";
import { checkRateLimit } from "../../../lib/rateLimit";
import { apiError } from "../../../lib/apiError";

export const runtime = "nodejs";

function expectedProfileUpdateMessage(input: { walletPubkey: string; timestampUnix: number; payloadJson: string }): string {
  return `Ship & Commit\nProfile Update\nWallet: ${input.walletPubkey}\nTimestamp: ${input.timestampUnix}\nPayload: ${input.payloadJson}`;
}

export async function GET(_req: Request, ctx: { params: { wallet: string } }) {
  try {
    const wallet = String(ctx?.params?.wallet ?? "").trim();
    if (!wallet) return NextResponse.json({ error: "wallet is required" }, { status: 400 });

    const profile = await getProfile(wallet);
    return NextResponse.json({ profile });
  } catch (e) {
    return apiError(e, "profiles/[wallet]");
  }
}

export async function POST(req: Request, ctx: { params: { wallet: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "profiles:update", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const wallet = String(ctx?.params?.wallet ?? "").trim();
    if (!wallet) return NextResponse.json({ error: "wallet is required" }, { status: 400 });

    const body = (await req.json().catch(() => null)) as any;

    const timestampUnix = Number(body?.timestampUnix);
    const signatureB58 = typeof body?.signatureB58 === "string" ? body.signatureB58.trim() : "";

    const displayName = body?.displayName == null ? null : String(body.displayName);
    const bio = body?.bio == null ? null : String(body.bio);
    const avatarUrl = body?.avatarUrl == null ? null : String(body.avatarUrl);
    const avatarPath = body?.avatarPath == null ? null : String(body.avatarPath);

    if (!Number.isFinite(timestampUnix) || timestampUnix <= 0) {
      return NextResponse.json({ error: "timestampUnix is required" }, { status: 400 });
    }
    if (!signatureB58) return NextResponse.json({ error: "signatureB58 is required" }, { status: 400 });

    const nowUnix = Math.floor(Date.now() / 1000);
    if (Math.abs(nowUnix - Math.floor(timestampUnix)) > 5 * 60) {
      return NextResponse.json({ error: "Signature timestamp expired" }, { status: 400 });
    }

    const normalizedWallet = new PublicKey(wallet).toBase58();
    const bodyWallet = typeof body?.walletPubkey === "string" ? body.walletPubkey.trim() : "";
    if (bodyWallet && new PublicKey(bodyWallet).toBase58() !== normalizedWallet) {
      return NextResponse.json({ error: "walletPubkey mismatch" }, { status: 400 });
    }

    const payload = {
      displayName: displayName == null ? null : String(displayName).trim(),
      bio: bio == null ? null : String(bio),
      avatarUrl: avatarUrl == null ? null : String(avatarUrl).trim(),
      avatarPath: avatarPath == null ? null : String(avatarPath).trim(),
    };

    if (payload.displayName != null && payload.displayName.length > 32) {
      return NextResponse.json({ error: "displayName too long (max 32)" }, { status: 400 });
    }
    if (payload.bio != null && payload.bio.length > 280) {
      return NextResponse.json({ error: "bio too long (max 280)" }, { status: 400 });
    }
    if (payload.avatarUrl != null && payload.avatarUrl.length > 512) {
      return NextResponse.json({ error: "avatarUrl too long" }, { status: 400 });
    }
    if (payload.avatarPath != null && payload.avatarPath.length > 256) {
      return NextResponse.json({ error: "avatarPath too long" }, { status: 400 });
    }
    const payloadJson = JSON.stringify(payload);

    const msg = expectedProfileUpdateMessage({
      walletPubkey: normalizedWallet,
      timestampUnix: Math.floor(timestampUnix),
      payloadJson,
    });

    const signature = bs58.decode(signatureB58);
    const ok = nacl.sign.detached.verify(new TextEncoder().encode(msg), signature, new PublicKey(normalizedWallet).toBytes());
    if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    const profile = await upsertProfile({
      walletPubkey: normalizedWallet,
      displayName: payload.displayName,
      bio: payload.bio,
      avatarPath: payload.avatarPath,
      avatarUrl: payload.avatarUrl,
    });

    return NextResponse.json({ ok: true, profile });
  } catch (e) {
    return apiError(e, "profiles/[wallet]");
  }
}
