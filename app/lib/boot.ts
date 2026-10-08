import { getPool, hasDatabase } from "./db";

/**
 * Background services for the long-running Node server (Railway).
 *
 * The platform's periodic jobs (market-cap milestone resolution, reward normalization, ASD, bundler snapshots)
 * run in-process: each job POSTs its own admin endpoint over loopback with CRON_SECRET, and a Postgres advisory
 * lock guarantees only one instance runs a given job at a time (safe during overlapping Railway deploys).
 */

type Job = {
  name: string;
  intervalMs: number;
  initialDelayMs: number;
  enabled: () => boolean;
  run: () => Promise<void>;
};

declare global {
  // eslint-disable-next-line no-var
  var __shipCommitBooted: boolean | undefined;
}

const running = new Set<string>();

function flag(name: string): boolean {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function log(...args: unknown[]) {
  console.log("[scheduler]", ...args);
}

/** Runs `fn` only if this process wins the cross-instance advisory lock for `name`. */
async function withJobLock(name: string, fn: () => Promise<void>): Promise<void> {
  if (running.has(name)) return;
  running.add(name);

  try {
    if (!hasDatabase()) {
      await fn();
      return;
    }

    const client = await getPool().connect();
    try {
      await client.query("begin");
      const { rows } = await client.query("select pg_try_advisory_xact_lock(hashtext($1)) as ok", [`shipcommit:job:${name}`]);
      if (!rows[0]?.ok) return; // another instance is running it
      await fn();
    } finally {
      await client.query("rollback").catch(() => null);
      client.release();
    }
  } catch (e) {
    console.error(`[scheduler] job "${name}" crashed:`, e instanceof Error ? e.message : e);
  } finally {
    running.delete(name);
  }
}

async function callAdminEndpoint(path: string, timeoutMs: number): Promise<void> {
  const port = String(process.env.PORT ?? "3000").trim() || "3000";
  const secret = String(process.env.CRON_SECRET ?? "").trim();

  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": secret },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    log(`${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
    return;
  }

  try {
    const json = JSON.parse(text);
    const failed = Array.isArray(json?.results) ? json.results.filter((r: any) => r && r.ok === false).length : 0;
    if (failed > 0) log(`${path} finished with ${failed} failed item(s)`);
  } catch {
    // non-JSON body is fine
  }
}

async function housekeeping(): Promise<void> {
  if (!hasDatabase()) return;

  const { pruneRateLimits } = await import("./rateLimit");
  const { pruneStaleStagingAssets } = await import("./assetStorage");

  const now = Math.floor(Date.now() / 1000);
  const pool = getPool();

  const tasks: Array<[string, () => Promise<unknown>]> = [
    ["rate_limits", () => pruneRateLimits()],
    ["staging_assets", () => pruneStaleStagingAssets()],
    ["admin_nonces", () => pool.query("delete from admin_nonces where created_at_unix < $1", [String(now - 3600)])],
    ["admin_sessions", () => pool.query("delete from admin_sessions where expires_at_unix < $1", [String(now)])],
    ["audit_logs", () => pool.query("delete from public.audit_logs where ts_unix < $1", [String(now - 120 * 24 * 3600)])],
    ["token_market_snapshots", () => pool.query("delete from token_market_snapshots where fetched_at_unix < $1", [String(now - 400 * 24 * 3600)])],
  ];

  for (const [label, fn] of tasks) {
    try {
      await fn();
    } catch (e) {
      // A table may simply not exist yet on a fresh database.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/does not exist/i.test(msg)) log(`housekeeping "${label}" failed: ${msg}`);
    }
  }
}

function buildJobs(): Job[] {
  const min = 60_000;
  return [
    {
      name: "resolve-marketcap-milestones",
      intervalMs: 1 * min,
      initialDelayMs: 45_000,
      enabled: () => flag("CTS_ENABLE_MARKETCAP_MILESTONES"),
      run: () => callAdminEndpoint("/api/admin/resolve-marketcap-milestones", 10 * min),
    },
    {
      name: "normalize-rewards",
      intervalMs: 10 * min,
      initialDelayMs: 2 * min,
      enabled: () => true,
      run: () => callAdminEndpoint("/api/admin/normalize-rewards", 10 * min),
    },
    {
      name: "asd-execute",
      intervalMs: 15 * min,
      initialDelayMs: 3 * min,
      enabled: () => flag("CTS_ASD_ENABLE_SWAPS"),
      run: () => callAdminEndpoint("/api/admin/asd-execute", 15 * min),
    },
    {
      name: "transparent-bundler-snapshot",
      intervalMs: 24 * 60 * min,
      initialDelayMs: 10 * min,
      enabled: () => true,
      run: () => callAdminEndpoint("/api/admin/transparent-bundler-snapshot", 15 * min),
    },
    {
      name: "housekeeping",
      intervalMs: 30 * min,
      initialDelayMs: 5 * min,
      enabled: () => true,
      run: housekeeping,
    },
  ];
}

export async function warmSchemas(): Promise<void> {
  if (!hasDatabase()) return;
  try {
    const { listCommitments } = await import("./escrowStore");
    await listCommitments();
    const { auditLog } = await import("./auditLog");
    await auditLog("server_boot", { pid: process.pid, node: process.version });
    log("database schema ready");
  } catch (e) {
    console.error("[boot] schema warm-up failed:", e instanceof Error ? e.message : e);
  }
}

export function startBackgroundServices(): void {
  if (globalThis.__shipCommitBooted) return;
  globalThis.__shipCommitBooted = true;

  if (process.env.NEXT_PHASE === "phase-production-build") return;

  void warmSchemas();

  const isProd = process.env.NODE_ENV === "production";
  if (!isProd && !flag("ENABLE_SCHEDULER")) return;
  if (flag("DISABLE_SCHEDULER")) {
    log("disabled via DISABLE_SCHEDULER");
    return;
  }

  if (!String(process.env.CRON_SECRET ?? "").trim()) {
    console.warn("[scheduler] CRON_SECRET is not set - background jobs are OFF (market-cap milestones, reward normalization, ASD).");
    return;
  }

  for (const job of buildJobs()) {
    if (!job.enabled()) continue;
    const tick = () => void withJobLock(job.name, job.run);
    const first = setTimeout(() => {
      tick();
      const t = setInterval(tick, job.intervalMs);
      t.unref?.();
    }, job.initialDelayMs);
    first.unref?.();
    log(`scheduled "${job.name}" every ${Math.round(job.intervalMs / 60000)}m`);
  }
}
