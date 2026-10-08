import { NextResponse } from "next/server";
import crypto from "crypto";

import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { checkRateLimit } from "../../../../lib/rateLimit";
import { apiError } from "../../../../lib/apiError";
import { getConnection, getMintAuthorityBase58, getTokenMetadataUpdateAuthorityBase58 } from "../../../../lib/solana";
import { getAllowedCreatorWallets, isPublicLaunchEnabled } from "../../../../lib/creatorAuth";
import { ASSET_MAX_BYTES, createUploadTicket, extFromContentType } from "../../../../lib/assetStorage";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "project-assets:upload-url", limit: 30, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const body = (await req.json().catch(() => null)) as any;

    const tokenMintRaw = typeof body?.tokenMint === "string" ? body.tokenMint.trim() : "";
    if (!tokenMintRaw) return NextResponse.json({ error: "tokenMint is required" }, { status: 400 });
    const tokenMint = new PublicKey(tokenMintRaw).toBase58();

    const kindRaw = typeof body?.kind === "string" ? body.kind.trim().toLowerCase() : "";
    const kind: "icon" | "banner" = kindRaw === "banner" ? "banner" : "icon";

    const contentType = typeof body?.contentType === "string" ? body.contentType.trim() : "image/png";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return NextResponse.json({ error: "contentType must be an image" }, { status: 400 });
    }

    const devVerify = body?.devVerify as any;
    const devWalletPubkey = typeof devVerify?.walletPubkey === "string" ? devVerify.walletPubkey.trim() : "";
    const signatureB58 = typeof devVerify?.signatureB58 === "string" ? devVerify.signatureB58.trim() : "";
    const timestampUnix = Number(devVerify?.timestampUnix);
    if (!devWalletPubkey || !signatureB58 || !Number.isFinite(timestampUnix) || timestampUnix <= 0) {
      return NextResponse.json({ error: "devVerify (walletPubkey, signatureB58, timestampUnix) is required" }, { status: 400 });
    }

    const devWallet = new PublicKey(devWalletPubkey);

    if (!isPublicLaunchEnabled()) {
      const allowed = getAllowedCreatorWallets();
      if (!allowed.has(devWallet.toBase58())) {
        return NextResponse.json(
          {
            error: "This wallet is not approved to launch yet",
            hint: "Launches are currently limited to approved wallets.",
          },
          { status: 403 }
        );
      }
    }
    const nowUnix = Math.floor(Date.now() / 1000);
    if (Math.abs(nowUnix - timestampUnix) > 5 * 60) {
      return NextResponse.json({ error: "Verification timestamp expired" }, { status: 400 });
    }

    const message = `Ship & Commit\nDev Verification\nMint: ${tokenMint}\nWallet: ${devWallet.toBase58()}\nTimestamp: ${timestampUnix}`;
    const signature = bs58.decode(signatureB58);
    const okSig = nacl.sign.detached.verify(new TextEncoder().encode(message), signature, devWallet.toBytes());
    if (!okSig) {
      return NextResponse.json({ error: "Invalid dev verification signature" }, { status: 401 });
    }

    const connection = getConnection();
    const [mintAuthority, updateAuthority] = await Promise.all([
      getMintAuthorityBase58({ connection, mint: new PublicKey(tokenMint) }),
      getTokenMetadataUpdateAuthorityBase58({ connection, mint: new PublicKey(tokenMint) }),
    ]);

    const okAuthority = mintAuthority === devWallet.toBase58() || updateAuthority === devWallet.toBase58();
    if (!okAuthority) {
      return NextResponse.json({ error: "Wallet is not token authority", mintAuthority, updateAuthority }, { status: 403 });
    }

    const bucket = String(process.env.SUPABASE_PROJECT_ASSETS_BUCKET ?? "project-assets").trim() || "project-assets";
    const ext = extFromContentType(contentType);
    const id = crypto.randomBytes(12).toString("hex");
    const path = `${tokenMint}/${kind}/${id}.${ext}`;

    const ticket = await createUploadTicket(req, {
      bucket,
      path,
      contentType,
      maxBytes: kind === "banner" ? ASSET_MAX_BYTES.banner : ASSET_MAX_BYTES.icon,
    });

    return NextResponse.json(ticket);
  } catch (e) {
    return apiError(e, "project-assets/upload-url");
  }
}
