import { Pool } from "pg";

import { getSafeErrorMessage } from "./safeError";

let pool: Pool | null = null;

function intEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return fallback;
}

function resolveSsl(connectionString: string): false | { rejectUnauthorized: false } {
  const override = String(process.env.PG_SSL ?? "").trim().toLowerCase();
  if (override === "0" || override === "false" || override === "off" || override === "disable") return false;
  if (override === "1" || override === "true" || override === "on" || override === "require") return { rejectUnauthorized: false };

  try {
    const url = new URL(connectionString);
    const sslmode = String(url.searchParams.get("sslmode") ?? "").toLowerCase();
    if (sslmode === "disable") return false;

    // Private/local hosts (Railway private network, docker, localhost) don't need TLS.
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".internal")) return false;
  } catch {
    // fall through to TLS
  }

  return { rejectUnauthorized: false };
}

function isMockMode(): boolean {
  const raw = String(process.env.CTS_MOCK_MODE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function enforceProductionDbGuards(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (isMockMode()) {
    throw new Error("CTS_MOCK_MODE is not allowed in production");
  }
  if (!String(process.env.DATABASE_URL ?? "").trim()) {
    throw new Error("DATABASE_URL is required in production");
  }
}

export function hasDatabase(): boolean {
  enforceProductionDbGuards();
  return Boolean(process.env.DATABASE_URL) && !isMockMode();
}

export function getPool(): Pool {
  enforceProductionDbGuards();
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const raw0 = String(process.env.DATABASE_URL).trim();
  const unquoted =
    raw0.length >= 2 &&
    ((raw0.startsWith('"') && raw0.endsWith('"')) || (raw0.startsWith("'") && raw0.endsWith("'")))
      ? raw0.slice(1, -1)
      : raw0;
  let raw = unquoted.trim();

  // Normalize common copy/paste mistakes (missing `//` after scheme).
  if (raw.startsWith("postgresql:") && !raw.startsWith("postgresql://")) {
    raw = `postgresql://${raw.slice("postgresql:".length)}`;
  }
  if (raw.startsWith("postgres:") && !raw.startsWith("postgres://")) {
    raw = `postgres://${raw.slice("postgres:".length)}`;
  }

  if (!raw || raw.startsWith("//") || (!raw.startsWith("postgres://") && !raw.startsWith("postgresql://"))) {
    console.error("Invalid DATABASE_URL format", {
      startsWith: raw.slice(0, 18),
      hasSchemeSlashes: raw.includes("://"),
    });
    throw new Error("Invalid DATABASE_URL");
  }

  if (!pool) {
    // Long-running Node server (Railway): a modest pool is plenty and keeps connection churn low.
    const defaultMax = process.env.NODE_ENV === "production" ? 10 : 5;
    const max = intEnv("PG_POOL_MAX", defaultMax);
    const connectionTimeoutMillis = intEnv("PG_POOL_CONNECTION_TIMEOUT_MS", 10_000);
    const idleTimeoutMillis = intEnv("PG_POOL_IDLE_TIMEOUT_MS", 30_000);

    pool = new Pool({
      connectionString: raw,
      ssl: resolveSsl(raw),
      max,
      connectionTimeoutMillis,
      idleTimeoutMillis,
      keepAlive: true,
    });

    pool.on("error", (e) => {
      const msg = getSafeErrorMessage(e);
      console.error("DB pool error", {
        code: (e as any)?.code,
        errno: (e as any)?.errno,
        syscall: (e as any)?.syscall,
      });
      console.error(msg);
    });
  }

  return pool;
}
