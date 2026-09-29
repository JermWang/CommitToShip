import crypto from "crypto";

/**
 * Shared-secret auth for scheduled jobs (the in-process scheduler and any external cron).
 * Send the secret in the `x-cron-secret` header. Compared in constant time.
 */
export function isCronAuthorized(req: Request): boolean {
  const secret = String(process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;

  const header = String(req.headers.get("x-cron-secret") ?? "").trim();
  if (!header) return false;

  const a = crypto.createHash("sha256").update(secret).digest();
  const b = crypto.createHash("sha256").update(header).digest();
  return crypto.timingSafeEqual(a, b);
}
