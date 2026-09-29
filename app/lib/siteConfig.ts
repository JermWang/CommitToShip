/**
 * Central brand/site configuration. Everything brand-related that may change (name, domain, socials)
 * lives here or in NEXT_PUBLIC_* env vars, so a new domain or X handle never needs a code change.
 */
export const SITE_NAME = "Ship & Commit";

export const SITE_TAGLINE = "Accountability infrastructure & milestone escrow";

export const SITE_DESCRIPTION =
  "Lock your pump.fun creator fees in on-chain escrow. Set milestones; holders vote to approve releases. Miss a deadline? Fees get redistributed to voters and fuel $SHIP buybacks.";

/** Public X (Twitter) profile. Empty until NEXT_PUBLIC_X_URL is set; the X buttons are hidden while it is empty. */
export const X_URL = String(process.env.NEXT_PUBLIC_X_URL ?? "").trim();

/** Canonical origin used for absolute URLs in metadata (OG images etc.). */
export function getSiteOrigin(): string {
  const explicit = String(process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const appOrigin = String(process.env.APP_ORIGIN ?? "").split(",")[0]?.trim();
  if (appOrigin) return appOrigin.replace(/\/+$/, "");

  const railway = String(process.env.RAILWAY_PUBLIC_DOMAIN ?? "").trim();
  if (railway) return `https://${railway}`;

  return "http://localhost:3000";
}
