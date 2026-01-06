import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { auditLog } from "../../../lib/auditLog";
import { checkRateLimit } from "../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { getConnection, getTokenBalanceForMint } from "../../../lib/solana";

export const runtime = "nodejs";

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }

  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "wallet:token-balances", limit: 30, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const body = (await req.json().catch(() => null)) as any;
    const walletPubkey = typeof body?.walletPubkey === "string" ? body.walletPubkey.trim() : "";
    const tokenMintsIn: unknown[] = Array.isArray(body?.tokenMints) ? body.tokenMints : [];

    if (!walletPubkey) return NextResponse.json({ error: "walletPubkey required" }, { status: 400 });

    let owner: PublicKey;
    try {
      owner = new PublicKey(walletPubkey);
    } catch {
      return NextResponse.json({ error: "Invalid walletPubkey" }, { status: 400 });
    }

    const tokenMints: string[] = Array.from(
      new Set(
        tokenMintsIn
          .map((s: unknown) => String(s ?? "").trim())
          .filter((s: string) => s.length > 0)
      )
    );

    if (tokenMints.length > 25) {
      return NextResponse.json({ error: "Too many tokenMints (max 25)" }, { status: 400 });
    }

    const connection = getConnection();

    const balances = await mapLimit(tokenMints, 4, async (mintStr) => {
      let mint: PublicKey;
      try {
        mint = new PublicKey(mintStr);
      } catch {
        return { mint: mintStr, error: "Invalid mint" };
      }

      try {
        const bal = await getTokenBalanceForMint({ connection, owner, mint });
        return {
          mint: mint.toBase58(),
          amountRaw: bal.amountRaw.toString(),
          decimals: bal.decimals,
          uiAmount: bal.uiAmount,
        };
      } catch (e) {
        return { mint: mint.toBase58(), error: (e as Error).message };
      }
    });

    await auditLog("wallet_token_balances_ok", { walletPubkey, mints: tokenMints.length });

    return NextResponse.json({ ok: true, walletPubkey, balances });
  } catch (e) {
    await auditLog("wallet_token_balances_error", { error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
