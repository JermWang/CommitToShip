import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { getChainUnixTime, getConnection } from "../../../lib/solana";
import { getClaimableCreatorFeeLamports } from "../../../lib/pumpfun";
import { checkRateLimit } from "../../../lib/rateLimit";
import { apiError } from "../../../lib/apiError";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "pumpfun:status", limit: 60, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const body = (await req.json().catch(() => null)) as any;
    const creatorPubkeyRaw = typeof body?.creatorPubkey === "string" ? body.creatorPubkey.trim() : "";

    if (!creatorPubkeyRaw) {
      return NextResponse.json({ error: "creatorPubkey is required" }, { status: 400 });
    }

    const creator = new PublicKey(creatorPubkeyRaw);

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);

    const status = await getClaimableCreatorFeeLamports({ connection, creator });

    return NextResponse.json({
      ok: true,
      nowUnix,
      creator: creator.toBase58(),
      creatorVault: status.creatorVault.toBase58(),
      vaultBalanceLamports: status.vaultBalanceLamports,
      rentExemptMinLamports: status.rentExemptMinLamports,
      claimableLamports: status.claimableLamports,
    });
  } catch (e) {
    return apiError(e, "pumpfun/status");
  }
}
