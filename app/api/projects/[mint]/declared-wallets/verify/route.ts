import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { isAdminRequestAsync } from "../../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../../lib/adminSession";
import { getAllowedCreatorWallets } from "../../../../../lib/creatorAuth";
import {
  buildDeclaredWalletMessage,
  consumeDeclaredWalletNonce,
  tryInsertDeclaredWallet,
} from "../../../../../lib/transparentBundlerStore";
import { getConnection, getMintAuthorityBase58, getTokenMetadataUpdateAuthorityBase58 } from "../../../../../lib/solana";
import { checkRateLimit } from "../../../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../../../lib/safeError";

export const runtime = "nodejs";

function isPublicLaunchEnabled(): boolean {
  // Public launches enabled by default (closed beta ended)
  const raw = String(process.env.CTS_PUBLIC_LAUNCHES ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

function expectedDevVerifyMessage(input: { tokenMint: string; walletPubkey: string; timestampUnix: number }): string {
  return `Commit To Ship\nDev Verification\nMint: ${input.tokenMint}\nWallet: ${input.walletPubkey}\nTimestamp: ${input.timestampUnix}`;
}

function nonceTtlSeconds(): number {
  const raw = Number(process.env.CTS_TB_NONCE_TTL_SECONDS ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 15 * 60;
}

async function requireProjectAuthority(req: Request, mint: string, body: any): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  const isAdmin = await isAdminRequestAsync(req);
  if (isAdmin) {
    verifyAdminOrigin(req);
    return { ok: true };
  }

  const devVerify = body?.devVerify as any;
  const walletPubkey = typeof devVerify?.walletPubkey === "string" ? devVerify.walletPubkey.trim() : "";
  const signatureB58 = typeof devVerify?.signatureB58 === "string" ? devVerify.signatureB58.trim() : "";
  const timestampUnix = Number(devVerify?.timestampUnix);

  if (!walletPubkey || !signatureB58 || !Number.isFinite(timestampUnix) || timestampUnix <= 0) {
    return { ok: false, res: NextResponse.json({ error: "devVerify (walletPubkey, signatureB58, timestampUnix) is required" }, { status: 400 }) };
  }

  const devWallet = new PublicKey(walletPubkey);

  if (!isPublicLaunchEnabled()) {
    const allowed = getAllowedCreatorWallets();
    if (!allowed.has(devWallet.toBase58())) {
      return {
        ok: false,
        res: NextResponse.json(
          { error: "Wallet is not approved for closed beta", hint: "Ask to be added to CTS_CREATOR_WALLET_PUBKEYS." },
          { status: 403 }
        ),
      };
    }
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  if (Math.abs(nowUnix - timestampUnix) > 5 * 60) {
    return { ok: false, res: NextResponse.json({ error: "Verification timestamp expired" }, { status: 400 }) };
  }

  const message = expectedDevVerifyMessage({ tokenMint: mint, walletPubkey: devWallet.toBase58(), timestampUnix });
  const signature = bs58.decode(signatureB58);
  const okSig = nacl.sign.detached.verify(new TextEncoder().encode(message), signature, devWallet.toBytes());
  if (!okSig) {
    return { ok: false, res: NextResponse.json({ error: "Invalid dev verification signature" }, { status: 401 }) };
  }

  const connection = getConnection();
  const [mintAuthority, updateAuthority] = await Promise.all([
    getMintAuthorityBase58({ connection, mint: new PublicKey(mint) }),
    getTokenMetadataUpdateAuthorityBase58({ connection, mint: new PublicKey(mint) }),
  ]);

  const okAuthority = mintAuthority === devWallet.toBase58() || updateAuthority === devWallet.toBase58();
  if (!okAuthority) {
    return { ok: false, res: NextResponse.json({ error: "Wallet is not token authority", mintAuthority, updateAuthority }, { status: 403 }) };
  }

  return { ok: true };
}

export async function POST(req: Request, ctx: { params: { mint: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "tb:declared-wallet:verify", limit: 25, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const mintRaw = String(ctx?.params?.mint ?? "").trim();
    if (!mintRaw) return NextResponse.json({ error: "mint is required" }, { status: 400 });
    const mint = new PublicKey(mintRaw).toBase58();

    const body = (await req.json().catch(() => null)) as any;

    const auth = await requireProjectAuthority(req, mint, body);
    if (!auth.ok) return auth.res;

    const walletPubkeyRaw = typeof body?.walletPubkey === "string" ? body.walletPubkey.trim() : "";
    const nonce = typeof body?.nonce === "string" ? body.nonce.trim() : "";
    const signatureB58 = typeof body?.signature === "string" ? body.signature.trim() : "";

    if (!walletPubkeyRaw || !nonce || !signatureB58) {
      return NextResponse.json({ error: "walletPubkey, nonce, signature are required" }, { status: 400 });
    }

    const walletPubkey = new PublicKey(walletPubkeyRaw).toBase58();

    const consumed = await consumeDeclaredWalletNonce({ tokenMint: mint, walletPubkey, nonce, maxAgeSeconds: nonceTtlSeconds() });
    if (!consumed.ok) {
      return NextResponse.json({ error: consumed.reason }, { status: 400 });
    }

    const issuedAtUnix = consumed.issuedAtUnix;
    const expectedMessage = buildDeclaredWalletMessage({ tokenMint: mint, walletPubkey, nonce, issuedAtUnix });

    const providedMessage = typeof body?.message === "string" ? body.message : expectedMessage;
    if (providedMessage !== expectedMessage) {
      return NextResponse.json({ error: "Invalid message" }, { status: 400 });
    }

    const signature = bs58.decode(signatureB58);
    const walletPk = new PublicKey(walletPubkey);
    const okSig = nacl.sign.detached.verify(new TextEncoder().encode(expectedMessage), signature, walletPk.toBytes());
    if (!okSig) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const label = body?.label == null ? null : String(body.label).trim();

    const inserted = await tryInsertDeclaredWallet({
      tokenMint: mint,
      walletPubkey,
      label,
      message: expectedMessage,
      signature: signatureB58,
    });

    return NextResponse.json({ ok: true, inserted: inserted.inserted, record: inserted.inserted ? inserted.record : inserted.existing });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
