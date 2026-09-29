import { PublicKey } from "@solana/web3.js";

import { assetStorageMode, readOwnAssetByUrl } from "./assetStorage";

export const LAUNCH_NAME_MAX = 32;
export const LAUNCH_SYMBOL_MAX = 10;
export const LAUNCH_DESCRIPTION_MAX = 600;
export const LAUNCH_STATEMENT_MAX = 280;
const URL_MAX = 300;
const IMAGE_FETCH_MAX_BYTES = 15 * 1024 * 1024;

export type LaunchInput = {
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  bannerUrl: string;
  statement: string;
  payoutWallet: string;
  websiteUrl: string;
  xUrl: string;
  telegramUrl: string;
  discordUrl: string;
};

export class LaunchInputError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Optional link: must be a plain http(s) URL (blocks javascript:, data:, etc.). Returns "" when absent. */
export function cleanOptionalUrl(raw: unknown, label: string): string {
  const s = str(raw);
  if (!s) return "";
  if (s.length > URL_MAX) throw new LaunchInputError(`${label} is too long`);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new LaunchInputError(`${label} must be a valid http(s) link`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new LaunchInputError(`${label} must be a valid http(s) link`);
  return u.toString();
}

/** Validates everything the launch form sends. Throws LaunchInputError (400) with a user-friendly message. */
export function validateLaunchInput(body: any): LaunchInput {
  const name = str(body?.name);
  const symbol = str(body?.symbol).replace(/^\$+/, "").trim();
  const description = str(body?.description);
  const imageUrl = str(body?.imageUrl);
  const statement = str(body?.statement);
  const payoutWallet = str(body?.payoutWallet);

  if (!name) throw new LaunchInputError("Token name is required");
  if (name.length > LAUNCH_NAME_MAX) throw new LaunchInputError(`Token name must be ${LAUNCH_NAME_MAX} characters or fewer`);
  if (/[\r\n]/.test(name)) throw new LaunchInputError("Token name must be a single line");

  if (!symbol) throw new LaunchInputError("Token symbol is required");
  if (symbol.length > LAUNCH_SYMBOL_MAX) throw new LaunchInputError(`Ticker must be ${LAUNCH_SYMBOL_MAX} characters or fewer`);
  if (/[\s\r\n]/.test(symbol)) throw new LaunchInputError("Ticker cannot contain spaces");

  if (description.length > LAUNCH_DESCRIPTION_MAX) throw new LaunchInputError(`Description must be ${LAUNCH_DESCRIPTION_MAX} characters or fewer`);
  if (statement.length > LAUNCH_STATEMENT_MAX) throw new LaunchInputError(`Commitment statement must be ${LAUNCH_STATEMENT_MAX} characters or fewer`);

  if (!imageUrl) throw new LaunchInputError("Token image is required");
  if (imageUrl.length > 600) throw new LaunchInputError("Token image link is invalid");

  if (!payoutWallet) throw new LaunchInputError("Payout wallet is required");
  try {
    new PublicKey(payoutWallet);
  } catch {
    throw new LaunchInputError("Payout wallet is not a valid Solana address");
  }

  return {
    name,
    symbol,
    description,
    imageUrl,
    bannerUrl: str(body?.bannerUrl),
    statement,
    payoutWallet,
    websiteUrl: cleanOptionalUrl(body?.websiteUrl, "Website"),
    xUrl: cleanOptionalUrl(body?.xUrl, "X link"),
    telegramUrl: cleanOptionalUrl(body?.telegramUrl, "Telegram link"),
    discordUrl: cleanOptionalUrl(body?.discordUrl, "Discord link"),
  };
}

function supabasePublicPrefix(): string {
  const base = String(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  return base ? `${base}/storage/v1/object/public/` : "";
}

/** True when the URL points at storage this app controls (its own asset route, or its Supabase public bucket). */
export function isOwnAssetUrl(url: string): boolean {
  const s = String(url ?? "").trim();
  if (!s) return false;
  try {
    if (new URL(s, "http://internal.invalid").pathname.startsWith("/api/assets/")) return true;
  } catch {
    return false;
  }
  if (assetStorageMode() === "supabase") {
    const prefix = supabasePublicPrefix();
    return Boolean(prefix) && s.startsWith(prefix);
  }
  return false;
}

/**
 * Loads a launch image WITHOUT letting the client point the server at arbitrary URLs (SSRF):
 * only images stored in our own asset store are accepted.
 */
export async function loadLaunchImage(imageUrl: string): Promise<{ data: Buffer; contentType: string }> {
  if (!isOwnAssetUrl(imageUrl)) {
    throw new LaunchInputError("Token image must be uploaded through the launch form");
  }

  const own = await readOwnAssetByUrl(imageUrl);
  if (own) return own;

  if (assetStorageMode() === "supabase") {
    const res = await fetch(imageUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new LaunchInputError("Failed to load token image. Please re-upload it.");
    const contentType = String(res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) throw new LaunchInputError("Token image is not a valid image");
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > IMAGE_FETCH_MAX_BYTES) throw new LaunchInputError("Token image is too large (max 15MB)");
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > IMAGE_FETCH_MAX_BYTES) throw new LaunchInputError("Token image is too large (max 15MB)");
    return { data, contentType };
  }

  throw new LaunchInputError("Token image was not found. Please re-upload it.");
}
