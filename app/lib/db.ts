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

  const raw = String(process.env.DATABASE_URL).trim();
  if (!raw || raw.startsWith("//") || (!raw.startsWith("postgres://") && !raw.startsWith("postgresql://"))) {
    throw new Error("Invalid DATABASE_URL");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: raw,
      ssl: { rejectUnauthorized: false },
    });

    pool.on("error", (e) => {
      const msg = getSafeErrorMessage(e);
      console.error(msg);
    });
  }

  return pool;
}
