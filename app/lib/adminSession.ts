import crypto from "crypto";

import { getPool, hasDatabase } from "./db";

type AdminNonceRecord = {
  walletPubkey: string;
  nonce: string;
  createdAtUnix: number;
};

type AdminSessionRecord = {
  sessionId: string;
  walletPubkey: string;
  createdAtUnix: number;
  expiresAtUnix: number;
};

const COOKIE_SESSION = "cts_admin_session";

const mem = {
  nonces: new Map<string, AdminNonceRecord>(),
  sessions: new Map<string, AdminSessionRecord>(),
};

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const parts = header.split(";");
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx < 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function getAdminCookieName(): string {
  return COOKIE_SESSION;
}

export function getAllowedAdminWallets(): Set<string> {
  const raw = String(process.env.ADMIN_WALLET_PUBKEYS ?? "").trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("ADMIN_WALLET_PUBKEYS is required in production");
    }
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function normalizeOrigin(value: string): string {
  const v = String(value ?? "").trim();
  if (!v) return "";
  try {
    const u = new URL(v);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return v.replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * CSRF / origin gate for state-changing endpoints.
 * APP_ORIGIN may be a comma-separated list. A request is also accepted when its Origin host matches the
 * Host it was sent to (same-site), so the Railway domain, www/apex and a later custom domain all keep working.
 */
export function verifyAdminOrigin(req: Request): void {
  const configured = String(process.env.APP_ORIGIN ?? "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
  const isProd = process.env.NODE_ENV === "production";
  if (!configured.length) {
    if (isProd) throw new Error("APP_ORIGIN is required in production");
    return;
  }

  const origin = req.headers.get("origin");
  if (!origin) {
    // Browsers don't send Origin on same-origin GET/HEAD; those are read-only and cookie auth is SameSite=Lax.
    const method = String(req.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") return;
    throw Object.assign(new Error("Missing Origin"), { status: 403 });
  }
  if (configured.includes(normalizeOrigin(origin))) return;

  const host = String(req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  try {
    if (host && new URL(origin).host.toLowerCase() === host) return;
  } catch {
    // fall through
  }

  console.error("[origin] rejected request", { origin, host, configured });
  throw Object.assign(new Error("Invalid Origin"), { status: 403 });
}

let ensuredAdminSchema: Promise<void> | null = null;

async function ensureAdminSchema(): Promise<void> {
  if (!hasDatabase()) return;
  if (ensuredAdminSchema) return ensuredAdminSchema;

  ensuredAdminSchema = (async () => {
    const pool = getPool();
    await pool.query(`
      create table if not exists admin_nonces (
        wallet_pubkey text not null,
        nonce text primary key,
        created_at_unix bigint not null
      );
      create index if not exists admin_nonces_wallet_idx on admin_nonces(wallet_pubkey);

      create table if not exists admin_sessions (
        session_id text primary key,
        wallet_pubkey text not null,
        created_at_unix bigint not null,
        expires_at_unix bigint not null
      );
      create index if not exists admin_sessions_wallet_idx on admin_sessions(wallet_pubkey);
      create index if not exists admin_sessions_expires_idx on admin_sessions(expires_at_unix);
    `);
  })().catch((e) => {
    ensuredAdminSchema = null;
    throw e;
  });

  return ensuredAdminSchema;
}

export function expectedAdminLoginMessage(input: { walletPubkey: string; nonce: string }): string {
  return `Ship & Commit\nAdmin Login\nWallet: ${input.walletPubkey}\nNonce: ${input.nonce}`;
}

export async function createAdminNonce(input: { walletPubkey: string }): Promise<{ nonce: string; createdAtUnix: number }> {
  await ensureAdminSchema();

  const nonce = crypto.randomBytes(18).toString("hex");
  const createdAtUnix = nowUnix();

  const rec: AdminNonceRecord = { walletPubkey: input.walletPubkey, nonce, createdAtUnix };

  if (!hasDatabase()) {
    mem.nonces.set(nonce, rec);
    return { nonce, createdAtUnix };
  }

  const pool = getPool();
  await pool.query("insert into admin_nonces (wallet_pubkey, nonce, created_at_unix) values ($1,$2,$3)", [
    input.walletPubkey,
    nonce,
    String(createdAtUnix),
  ]);

  return { nonce, createdAtUnix };
}

export async function consumeAdminNonce(input: {
  walletPubkey: string;
  nonce: string;
  maxAgeSeconds: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  await ensureAdminSchema();
  const cutoff = nowUnix() - Math.max(1, input.maxAgeSeconds);

  if (!hasDatabase()) {
    const rec = mem.nonces.get(input.nonce);
    if (!rec) return { ok: false, reason: "Nonce not found" };
    if (rec.walletPubkey !== input.walletPubkey) return { ok: false, reason: "Nonce wallet mismatch" };
    if (rec.createdAtUnix < cutoff) {
      mem.nonces.delete(input.nonce);
      return { ok: false, reason: "Nonce expired" };
    }
    mem.nonces.delete(input.nonce);
    return { ok: true };
  }

  const pool = getPool();
  const res = await pool.query(
    "delete from admin_nonces where nonce=$1 and wallet_pubkey=$2 and created_at_unix >= $3 returning nonce",
    [input.nonce, input.walletPubkey, String(cutoff)]
  );

  if (!res.rows[0]) return { ok: false, reason: "Nonce invalid or expired" };
  return { ok: true };
}

export async function createAdminSession(input: {
  walletPubkey: string;
  sessionTtlSeconds: number;
}): Promise<AdminSessionRecord> {
  await ensureAdminSchema();

  const createdAtUnix = nowUnix();
  const expiresAtUnix = createdAtUnix + Math.max(60, input.sessionTtlSeconds);
  const sessionId = crypto.randomBytes(32).toString("hex");

  const rec: AdminSessionRecord = { sessionId, walletPubkey: input.walletPubkey, createdAtUnix, expiresAtUnix };

  if (!hasDatabase()) {
    mem.sessions.set(sessionId, rec);
    return rec;
  }

  const pool = getPool();
  await pool.query(
    "insert into admin_sessions (session_id, wallet_pubkey, created_at_unix, expires_at_unix) values ($1,$2,$3,$4)",
    [sessionId, input.walletPubkey, String(createdAtUnix), String(expiresAtUnix)]
  );

  return rec;
}

export async function deleteAdminSession(sessionId: string): Promise<void> {
  await ensureAdminSchema();

  if (!hasDatabase()) {
    mem.sessions.delete(sessionId);
    return;
  }

  const pool = getPool();
  await pool.query("delete from admin_sessions where session_id=$1", [sessionId]);
}

export async function getAdminSessionWallet(req: Request): Promise<string | null> {
  await ensureAdminSchema();

  const cookies = parseCookies(req.headers.get("cookie"));
  const sessionId = cookies[COOKIE_SESSION];
  if (!sessionId) return null;

  const t = nowUnix();

  if (!hasDatabase()) {
    const rec = mem.sessions.get(sessionId);
    if (!rec) return null;
    if (rec.expiresAtUnix <= t) {
      mem.sessions.delete(sessionId);
      return null;
    }
    return rec.walletPubkey;
  }

  const pool = getPool();
  const res = await pool.query(
    "select wallet_pubkey, expires_at_unix from admin_sessions where session_id=$1",
    [sessionId]
  );
  const row = res.rows[0];
  if (!row) return null;
  const expiresAtUnix = Number(row.expires_at_unix);
  if (!Number.isFinite(expiresAtUnix) || expiresAtUnix <= t) {
    await pool.query("delete from admin_sessions where session_id=$1", [sessionId]);
    return null;
  }
  return String(row.wallet_pubkey);
}

export function buildAdminSessionCookie(input: { sessionId: string; maxAgeSeconds: number }): string {
  const secure = process.env.NODE_ENV === "production";
  const parts = [
    `${COOKIE_SESSION}=${encodeURIComponent(input.sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(60, input.maxAgeSeconds)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildAdminSessionClearCookie(): string {
  const secure = process.env.NODE_ENV === "production";
  const parts = [`${COOKIE_SESSION}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"]; 
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
