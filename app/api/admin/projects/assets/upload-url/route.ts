import { NextResponse } from "next/server";
import crypto from "crypto";
import { PublicKey } from "@solana/web3.js";

import { checkRateLimit } from "../../../../../lib/rateLimit";
import { apiError } from "../../../../../lib/apiError";
import { getAdminSessionWallet, getAllowedAdminWallets, verifyAdminOrigin } from "../../../../../lib/adminSession";
import { ASSET_MAX_BYTES, createUploadTicket, extFromContentType } from "../../../../../lib/assetStorage";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "admin:project-assets:upload-url", limit: 30, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    verifyAdminOrigin(req);

    const walletPubkey = await getAdminSessionWallet(req);
    if (!walletPubkey || !getAllowedAdminWallets().has(walletPubkey)) {
      return NextResponse.json({ error: "Admin sign-in required" }, { status: 401 });
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

    const bucket = "project-assets";
    const ext = extFromContentType(contentType);
    const id = crypto.randomBytes(12).toString("hex");
    const path = `${tokenMint}/${kind}/${id}.${ext}`;

    const ticket = await createUploadTicket(req, {
      bucket,
      path,
      contentType,
      maxBytes: kind === "banner" ? ASSET_MAX_BYTES.banner : ASSET_MAX_BYTES.icon,
    });

    return NextResponse.json({ ...ticket, walletPubkey });
  } catch (e) {
    return apiError(e, "admin-project-assets/upload-url");
  }
}
