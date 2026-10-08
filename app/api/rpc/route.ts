import { NextResponse } from "next/server";

import { verifyAdminOrigin } from "../../lib/adminSession";
import { getPool, hasDatabase } from "../../lib/db";
import { checkRateLimit, getClientIp } from "../../lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/rpc
 *
 * Same-origin JSON-RPC proxy for the browser. It keeps the server-side RPC key private, avoids the public
 * mainnet RPC (which throttles/blocks browser origins), and only forwards a short allowlist: the reads the wallet
 * adapter and our pages use, plus sendTransaction/simulateTransaction (the wallet adapter's sendTransaction path
 * and the dashboard's signTransaction fallback broadcast through this connection - see lib/clientRpc.ts).
 *
 * Abuse limits: same-origin only (Origin must be the app), and every call in a batch counts against the per-IP
 * rate limit (a 20-call batch costs 20, not 1).
 */
const ALLOWED_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getFeeForMessage",
  "getHealth",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenSupply",
  "getVersion",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);

const MAX_BODY_BYTES = 512 * 1024;
const MAX_BATCH = 20;
const RATE_LIMIT = 300;
const RATE_WINDOW_SECONDS = 60;

function rpcError(status: number, message: string, id: unknown = null) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32000, message } }, { status });
}

/**
 * Adds `extra` more calls to this client's current rate-limit window (same key/window as checkRateLimit, which has
 * already counted 1). Returns false once the window is over the limit.
 */
async function chargeExtraCalls(req: Request, extra: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  if (extra <= 0) return { allowed: true, retryAfterSeconds: 0 };
  const t = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(t / RATE_WINDOW_SECONDS) * RATE_WINDOW_SECONDS;
  const resetAt = windowStart + RATE_WINDOW_SECONDS;

  if (!hasDatabase()) {
    // In-memory mode: count the remaining calls through the regular limiter.
    for (let i = 0; i < extra; i++) {
      const r = await checkRateLimit(req, { keyPrefix: "rpc", limit: RATE_LIMIT, windowSeconds: RATE_WINDOW_SECONDS });
      if (!r.allowed) return { allowed: false, retryAfterSeconds: r.retryAfterSeconds };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  try {
    const key = `rpc:${getClientIp(req)}`;
    const { rows } = await getPool().query(
      `insert into public.rate_limits (key, window_start_unix, count, reset_at_unix, updated_at_unix) values ($1, $2, $3, $4, $5)
       on conflict (key, window_start_unix) do update set count = public.rate_limits.count + excluded.count, updated_at_unix = excluded.updated_at_unix
       returning count`,
      [key, windowStart, extra, resetAt, t]
    );
    const count = Number(rows?.[0]?.count ?? 0);
    return count > RATE_LIMIT ? { allowed: false, retryAfterSeconds: Math.max(1, resetAt - t) } : { allowed: true, retryAfterSeconds: 0 };
  } catch {
    // Same fail-open behaviour as checkRateLimit when the DB is unavailable.
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export async function POST(req: Request) {
  try {
    verifyAdminOrigin(req);
  } catch {
    return rpcError(403, "Request blocked: this page is not allowed to call the RPC proxy.");
  }

  const rl = await checkRateLimit(req, { keyPrefix: "rpc", limit: RATE_LIMIT, windowSeconds: RATE_WINDOW_SECONDS });
  if (!rl.allowed) {
    const res = rpcError(429, "Rate limit exceeded");
    res.headers.set("retry-after", String(rl.retryAfterSeconds));
    return res;
  }

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return rpcError(413, "Request too large");

  const raw = await req.text().catch(() => "");
  if (!raw || raw.length > MAX_BODY_BYTES) return rpcError(400, "Invalid request");

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return rpcError(400, "Invalid JSON");
  }

  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0 || calls.length > MAX_BATCH) return rpcError(400, "Invalid batch size");
  for (const c of calls) {
    if (!c || typeof c.method !== "string" || !ALLOWED_METHODS.has(c.method)) {
      return rpcError(403, `Method not allowed: ${String(c?.method ?? "")}`, c?.id ?? null);
    }
  }

  // Every call in a batch counts (the first one was charged above).
  const charged = await chargeExtraCalls(req, calls.length - 1);
  if (!charged.allowed) {
    const res = rpcError(429, "Rate limit exceeded");
    res.headers.set("retry-after", String(charged.retryAfterSeconds));
    return res;
  }

  const upstream = String(process.env.SOLANA_RPC_URL ?? "").trim() || "https://api.mainnet-beta.solana.com";

  try {
    const res = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    console.error("[rpc] upstream failed", e instanceof Error ? e.message : e);
    return rpcError(502, "RPC upstream unavailable");
  }
}
