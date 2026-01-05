import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { checkRateLimit } from "../../../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../../../lib/safeError";
import { getChainUnixTime, getConnection } from "../../../../../lib/solana";
import { getCommitment } from "../../../../../lib/escrowStore";
import { sweepManagedCreatorFeesToEscrow } from "../../../../../lib/escrowSweep";
import { getAllowedCreatorWallets } from "../../../../../lib/creatorAuth";

export const runtime = "nodejs";

function isPublicLaunchEnabled(): boolean {
  const raw = String(process.env.CTS_PUBLIC_LAUNCHES ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function expectedSweepMessage(input: { commitmentId: string; timestampUnix: number }): string {
  return `Commit To Ship\nEscrow Sweep\nCommitment: ${input.commitmentId}\nTimestamp: ${input.timestampUnix}`;
}

export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const commitmentId = String(ctx.params.id ?? "").trim();
    if (!commitmentId) return NextResponse.json({ error: "Missing commitment id" }, { status: 400 });

    const rl = await checkRateLimit(req, { keyPrefix: `escrow:sweep:creator:${commitmentId}`, limit: 3, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const record = await getCommitment(commitmentId);
    if (!record || record.status === "archived") return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (record.kind !== "creator_reward") return NextResponse.json({ error: "Not a creator reward commitment" }, { status: 400 });
    if (record.creatorFeeMode !== "managed") {
      return NextResponse.json({ error: "Commitment is not in managed mode" }, { status: 409 });
    }

    const creatorPubkeyRaw = String(record.creatorPubkey ?? "").trim();
    if (!creatorPubkeyRaw) return NextResponse.json({ error: "Missing creator pubkey" }, { status: 500 });

    const body = (await req.json().catch(() => null)) as any;
    const timestampUnix = Number(body?.timestampUnix);
    const signatureB58 = typeof body?.signatureB58 === "string" ? body.signatureB58.trim() : "";

    if (!Number.isFinite(timestampUnix) || timestampUnix <= 0) {
      return NextResponse.json({ error: "timestampUnix is required" }, { status: 400 });
    }
    if (!signatureB58) return NextResponse.json({ error: "signatureB58 is required" }, { status: 400 });

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);

    const skew = Math.abs(nowUnix - Math.floor(timestampUnix));
    if (skew > 10 * 60) {
      return NextResponse.json({ error: "timestampUnix is too far from current time" }, { status: 400 });
    }

    const creator = new PublicKey(creatorPubkeyRaw);
    const creatorPubkey = creator.toBase58();

    if (!isPublicLaunchEnabled()) {
      const allowed = getAllowedCreatorWallets();
      if (!allowed.has(creatorPubkey)) {
        return NextResponse.json(
          {
            error: "Wallet is not approved for closed beta",
            hint: "Ask to be added to CTS_CREATOR_WALLET_PUBKEYS.",
          },
          { status: 403 }
        );
      }
    }

    const msg = expectedSweepMessage({ commitmentId, timestampUnix: Math.floor(timestampUnix) });
    let signature: Uint8Array;
    try {
      signature = bs58.decode(signatureB58);
    } catch {
      return NextResponse.json({ error: "Invalid signature encoding" }, { status: 400 });
    }
    const ok = nacl.sign.detached.verify(new TextEncoder().encode(msg), signature, creator.toBytes());
    if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    const result = await sweepManagedCreatorFeesToEscrow({ commitmentId, actor: { kind: "creator", walletPubkey: creatorPubkey } });
    if (!result?.ok) {
      const status = Number(result?.status ?? 400);
      return NextResponse.json(result?.error ? { ...result, error: String(result.error) } : { error: "Sweep failed" }, { status });
    }

    const signatureTx =
      (typeof result?.signature === "string" ? result.signature.trim() : "") ||
      (typeof result?.pumpportal?.signature === "string" ? result.pumpportal.signature.trim() : "") ||
      (typeof result?.pumpfun?.signature === "string" ? result.pumpfun.signature.trim() : "");
    const solscanUrl = signatureTx ? `https://solscan.io/tx/${encodeURIComponent(signatureTx)}` : null;

    return NextResponse.json({ ok: true, nowUnix, result, solscanUrl });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
