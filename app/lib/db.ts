import { Pool } from "pg";

import { getSafeErrorMessage } from "./safeError";

let pool: Pool | null = null;

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool(): Pool {
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
    pool = new Pool({
      connectionString: raw,
      ssl: { rejectUnauthorized: false },
      max: 1,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
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
