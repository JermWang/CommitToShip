import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { getConnection, getMintAuthorityBase58, getTokenMetadataUpdateAuthorityBase58 } from "../../lib/solana";
import { getSafeErrorMessage } from "../../lib/safeError";

export const runtime = "nodejs";

function expectedDevVerifyMessage(input: { tokenMint: string; walletPubkey: string; timestampUnix: number }): string {
  return `Commit To Ship\nDev Verification\nMint: ${input.tokenMint}\nWallet: ${input.walletPubkey}\nTimestamp: ${input.timestampUnix}`;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as any;

    const tokenMint = typeof body?.tokenMint === "string" ? body.tokenMint.trim() : "";
    const walletPubkey = typeof body?.walletPubkey === "string" ? body.walletPubkey.trim() : "";
    const signatureB58 = typeof body?.signatureB58 === "string" ? body.signatureB58.trim() : "";
    const timestampUnix = Number(body?.timestampUnix);

    if (!tokenMint || !walletPubkey || !signatureB58) {
      return NextResponse.json({ error: "tokenMint, walletPubkey, signatureB58 are required" }, { status: 400 });
    }
    if (!Number.isFinite(timestampUnix) || timestampUnix <= 0) {
      return NextResponse.json({ error: "timestampUnix is required" }, { status: 400 });
    }

    const nowUnix = Math.floor(Date.now() / 1000);
    if (Math.abs(nowUnix - timestampUnix) > 5 * 60) {
      return NextResponse.json({ error: "Verification timestamp expired" }, { status: 400 });
    }

    const mintPk = new PublicKey(tokenMint);
    const walletPk = new PublicKey(walletPubkey);

    const message = expectedDevVerifyMessage({ tokenMint: mintPk.toBase58(), walletPubkey: walletPk.toBase58(), timestampUnix });

    const signature = bs58.decode(signatureB58);
    const okSig = nacl.sign.detached.verify(new TextEncoder().encode(message), signature, walletPk.toBytes());
    if (!okSig) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const connection = getConnection();

    const [mintAuthority, updateAuthority] = await Promise.all([
      getMintAuthorityBase58({ connection, mint: mintPk }),
      getTokenMetadataUpdateAuthorityBase58({ connection, mint: mintPk }),
    ]);

    const okAuthority = mintAuthority === walletPk.toBase58() || updateAuthority === walletPk.toBase58();
    if (!okAuthority) {
      return NextResponse.json(
        {
          error: "Wallet is not token authority",
          mintAuthority,
          updateAuthority,
        },
        { status: 403 }
      );
    }

    return NextResponse.json({
      ok: true,
      tokenMint: mintPk.toBase58(),
      walletPubkey: walletPk.toBase58(),
      mintAuthority,
      updateAuthority,
    });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
