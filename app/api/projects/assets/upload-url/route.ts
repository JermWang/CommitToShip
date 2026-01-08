import { NextResponse } from "next/server";
import crypto from "crypto";

import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { checkRateLimit } from "../../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../../lib/safeError";
import { getConnection, getMintAuthorityBase58, getTokenMetadataUpdateAuthorityBase58 } from "../../../../lib/solana";
import { getAllowedCreatorWallets } from "../../../../lib/creatorAuth";

export const runtime = "nodejs";

function isPublicLaunchEnabled(): boolean {
  // Public launches enabled by default (closed beta ended)
  const raw = String(process.env.CTS_PUBLIC_LAUNCHES ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

function requiredEnv(name: string): string {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function requiredEnvAny(names: string[]): string {
  for (const n of names) {
    const v = String(process.env[n] ?? "").trim();
    if (v) return v;
  }
  throw new Error(`${names[0]} is required`);
}

function baseSupabaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function supabaseStorageBaseUrl(): string {
  const supabaseUrl = baseSupabaseUrl(requiredEnvAny(["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]));
  return `${supabaseUrl}/storage/v1`;
}

function absolutizeStorageUrl(rawUrl: string, input: { supabaseUrl: string; storageBase: string }): string {
  const raw = String(rawUrl ?? "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;

  const p = raw.replace(/^\/+/, "");
  if (p.startsWith("storage/v1/")) return `${input.supabaseUrl}/${p}`;
  return `${input.storageBase}/${p}`;
}

function extFromContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("image/png")) return "png";
  if (ct.includes("image/jpeg") || ct.includes("image/jpg")) return "jpg";
  if (ct.includes("image/gif")) return "gif";
  if (ct.includes("image/webp")) return "webp";
  return "png";
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "project-assets:upload-url", limit: 30, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const body = (await req.json().catch(() => null)) as any;

    const tokenMintRaw = typeof body?.tokenMint === "string" ? body.tokenMint.trim() : "";
    if (!tokenMintRaw) return NextResponse.json({ error: "tokenMint is required" }, { status: 400 });
    const tokenMint = new PublicKey(tokenMintRaw).toBase58();

    const kindRaw = typeof body?.kind === "string" ? body.kind.trim().toLowerCase() : "";
    const kind: "icon" | "banner" = kindRaw === "banner" ? "banner" : "icon";

    const contentType = typeof body?.contentType === "string" ? body.contentType.trim() : "image/png";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return NextResponse.json({ error: "contentType must be an image" }, { status: 400 });
    }

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

    const message = `Commit To Ship\nDev Verification\nMint: ${tokenMint}\nWallet: ${devWallet.toBase58()}\nTimestamp: ${timestampUnix}`;
    const signature = bs58.decode(signatureB58);
    const okSig = nacl.sign.detached.verify(new TextEncoder().encode(message), signature, devWallet.toBytes());
    if (!okSig) {
      return NextResponse.json({ error: "Invalid dev verification signature" }, { status: 401 });
    }

    const connection = getConnection();
    const [mintAuthority, updateAuthority] = await Promise.all([
      getMintAuthorityBase58({ connection, mint: new PublicKey(tokenMint) }),
      getTokenMetadataUpdateAuthorityBase58({ connection, mint: new PublicKey(tokenMint) }),
    ]);

    const okAuthority = mintAuthority === devWallet.toBase58() || updateAuthority === devWallet.toBase58();
    if (!okAuthority) {
      return NextResponse.json({ error: "Wallet is not token authority", mintAuthority, updateAuthority }, { status: 403 });
    }

    const bucket = String(process.env.SUPABASE_PROJECT_ASSETS_BUCKET ?? "project-assets").trim() || "project-assets";
    const ext = extFromContentType(contentType);
    const id = crypto.randomBytes(12).toString("hex");
    const path = `${tokenMint}/${kind}/${id}.${ext}`;

    const supabaseUrl = baseSupabaseUrl(requiredEnvAny(["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]));
    const storageBase = supabaseStorageBaseUrl();
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

    const createUrl = `${storageBase}/object/upload/sign/${encodeURIComponent(bucket)}/${path}`;

    const expiresInSeconds = 2 * 60 * 60;

    const res = await fetch(createUrl, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
        "x-upsert": "true",
      },
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    });

    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      return NextResponse.json({ error: json?.message ?? json?.error ?? `Storage request failed (${res.status})` }, { status: 500 });
    }

    const signedUrl = absolutizeStorageUrl(String(json?.url ?? ""), { supabaseUrl, storageBase });
    const url = new URL(signedUrl);
    const token = url.searchParams.get("token") || "";
    if (!token) {
      return NextResponse.json({ error: "Storage did not return token" }, { status: 500 });
    }

    const publicUrl = `${storageBase}/object/public/${encodeURIComponent(bucket)}/${path}`;

    return NextResponse.json({
      ok: true,
      bucket,
      path,
      token,
      signedUrl,
      publicUrl,
      expiresInSeconds,
    });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
