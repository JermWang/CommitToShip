import crypto from "crypto";
import { NextResponse } from "next/server";

import { getDatabaseAsset } from "../../../../lib/assetStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

/** GET /api/assets/:bucket/...path  — serves images uploaded through the database storage backend. */
export async function GET(req: Request, ctx: { params: { bucket: string; path: string[] } }) {
  const bucket = String(ctx.params.bucket ?? "");
  const segments = Array.isArray(ctx.params.path) ? ctx.params.path : [];

  if (!SAFE_SEGMENT.test(bucket) || segments.length === 0 || segments.length > 6 || !segments.every((s) => SAFE_SEGMENT.test(s) && s !== "." && s !== "..")) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const asset = await getDatabaseAsset(bucket, segments.join("/"));
    if (!asset) return new NextResponse("Not found", { status: 404 });

    const etag = `"${crypto.createHash("sha1").update(asset.data).digest("hex")}"`;
    const headers: Record<string, string> = {
      "content-type": asset.contentType,
      "cache-control": "public, max-age=31536000, immutable",
      etag,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      "access-control-allow-origin": "*",
    };

    if (req.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });

    return new NextResponse(new Uint8Array(asset.data), { status: 200, headers });
  } catch (e) {
    console.error("[assets] read failed", e);
    return new NextResponse("Unavailable", { status: 503 });
  }
}
