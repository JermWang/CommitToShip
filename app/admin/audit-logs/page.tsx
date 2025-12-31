"use client";

import { useEffect, useMemo, useState } from "react";
import { useToast } from "@/app/components/ToastProvider";

type Row = {
  id: number;
  tsUnix: number;
  event: string;
  fields: any;
};

async function readJsonSafe(res: Response): Promise<any> {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function unixToLocal(tsUnix: number): string {
  const n = Number(tsUnix);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toLocaleString();
}

export default function AuditLogsPage() {
  const toast = useToast();

  const [eventPrefix, setEventPrefix] = useState<string>("admin_");
  const [q, setQ] = useState<string>("");
  const [limit, setLimit] = useState<string>("200");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);

  const newestUnix = useMemo(() => {
    if (!rows.length) return null;
    return rows[0].tsUnix;
  }, [rows]);

  const oldestUnix = useMemo(() => {
    if (!rows.length) return null;
    return rows[rows.length - 1].tsUnix;
  }, [rows]);

  async function load(opts?: { beforeUnix?: number | null }) {
    setError(null);
    setLoading(true);
    try {
      const sp = new URLSearchParams();
      sp.set("limit", String(limit || "200"));
      if (eventPrefix.trim()) sp.set("eventPrefix", eventPrefix.trim());
      if (q.trim()) sp.set("q", q.trim());
      if (opts?.beforeUnix != null) sp.set("beforeUnix", String(opts.beforeUnix));

      const res = await fetch(`/api/admin/audit-logs?${sp.toString()}`, {
        cache: "no-store",
        credentials: "include",
      });
      const json = await readJsonSafe(res);
      if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);

      const next: Row[] = Array.isArray(json?.rows) ? json.rows : [];
      setRows(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(() => null);
  }, []);

  async function copy(text: string) {
    try {
      if (!window.isSecureContext || !navigator.clipboard?.writeText) throw new Error("Clipboard not available");
      await navigator.clipboard.writeText(text);
      toast({ kind: "success", message: "Copied" });
    } catch (e) {
      toast({ kind: "error", message: (e as Error).message });
    }
  }

  return (
    <main className="utilityPage">
      <div className="utilityWrap">
        <div className="utilityHeader">
          <div className="utilityHeaderTop">
            <div className="utilityHeaderLeft">
              <div className="utilityBreadcrumb">
                <a href="/" className="utilityBreadcrumbLink">Home</a>
                <span className="utilityBreadcrumbSep">/</span>
                <a href="/admin" className="utilityBreadcrumbLink">Admin</a>
                <span className="utilityBreadcrumbSep">/</span>
                <span>Audit Logs</span>
              </div>
              <h1 className="utilityTitle">Audit Logs</h1>
              <p className="utilityLead">
                Monitor platform activity and track admin actions for security and compliance.
              </p>
            </div>
          </div>
        </div>

        <div className="utilityCard">
          <div className="utilityCardHeader">
            <h2 className="utilityCardTitle">Search & Filter</h2>
            <p className="utilityCardSub">Filter logs by event type, search terms, or time range.</p>
          </div>
          <div className="utilityCardBody">
            <div className="utilityGrid utilityGrid3">
              <div className="utilityField">
                <label className="utilityLabel">Event Prefix</label>
                <input
                  className="utilityInput"
                  value={eventPrefix}
                  onChange={(e) => setEventPrefix(e.target.value)}
                  placeholder="e.g. admin_ or *_error"
                />
              </div>
              <div className="utilityField">
                <label className="utilityLabel">Search</label>
                <input
                  className="utilityInput"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search event or fields"
                />
              </div>
              <div className="utilityField">
                <label className="utilityLabel">Limit</label>
                <input
                  className="utilityInput"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  placeholder="200"
                  style={{ maxWidth: 120 }}
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
              <button className="utilityBtn utilityBtnPrimary" onClick={() => load().catch(() => null)} disabled={loading}>
                {loading ? "Loading..." : "Search"}
              </button>
              <button
                className="utilityBtn"
                onClick={() => load({ beforeUnix: oldestUnix }).catch(() => null)}
                disabled={loading || !oldestUnix}
              >
                Load Older
              </button>
            </div>
          </div>
        </div>

        {error ? (
          <div className="utilityAlert utilityAlertError" style={{ marginTop: 24 }}>
            {error}
          </div>
        ) : null}

        <div className="utilityStats" style={{ marginTop: 24 }}>
          <div className="utilityStat">
            <div className="utilityStatLabel">Results</div>
            <div className="utilityStatValue">{rows.length}</div>
          </div>
          <div className="utilityStat">
            <div className="utilityStatLabel">Newest</div>
            <div className="utilityStatValue" style={{ fontSize: 14 }}>{newestUnix ? unixToLocal(newestUnix) : "—"}</div>
          </div>
          <div className="utilityStat">
            <div className="utilityStatLabel">Oldest</div>
            <div className="utilityStatValue" style={{ fontSize: 14 }}>{oldestUnix ? unixToLocal(oldestUnix) : "—"}</div>
          </div>
        </div>

        <div className="utilitySection" style={{ marginTop: 24 }}>
          <h3 className="utilitySectionTitle">Event Log</h3>
          
          {loading ? (
            <div className="utilityList">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="utilityListItem" aria-hidden="true">
                  <div className="utilityListItemContent">
                    <div className="skeleton skeletonLine" style={{ width: 200, marginBottom: 8 }} />
                    <div className="skeleton skeletonLineSm" style={{ width: 300 }} />
                  </div>
                  <div className="skeleton skeletonLineSm" style={{ width: 80 }} />
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="utilityEmpty">
              <div className="utilityEmptyTitle">No logs found</div>
              <div className="utilityEmptyText">Try adjusting your search filters or time range.</div>
            </div>
          ) : (
            <div className="utilityList">
              {rows.map((r) => {
                const json = JSON.stringify(r.fields ?? {}, null, 2);
                return (
                  <div key={r.id} className="utilityListItem" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                      <div>
                        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                          <span className="utilityStatus utilityStatusDefault">{unixToLocal(r.tsUnix)}</span>
                          <span className="utilityStatus utilityStatusActive">ID: {r.id}</span>
                        </div>
                        <div className="utilityListItemTitle" style={{ fontSize: 15 }}>{r.event}</div>
                      </div>
                      <button className="utilityBtn utilityBtnSmall" type="button" onClick={() => copy(json)}>
                        Copy
                      </button>
                    </div>
                    <pre className="utilityMono" style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.5, padding: "12px 14px", background: "rgba(0,0,0,0.3)", borderRadius: 8 }}>
                      {json}
                    </pre>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
