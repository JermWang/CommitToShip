import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

import { isAdminRequestAsync } from "../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { getProjectProfile, upsertProjectProfile } from "../../../lib/projectProfilesStore";
import { getConnection, getMintAuthorityBase58, getTokenMetadataUpdateAuthorityBase58 } from "../../../lib/solana";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { getAllowedCreatorWallets } from "../../../lib/creatorAuth";

export const runtime = "nodejs";

function isPublicLaunchEnabled(): boolean {
  const raw = String(process.env.CTS_PUBLIC_LAUNCHES ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export async function GET(_req: Request, ctx: { params: { mint: string } }) {
  try {
    const mintRaw = String(ctx?.params?.mint ?? "").trim();
    if (!mintRaw) return NextResponse.json({ error: "mint is required" }, { status: 400 });

    const mint = new PublicKey(mintRaw).toBase58();
    const project = await getProjectProfile(mint);
    return NextResponse.json({ project });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}

function normalizeHttpUrl(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) throw new Error("url must be http(s)");
  return s;
}

export async function POST(req: Request, ctx: { params: { mint: string } }) {
  try {
    const isAdmin = await isAdminRequestAsync(req);
    if (isAdmin) {
      verifyAdminOrigin(req);
    }

    const mintRaw = String(ctx?.params?.mint ?? "").trim();
    if (!mintRaw) return NextResponse.json({ error: "mint is required" }, { status: 400 });
    const mint = new PublicKey(mintRaw).toBase58();

    const body = (await req.json().catch(() => null)) as any;

    if (!isAdmin) {
      const devVerify = body?.devVerify as any;
      const devWalletPubkey = typeof devVerify?.walletPubkey === "string" ? devVerify.walletPubkey.trim() : "";
      const signatureB58 = typeof devVerify?.signatureB58 === "string" ? devVerify.signatureB58.trim() : "";
      const timestampUnix = Number(devVerify?.timestampUnix);
      if (!devWalletPubkey || !signatureB58 || !Number.isFinite(timestampUnix) || timestampUnix <= 0) {
        return NextResponse.json({ error: "devVerify (walletPubkey, signatureB58, timestampUnix) is required" }, { status: 400 });
      }

      const devWallet = new PublicKey(devWalletPubkey);

      if (!isPublicLaunchEnabled()) {
        const allowed = getAllowedCreatorWallets();
        if (!allowed.has(devWallet.toBase58())) {
          return NextResponse.json(
            {
              error: "Wallet is not approved for closed beta",
              hint: "Ask to be added to CTS_CREATOR_WALLET_PUBKEYS.",
            },
            { status: 403 }
          );
        }
      }
      const nowUnix = Math.floor(Date.now() / 1000);
      if (Math.abs(nowUnix - timestampUnix) > 5 * 60) {
        return NextResponse.json({ error: "Verification timestamp expired" }, { status: 400 });
      }

      const message = `Commit To Ship\nDev Verification\nMint: ${mint}\nWallet: ${devWallet.toBase58()}\nTimestamp: ${timestampUnix}`;
      const signature = bs58.decode(signatureB58);
      const okSig = nacl.sign.detached.verify(new TextEncoder().encode(message), signature, devWallet.toBytes());
      if (!okSig) {
        return NextResponse.json({ error: "Invalid dev verification signature" }, { status: 401 });
      }

      const connection = getConnection();
      const [mintAuthority, updateAuthority] = await Promise.all([
        getMintAuthorityBase58({ connection, mint: new PublicKey(mint) }),
        getTokenMetadataUpdateAuthorityBase58({ connection, mint: new PublicKey(mint) }),
      ]);

      const okAuthority = mintAuthority === devWallet.toBase58() || updateAuthority === devWallet.toBase58();
      if (!okAuthority) {
        return NextResponse.json({ error: "Wallet is not token authority", mintAuthority, updateAuthority }, { status: 403 });
      }
    }

    const name = body?.name == null ? null : String(body.name).trim();
    const symbol = body?.symbol == null ? null : String(body.symbol).trim();
    const description = body?.description == null ? null : String(body.description);

    let websiteUrl: string | null = null;
    let xUrl: string | null = null;
    let telegramUrl: string | null = null;
    let discordUrl: string | null = null;
    let imageUrl: string | null = null;
    let bannerUrl: string | null = null;
    let metadataUri: string | null = null;

    try {
      websiteUrl = normalizeHttpUrl(body?.websiteUrl);
      xUrl = normalizeHttpUrl(body?.xUrl);
      telegramUrl = normalizeHttpUrl(body?.telegramUrl);
      discordUrl = normalizeHttpUrl(body?.discordUrl);
      imageUrl = normalizeHttpUrl(body?.imageUrl);
      bannerUrl = normalizeHttpUrl(body?.bannerUrl);
      metadataUri = normalizeHttpUrl(body?.metadataUri);
    } catch (e) {
      return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 400 });
    }

    if (name != null && name.length > 48) {
      return NextResponse.json({ error: "name too long (max 48)" }, { status: 400 });
    }
    if (symbol != null && symbol.length > 16) {
      return NextResponse.json({ error: "symbol too long (max 16)" }, { status: 400 });
    }
    if (description != null && description.length > 600) {
      return NextResponse.json({ error: "description too long (max 600)" }, { status: 400 });
    }

    const project = await upsertProjectProfile({
      tokenMint: mint,
      name,
      symbol,
      description,
      websiteUrl,
      xUrl,
      telegramUrl,
      discordUrl,
      imageUrl,
      bannerUrl,
      metadataUri,
    });

    return NextResponse.json({ ok: true, project });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
