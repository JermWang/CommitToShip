import crypto from "crypto";

import { getPool, hasDatabase } from "./db";

/**
 * Asset storage for user-uploaded images (token icons/banners, avatars).
 *
 * Two interchangeable backends behind one "upload ticket" contract:
 *  - "supabase": Supabase Storage signed upload URLs (used only when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set)
 *  - "database": images stored in Postgres and served by /api/assets/* (default; needs nothing but DATABASE_URL)
 *
 * The client contract is identical for both: POST for a ticket, PUT the file to `signedUrl`,
 * then use `publicUrl` as the image URL.
 */

export type AssetBucket = string;

export type UploadTicket = {
  ok: true;
  bucket: string;
  path: string;
  token: string;
  signedUrl: string;
  publicUrl: string;
  expiresInSeconds: number;
};

export const ASSET_MAX_BYTES = {
  icon: 15 * 1024 * 1024,
  banner: 5 * 1024 * 1024,
  avatar: 5 * 1024 * 1024,
} as const;

const UPLOAD_TTL_SECONDS = 2 * 60 * 60;

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function assetStorageMode(): "supabase" | "database" {
  const url = String(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  return url && key ? "supabase" : "database";
}

export function extFromContentType(contentType: string): string {
  const ct = String(contentType ?? "").toLowerCase();
  if (ct.includes("image/png")) return "png";
  if (ct.includes("image/jpeg") || ct.includes("image/jpg")) return "jpg";
  if (ct.includes("image/gif")) return "gif";
  if (ct.includes("image/webp")) return "webp";
  return "png";
}

function normalizeImageType(contentType: string): string {
  const ct = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  return ct === "image/jpg" ? "image/jpeg" : ct;
}

/** Detects the real image type from magic bytes (never trust the client-declared content-type). */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}

/**
 * Own-store image URLs are saved with whatever origin the uploader was on. Reading them back as relative paths keeps
 * images working across domain changes (Railway domain -> custom domain, www/apex, ...).
 */
export function relativizeOwnAssetUrl<T extends string | null | undefined>(url: T): T {
  if (typeof url !== "string") return url;
  const m = url.match(/^https?:\/\/[^/]+(\/api\/assets\/.+)$/i);
  return (m ? m[1] : url) as T;
}

