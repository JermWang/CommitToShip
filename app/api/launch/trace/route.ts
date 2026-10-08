import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { checkRateLimit } from "../../../lib/rateLimit";
import { auditLog } from "../../../lib/auditLog";
import { apiError } from "../../../lib/apiError";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { getAdminCookieName, getAdminSessionWallet, getAllowedAdminWallets, verifyAdminOrigin } from "../../../lib/adminSession";
import { getConnection } from "../../../lib/solana";
import { withRetry } from "../../../lib/rpc";
import { getPumpProgramId } from "../../../lib/pumpfun";

export const runtime = "nodejs";

export async function GET() {
  const res = NextResponse.json({ error: "Method Not Allowed. Use POST /api/launch/trace." }, { status: 405 });
  res.headers.set("allow", "POST, OPTIONS");
  return res;
}

export async function OPTIONS(req: Request) {
  const expected = String(process.env.APP_ORIGIN ?? "").trim();
  const origin = req.headers.get("origin") ?? "";

  try {
    verifyAdminOrigin(req);
  } catch {
    const res = new NextResponse(null, { status: 204 });
    res.headers.set("allow", "POST, OPTIONS");
    return res;
  }

  const res = new NextResponse(null, { status: 204 });
  res.headers.set("allow", "POST, OPTIONS");
  res.headers.set("access-control-allow-origin", origin || expected);
  res.headers.set("access-control-allow-methods", "POST, OPTIONS");
  res.headers.set("access-control-allow-headers", "content-type");
  res.headers.set("access-control-allow-credentials", "true");
  res.headers.set("vary", "origin");
  return res;
}

async function requireAdmin(req: Request): Promise<{ ok: true; adminWallet: string } | { ok: false; res: NextResponse }> {
  verifyAdminOrigin(req);

  const cookieHeader = String(req.headers.get("cookie") ?? "");
  const hasAdminCookie = cookieHeader.includes(`${getAdminCookieName()}=`);
  const allowed = getAllowedAdminWallets();
  const adminWallet = await getAdminSessionWallet(req);

  if (!adminWallet) {
    await auditLog("admin_launch_trace_denied", { hasAdminCookie });
    return {
      ok: false,
      res: NextResponse.json(
        {
          error: hasAdminCookie ? "Admin session not found or expired. Try Admin Sign-In again." : "Admin Sign-In required",
        },
        { status: 401 }
      ),
    };
  }

  if (!allowed.has(adminWallet)) {
    await auditLog("admin_launch_trace_denied", { adminWallet });
    return { ok: false, res: NextResponse.json({ error: "Not an allowed admin wallet" }, { status: 401 }) };
  }

  return { ok: true, adminWallet };
}

function getAccountDeltaLamports(parsedTx: any, account: string): number | null {
  const keys = parsedTx?.transaction?.message?.accountKeys;
  const meta = parsedTx?.meta;
  const pre = meta?.preBalances;
  const post = meta?.postBalances;

  if (!Array.isArray(keys) || !Array.isArray(pre) || !Array.isArray(post)) return null;

  const idx = keys.findIndex((k: any) => String((k as any)?.pubkey ?? k) === account);
  if (idx < 0) return null;

  const preLamports = Number(pre[idx] ?? NaN);
  const postLamports = Number(post[idx] ?? NaN);
  if (!Number.isFinite(preLamports) || !Number.isFinite(postLamports)) return null;

  return postLamports - preLamports;
}

function extractPumpMints(parsedTx: any, pumpProgramId: string): string[] {
  const out = new Set<string>();
  const ixs = (parsedTx?.transaction?.message?.instructions ?? []) as any[];

  for (const ix of ixs) {
    const programId = String(ix?.programId ?? "").trim() || String(ix?.programIdIndex ?? "").trim();
    const programIdStr = programId || String(ix?.programId?.toString?.() ?? "");

    const isPump = programIdStr === pumpProgramId;
    if (!isPump) continue;

    const accounts = Array.isArray(ix?.accounts) ? ix.accounts : [];
    if (accounts.length > 0) {
      const mint = String(accounts[0] ?? "").trim();
      if (mint) out.add(mint);
    }
  }

  return Array.from(out);
}

function extractSystemTransfers(parsedTx: any): { source: string; destination: string; lamports: number }[] {
  const out: { source: string; destination: string; lamports: number }[] = [];
  const ixs = (parsedTx?.transaction?.message?.instructions ?? []) as any[];

  for (const ix of ixs) {
    const program = String(ix?.program ?? "").trim();
    const parsed = ix?.parsed;
    const type = String(parsed?.type ?? "").trim();
    const info = parsed?.info;

    if (program !== "system" || type !== "transfer") continue;
    const source = typeof info?.source === "string" ? info.source : "";
    const destination = typeof info?.destination === "string" ? info.destination : "";
    const lamports = Number(info?.lamports ?? 0);
    if (!source || !destination || !Number.isFinite(lamports) || lamports <= 0) continue;
    out.push({ source, destination, lamports });
  }

  return out;
}

function extractInvokedPrograms(parsedTx: any): string[] {
  const logs = parsedTx?.meta?.logMessages;
  if (!Array.isArray(logs) || logs.length === 0) return [];

  const out = new Set<string>();
  const re = /Program\s+([1-9A-HJ-NP-Za-km-z]{32,44})\s+invoke/;
  for (const line of logs) {
    const s = String(line);
    const m = s.match(re);
    if (m && m[1]) out.add(m[1]);
  }
  return Array.from(out);
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "launch:trace", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const admin = await requireAdmin(req);
    if (!admin.ok) return admin.res;

    const body = (await req.json().catch(() => ({}))) as any;
    const address = typeof body?.address === "string" ? body.address.trim() : "";
    const limitRaw = body?.limit != null ? Number(body.limit) : 20;
    const limit = Math.max(1, Math.min(50, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 20));

    if (!address) return NextResponse.json({ error: "address is required" }, { status: 400 });

    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(address);
    } catch {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }

    const connection = getConnection();
    const pumpProgramId = getPumpProgramId().toBase58();

    const sigs = await withRetry(() => connection.getSignaturesForAddress(pubkey, { limit }, "confirmed"));

    const out: any[] = [];
    for (const s of sigs) {
      const signature = String(s.signature);
      const parsed = await withRetry(() =>
        connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 } as any)
      );

      const deltaLamports = parsed ? getAccountDeltaLamports(parsed, pubkey.toBase58()) : null;
      const pumpMints = parsed ? extractPumpMints(parsed, pumpProgramId) : [];
      const systemTransfers = parsed ? extractSystemTransfers(parsed) : [];
      const invokedPrograms = parsed ? extractInvokedPrograms(parsed) : [];
      const invokesPump = invokedPrograms.includes(pumpProgramId);
      const fee = parsed?.meta?.fee != null ? Number(parsed.meta.fee) : null;

      out.push({
        signature,
        slot: s.slot,
        blockTime: s.blockTime ?? null,
        err: s.err ?? null,
        fee,
        deltaLamports,
        pumpMints,
        systemTransfers,
        invokedPrograms,
        invokesPump,
      });
    }

    await auditLog("launch_trace", { address, limit, count: out.length });

    return NextResponse.json({ ok: true, address, limit, pumpProgramId, txs: out });
  } catch (e) {
    const msg = getSafeErrorMessage(e);
    await auditLog("launch_trace_error", { error: msg });
    return apiError(e, "launch/trace");
  }
}
