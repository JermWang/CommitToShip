import { NextResponse } from "next/server";

import { checkRateLimit } from "../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { putDatabaseAsset, verifyUploadToken } from "../../../lib/assetStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /api/assets/upload?token=...
 *
 * Receives an image for a previously issued upload ticket (see createUploadTicket in lib/assetStorage.ts).
 * The token is HMAC-signed and pins bucket, path and max size; the bytes are validated by magic number.
 */
/** Reads the request body but gives up as soon as it exceeds `max` bytes (never buffers an unbounded upload). */
async function readBodyCapped(req: Request, max: number): Promise<Buffer | null> {
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => null);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export async function PUT(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "assets:upload", limit: 30, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const token = new URL(req.url).searchParams.get("token") ?? "";
    const ticket = verifyUploadToken(token);

    const declared = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > ticket.maxBytes) {
      return NextResponse.json({ error: `File too large (max ${Math.floor(ticket.maxBytes / (1024 * 1024))}MB)` }, { status: 413 });
    }

    const data = await readBodyCapped(req, ticket.maxBytes);
    if (!data) {
      return NextResponse.json({ error: `File too large (max ${Math.floor(ticket.maxBytes / (1024 * 1024))}MB)` }, { status: 413 });
    }
    if (data.length === 0) return NextResponse.json({ error: "Empty upload" }, { status: 400 });

    await putDatabaseAsset({ bucket: ticket.bucket, path: ticket.path, data, declaredContentType: ticket.contentType });
    return NextResponse.json({ ok: true, path: ticket.path });
  } catch (e) {
    const status = Number((e as any)?.status);
    if (status === 401 || status === 413 || status === 415) {
      return NextResponse.json({ error: (e as Error).message }, { status });
    }
    console.error("[assets] upload failed", e);
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}

// Some clients POST signed uploads; accept both verbs.
export const POST = PUT;