/** The origin the visitor is actually on (works behind Railway's proxy and across domain changes). */
export function getRequestOrigin(req: Request): string {
  const h = (name: string) => String(req.headers.get(name) ?? "").split(",")[0].trim();
  const host = h("x-forwarded-host") || h("host");
  if (host) {
    const proto = h("x-forwarded-proto") || (/^(localhost|127\.|\[::1\])/i.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  }
  try {
    return new URL(req.url).origin;
  } catch {
    return String(process.env.APP_ORIGIN ?? "").split(",")[0].trim().replace(/\/+$/, "");
  }
}

// ---------------------------------------------------------------------------
// Upload tickets
// ---------------------------------------------------------------------------

export async function createUploadTicket(
  req: Request,
  input: { bucket: string; path: string; contentType: string; maxBytes: number }
): Promise<UploadTicket> {
  if (assetStorageMode() === "supabase") return createSupabaseTicket(input);
  return createDatabaseTicket(req, input);
}

async function createSupabaseTicket(input: { bucket: string; path: string }): Promise<UploadTicket> {
  const supabaseUrl = String(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  const storageBase = `${supabaseUrl}/storage/v1`;
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

  const res = await fetch(`${storageBase}/object/upload/sign/${encodeURIComponent(input.bucket)}/${input.path}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      "x-upsert": "true",
    },
    body: JSON.stringify({ expiresIn: UPLOAD_TTL_SECONDS }),
  });

  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    throw new Error(json?.message ?? json?.error ?? `Storage request failed (${res.status})`);
  }

  const raw = String(json?.url ?? "").trim();
  const p = raw.replace(/^\/+/, "");
  const signedUrl = /^https?:\/\//i.test(raw) ? raw : p.startsWith("storage/v1/") ? `${supabaseUrl}/${p}` : `${storageBase}/${p}`;
  const token = new URL(signedUrl).searchParams.get("token") || "";
  if (!token) throw new Error("Storage did not return token");

  return {
    ok: true,
    bucket: input.bucket,
    path: input.path,
    token,
    signedUrl,
    publicUrl: `${storageBase}/object/public/${encodeURIComponent(input.bucket)}/${input.path}`,
    expiresInSeconds: UPLOAD_TTL_SECONDS,
  };
}

function signingKey(): Buffer {
  const secret =
    String(process.env.ASSET_SIGNING_SECRET ?? "").trim() ||
    String(process.env.ESCROW_DB_SECRET ?? "").trim() ||
    String(process.env.PRIVY_APP_SECRET ?? "").trim();
  if (!secret) throw new Error("ASSET_SIGNING_SECRET (or ESCROW_DB_SECRET) is required for uploads");
  return crypto.createHash("sha256").update(`asset-upload:v1:${secret}`).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

type UploadTokenPayload = { b: string; p: string; c: string; m: number; e: number };

function signUploadToken(payload: UploadTokenPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(crypto.createHmac("sha256", signingKey()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyUploadToken(token: string): { bucket: string; path: string; contentType: string; maxBytes: number } {
  const [body, sig] = String(token ?? "").split(".");
  if (!body || !sig) throw Object.assign(new Error("Invalid upload token"), { status: 401 });

  const expected = crypto.createHmac("sha256", signingKey()).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw Object.assign(new Error("Invalid upload token"), { status: 401 });
  }

  let payload: UploadTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid upload token"), { status: 401 });
  }

  if (!payload || typeof payload.p !== "string" || typeof payload.b !== "string" || Number(payload.e) < Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error("Upload link expired. Please try again."), { status: 401 });
  }

  return { bucket: payload.b, path: payload.p, contentType: String(payload.c ?? ""), maxBytes: Number(payload.m) || 0 };
}

async function createDatabaseTicket(
  req: Request,
  input: { bucket: string; path: string; contentType: string; maxBytes: number }
): Promise<UploadTicket> {
  if (!hasDatabase()) throw new Error("Uploads are unavailable: no database configured");

  const exp = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
  const token = signUploadToken({ b: input.bucket, p: input.path, c: normalizeImageType(input.contentType), m: input.maxBytes, e: exp });
  const origin = getRequestOrigin(req);

  return {
    ok: true,
    bucket: input.bucket,
    path: input.path,
    token,
    // Relative on purpose: the browser PUTs to whichever origin it is currently on (no CORS surprises).
    signedUrl: `/api/assets/upload?token=${encodeURIComponent(token)}`,
    publicUrl: `${origin}/api/assets/${encodeURIComponent(input.bucket)}/${input.path.split("/").map(encodeURIComponent).join("/")}`,
    expiresInSeconds: UPLOAD_TTL_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// Database backend
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (ensured) return ensured;
  ensured = (async () => {
    const pool = getPool();
    await pool.query(`
      create table if not exists uploaded_assets (
        bucket text not null,
        path text not null,
        content_type text not null,
        size_bytes integer not null,
        data bytea not null,
        created_at_unix bigint not null,
        primary key (bucket, path)
      );
      create index if not exists uploaded_assets_created_idx on uploaded_assets(created_at_unix);
    `);
  })().catch((e) => {
    ensured = null;
    throw e;
  });
  return ensured;
}

export async function putDatabaseAsset(input: { bucket: string; path: string; data: Buffer; declaredContentType?: string }): Promise<void> {
  const sniffed = sniffImageType(input.data);
  if (!sniffed || !ALLOWED_IMAGE_TYPES.has(sniffed)) {
    throw Object.assign(new Error("Unsupported image. Use a real .png, .jpg, .gif or .webp file."), { status: 415 });
  }

  await ensureSchema();
  await getPool().query(
    `insert into uploaded_assets (bucket, path, content_type, size_bytes, data, created_at_unix)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (bucket, path) do update
       set content_type = excluded.content_type, size_bytes = excluded.size_bytes, data = excluded.data, created_at_unix = excluded.created_at_unix`,
    [input.bucket, input.path, sniffed, input.data.length, input.data, String(Math.floor(Date.now() / 1000))]
  );
}

export async function getDatabaseAsset(bucket: string, path: string): Promise<{ contentType: string; data: Buffer } | null> {
  if (!hasDatabase()) return null;
  await ensureSchema();
  const { rows } = await getPool().query("select content_type, data from uploaded_assets where bucket = $1 and path = $2", [bucket, path]);
  const row = rows[0];
  if (!row) return null;
  return { contentType: String(row.content_type), data: row.data as Buffer };
}

/**
 * Resolves an image URL that points at our own asset store to its bytes (no outbound HTTP, no SSRF surface).
 * Returns null when the URL is not one of ours.
 */
export async function readOwnAssetByUrl(rawUrl: string): Promise<{ contentType: string; data: Buffer } | null> {
  let pathname = "";
  try {
    pathname = new URL(rawUrl, "http://internal.invalid").pathname;
  } catch {
    return null;
  }
  const m = pathname.match(/^\/api\/assets\/([a-z0-9-]{1,60})\/(.+)$/i);
  if (!m) return null;
  const path = m[2].split("/").map((s) => decodeURIComponent(s)).join("/");
  return getDatabaseAsset(decodeURIComponent(m[1]), path);
}

/** Housekeeping: drop launch staging uploads that never made it into a launch. */
export async function pruneStaleStagingAssets(maxAgeSeconds = 7 * 24 * 60 * 60): Promise<number> {
  if (!hasDatabase()) return 0;
  await ensureSchema();
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
  const res = await getPool().query("delete from uploaded_assets where path like 'launch-staging/%' and created_at_unix < $1", [String(cutoff)]);
  return res.rowCount ?? 0;
}
