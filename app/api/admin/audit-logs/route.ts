import { NextResponse } from "next/server";

import { isAdminRequestAsync } from "../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { getPool, hasDatabase } from "../../../lib/db";
import { apiError } from "../../../lib/apiError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let ensuredAuditSchema: Promise<void> | null = null;

/** Same DDL as lib/auditLog.ts (idempotent): the table only exists after the first audit write otherwise. */
function ensureAuditLogsTable(): Promise<void> {
  if (ensuredAuditSchema) return ensuredAuditSchema;
  ensuredAuditSchema = getPool()
    .query(
      `create table if not exists public.audit_logs (
        id bigserial primary key,
        ts_unix bigint not null,
        event text not null,
        fields jsonb not null default '{}'::jsonb
      );
      create index if not exists audit_logs_ts_idx on public.audit_logs(ts_unix);
      create index if not exists audit_logs_event_idx on public.audit_logs(event);`
    )
    .then(() => undefined)
    .catch((e) => {
      ensuredAuditSchema = null;
      throw e;
    });
  return ensuredAuditSchema;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export async function GET(req: Request) {
  try {
    verifyAdminOrigin(req);
    if (!(await isAdminRequestAsync(req))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!hasDatabase()) {
      return NextResponse.json({ error: "Database not configured" }, { status: 500 });
    }

    const url = new URL(req.url);
    const limit = clampInt(Number(url.searchParams.get("limit") ?? "200"), 1, 500);

    const eventPrefix = String(url.searchParams.get("eventPrefix") ?? "").trim();
    const q = String(url.searchParams.get("q") ?? "").trim();
    const beforeUnixRaw = url.searchParams.get("beforeUnix");
    const beforeUnix = beforeUnixRaw != null && beforeUnixRaw.trim().length ? Number(beforeUnixRaw) : null;

    const where: string[] = [];
    const params: any[] = [];

    if (eventPrefix) {
      params.push(`${eventPrefix}%`);
      where.push(`event like $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      where.push(`(event ilike $${params.length} or fields::text ilike $${params.length})`);
    }

    if (beforeUnix != null && Number.isFinite(beforeUnix)) {
      params.push(String(Math.floor(beforeUnix)));
      where.push(`ts_unix < $${params.length}`);
    }

    await ensureAuditLogsTable();
    const pool = getPool();
    const sql = `
      select id, ts_unix, event, fields
      from public.audit_logs
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by ts_unix desc, id desc
      limit ${limit}
    `;

    const res = await pool.query(sql, params);

    return NextResponse.json({
      ok: true,
      rows: res.rows.map((r) => ({
        id: Number(r.id),
        tsUnix: Number(r.ts_unix),
        event: String(r.event ?? ""),
        fields: r.fields ?? {},
      })),
    });
  } catch (e) {
    return apiError(e, "admin/audit-logs");
  }
}
