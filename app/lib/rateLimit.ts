import { getPool, hasDatabase } from "./db";

type RateLimitConfig = {
  keyPrefix: string;
  limit: number;
  windowSeconds: number;
};

type RateLimitEntry = {
  count: number;
  resetAtUnix: number;
};

let ensuredSchema: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (!hasDatabase()) return;
  if (ensuredSchema) return ensuredSchema;

  ensuredSchema = (async () => {
    const pool = getPool();
    await pool.query(`
      create table if not exists public.rate_limits (
        key text not null,
        window_start_unix bigint not null,
        count integer not null,
        reset_at_unix bigint not null,
        updated_at_unix bigint not null,
        primary key (key, window_start_unix)
      );
      create index if not exists rate_limits_reset_idx on public.rate_limits(reset_at_unix);
    `);
  })().catch((e) => {
    ensuredSchema = null;
    throw e;
  });

  return ensuredSchema;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function getHeader(req: Request, name: string): string {
  return String(req.headers.get(name) ?? "").trim();
}

export function getClientIp(req: Request): string {
  // Behind a trusted proxy (Railway) the *rightmost* X-Forwarded-For entries are the ones the proxy appended;
  // anything to the left can be forged by the client. TRUSTED_PROXY_HOPS = number of proxies in front of us.
  const xff = getHeader(req, "x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const hops = Math.max(1, Math.floor(Number(process.env.TRUSTED_PROXY_HOPS ?? "1")) || 1);
    const ip = parts[Math.max(0, parts.length - hops)];
    if (ip) return ip;
  }

  const realIp = getHeader(req, "x-real-ip");
  if (realIp) return realIp;

  const cfIp = getHeader(req, "cf-connecting-ip");
  if (cfIp) return cfIp;

  const trueClientIp = getHeader(req, "true-client-ip");
  if (trueClientIp) return trueClientIp;

  const ua = getHeader(req, "user-agent");
  return ua ? `unknown:${ua.slice(0, 80)}` : "unknown";
}

/** Housekeeping: rate-limit windows are only useful while they are current. */
export async function pruneRateLimits(): Promise<number> {
  if (!hasDatabase()) return 0;
  await ensureSchema();
  const cutoff = nowUnix() - 3600;
  const res = await getPool().query("delete from public.rate_limits where reset_at_unix < $1", [String(cutoff)]);
  return res.rowCount ?? 0;
}

function getStore(): Map<string, RateLimitEntry> {
  const g = globalThis as any;
  if (!g.__cts_rate_limit_store) {
    g.__cts_rate_limit_store = new Map<string, RateLimitEntry>();
  }
  return g.__cts_rate_limit_store as Map<string, RateLimitEntry>;
}

export async function checkRateLimit(
  req: Request,
  cfg: RateLimitConfig
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const ip = getClientIp(req);
  const key = `${cfg.keyPrefix}:${ip}`;

  const t = nowUnix();
  const windowSeconds = Math.max(1, cfg.windowSeconds);

  if (hasDatabase()) {
    try {
      await ensureSchema();
      const windowStartUnix = Math.floor(t / windowSeconds) * windowSeconds;
      const resetAtUnix = windowStartUnix + windowSeconds;

      const pool = getPool();
      const { rows } = await pool.query(
        "insert into public.rate_limits (key, window_start_unix, count, reset_at_unix, updated_at_unix) values ($1, $2, 1, $3, $4) on conflict (key, window_start_unix) do update set count = public.rate_limits.count + 1, updated_at_unix = excluded.updated_at_unix returning count, reset_at_unix",
        [key, windowStartUnix, resetAtUnix, t]
      );

      const count = Number(rows?.[0]?.count ?? 0);
      const reset = Number(rows?.[0]?.reset_at_unix ?? resetAtUnix);

      if (count > cfg.limit) {
        return { allowed: false, retryAfterSeconds: Math.max(1, reset - t) };
      }

      return { allowed: true };
    } catch (e) {
      console.error("Rate limit DB error", e);
      if (process.env.NODE_ENV === "production") {
        return { allowed: false, retryAfterSeconds: 1 };
      }
    }
  }

  const store = getStore();

  const existing = store.get(key);
  if (!existing || existing.resetAtUnix <= t) {
    store.set(key, { count: 1, resetAtUnix: t + windowSeconds });
    return { allowed: true };
  }

  if (existing.count >= cfg.limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, existing.resetAtUnix - t) };
  }

  store.set(key, { ...existing, count: existing.count + 1 });
  return { allowed: true };
}
