import { NextResponse } from "next/server";
import crypto from "crypto";
import { PublicKey } from "@solana/web3.js";

import { checkRateLimit } from "../../../../lib/rateLimit";
import { apiError } from "../../../../lib/apiError";
import { verifyAdminOrigin } from "../../../../lib/adminSession";
import { authorizeLaunchAccess } from "../../../../lib/creatorAuth";
import { ASSET_MAX_BYTES, createUploadTicket, extFromContentType } from "../../../../lib/assetStorage";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "launch-assets:upload-url", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    verifyAdminOrigin(req);

    const body = (await req.json().catch(() => null)) as any;

    const payerWallet = typeof body?.payerWallet === "string" ? body.payerWallet.trim() : "";
    if (!payerWallet) return NextResponse.json({ error: "payerWallet is required" }, { status: 400 });

    try {
      new PublicKey(payerWallet);
    } catch {
      return NextResponse.json({ error: "Invalid payerWallet" }, { status: 400 });
    }

    const denied = await authorizeLaunchAccess(req, { body, payerWallet, auditEvent: "launch_assets_denied" });
    if (denied) return NextResponse.json({ error: denied.error, hint: denied.hint }, { status: denied.status });

    const kindRaw = typeof body?.kind === "string" ? body.kind.trim().toLowerCase() : "";
    const kind: "icon" | "banner" = kindRaw === "banner" ? "banner" : "icon";

    const contentType = typeof body?.contentType === "string" ? body.contentType.trim() : "image/png";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return NextResponse.json({ error: "contentType must be an image" }, { status: 400 });
    }

    const bucket = String(process.env.SUPABASE_PROJECT_ASSETS_BUCKET ?? "project-assets").trim() || "project-assets";
    const ext = extFromContentType(contentType);
    const sessionId = crypto.randomBytes(16).toString("hex");
    const fileId = crypto.randomBytes(12).toString("hex");
    const path = `launch-staging/${sessionId}/${kind}/${fileId}.${ext}`;

    const ticket = await createUploadTicket(req, {
      bucket,
      path,
      contentType,
      maxBytes: kind === "banner" ? ASSET_MAX_BYTES.banner : ASSET_MAX_BYTES.icon,
    });

    return NextResponse.json(ticket);
  } catch (e) {
    return apiError(e, "launch-assets/upload-url");
  }
}
