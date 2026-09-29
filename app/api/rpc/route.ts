import { NextResponse } from "next/server";

import { checkRateLimit } from "../../lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/rpc
 *
 * Same-origin JSON-RPC proxy for the browser. It keeps the server-side RPC key private, avoids the public
 * mainnet RPC (which throttles/blocks browser origins), and only forwards a short allowlist of read methods
 * plus sendTransaction/simulateTransaction.
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
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "getTransaction",
  "getVersion",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);

const MAX_BODY_BYTES = 512 * 1024;
const MAX_BATCH = 20;

function rpcError(status: number, message: string, id: unknown = null) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32000, message } }, { status });
}

export async function POST(req: Request) {
  const rl = await checkRateLimit(req, { keyPrefix: "rpc", limit: 300, windowSeconds: 60 });
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
