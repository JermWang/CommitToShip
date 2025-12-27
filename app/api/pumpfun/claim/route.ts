import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Buffer } from "buffer";

import { getConnection, getChainUnixTime } from "../../../lib/solana";
import { buildUnsignedClaimCreatorFeesTx } from "../../../lib/pumpfun";
import { getSafeErrorMessage } from "../../../lib/safeError";

export const runtime = "nodejs";

function expectedClaimMessage(input: { creatorPubkey: string; timestampUnix: number }): string {
  return `Commit To Ship\nPump.fun Claim\nCreator: ${input.creatorPubkey}\nTimestamp: ${input.timestampUnix}`;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as any;
    const creatorPubkeyRaw = typeof body?.creatorPubkey === "string" ? body.creatorPubkey.trim() : "";

    const timestampUnix = Number(body?.timestampUnix);
    const signatureB58 = typeof body?.signatureB58 === "string" ? body.signatureB58.trim() : "";

    if (!creatorPubkeyRaw) return NextResponse.json({ error: "creatorPubkey is required" }, { status: 400 });
    if (!Number.isFinite(timestampUnix) || timestampUnix <= 0) {
      return NextResponse.json({ error: "timestampUnix is required" }, { status: 400 });
    }
    if (!signatureB58) return NextResponse.json({ error: "signatureB58 is required" }, { status: 400 });

    const creator = new PublicKey(creatorPubkeyRaw);
    const creatorPubkey = creator.toBase58();

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);

    const skew = Math.abs(nowUnix - Math.floor(timestampUnix));
    if (skew > 10 * 60) {
      return NextResponse.json({ error: "timestampUnix is too far from current time" }, { status: 400 });
    }

    const msg = expectedClaimMessage({ creatorPubkey, timestampUnix: Math.floor(timestampUnix) });
    const signature = bs58.decode(signatureB58);
    const ok = nacl.sign.detached.verify(new TextEncoder().encode(msg), signature, creator.toBytes());
    if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

    const built = await buildUnsignedClaimCreatorFeesTx({ connection, creator });
    if (built.claimableLamports <= 0) {
      return NextResponse.json({
        error: "No claimable creator fees",
        nowUnix,
        creator: creatorPubkey,
        creatorVault: built.creatorVault.toBase58(),
        claimableLamports: built.claimableLamports,
      }, { status: 409 });
    }

    const txBytes = built.tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const txBase64 = Buffer.from(txBytes).toString("base64");

    const explorerUrl = `https://solscan.io/tx/${encodeURIComponent("__pending__")}`;

    return NextResponse.json({
      ok: true,
      nowUnix,
      creator: creatorPubkey,
      creatorVault: built.creatorVault.toBase58(),
      claimableLamports: built.claimableLamports,
      rentExemptMinLamports: built.rentExemptMinLamports,
      vaultBalanceLamports: built.vaultBalanceLamports,
      txBase64,
      txFormat: "base64",
      txType: "pumpfun_collect_creator_fee",
      feePayer: creatorPubkey,
      explorerUrl,
      message: msg,
    });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
