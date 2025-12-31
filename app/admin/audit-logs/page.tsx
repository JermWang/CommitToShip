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
    <main className="appShellBody" style={{ paddingTop: 28, paddingLeft: "var(--layout-gutter)", paddingRight: "var(--layout-gutter)" }}>
      <div>
        <div className="timelineHero" style={{ paddingBottom: 0 }}>
          <h1 className="timelineHeroTitle">Audit Logs</h1>
          <p className="timelineHeroLead">Admin-only event stream for monitoring and incident response.</p>
        </div>

        <div className="timelineControls" style={{ marginTop: 18 }}>
          <div className="timelineToolRow" style={{ alignItems: "center" }}>
            <input
              className="timelineSearch"
              value={eventPrefix}
              onChange={(e) => setEventPrefix(e.target.value)}
              placeholder="event prefix (e.g. admin_ or *_error)"
            />
            <input className="timelineSearch" value={q} onChange={(e) => setQ(e.target.value)} placeholder="search (event or fields)" />
            <input
              className="timelineSearch"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="limit"
              style={{ maxWidth: 120 }}
            />
            <button className="timelineRefresh" onClick={() => load().catch(() => null)} disabled={loading}>
              {loading ? "Loading..." : "Refresh"}
            </button>
            <button
              className="timelineRefresh"
              onClick={() => load({ beforeUnix: oldestUnix }).catch(() => null)}
              disabled={loading || !oldestUnix}
              title="Load older"
            >
              Older
            </button>
          </div>
        </div>

        {error ? <div className="timelineError" style={{ marginTop: 14 }}>{error}</div> : null}

        <div style={{ marginTop: 14, color: "rgba(255,255,255,0.62)", fontSize: 12 }}>
          <div>Newest: {newestUnix ? unixToLocal(newestUnix) : "—"}</div>
          <div>Oldest: {oldestUnix ? unixToLocal(oldestUnix) : "—"}</div>
        </div>

        <div className="timelineRail" style={{ marginTop: 18 }}>
          {loading ? (
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="timelineReceipt" aria-hidden="true">
                <div className="timelineReceiptTop">
                  <div className="timelineReceiptLeft">
                    <div className="timelineActor">
                      <div className="skeleton skeletonAvatar" />
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginLeft: 10 }}>
                        <div className="skeleton skeletonLineSm" style={{ width: 180 }} />
                        <div className="skeleton skeletonLineSm" style={{ width: 260 }} />
                      </div>
                    </div>
                  </div>
                  <div className="timelineReceiptRight">
                    <div className="skeleton skeletonLineSm" style={{ width: 110 }} />
                  </div>
                </div>
              </div>
            ))
          ) : rows.length === 0 ? (
            <div className="timelineEmpty">No logs found for this filter.</div>
          ) : (
            rows.map((r) => {
              const json = JSON.stringify(r.fields ?? {}, null, 2);
              return (
                <div key={r.id} className="timelineReceipt timelineReceiptOpen">
                  <div className="timelineReceiptTop">
                    <div className="timelineReceiptLeft">
                      <div className="timelineReceiptKicker">
                        <span className="timelineChip timelineChipType">{unixToLocal(r.tsUnix)}</span>
                        <span className="timelineChip timelineChipStatus">id={r.id}</span>
                      </div>
                      <div className="timelineReceiptTitle">{r.event}</div>
                      <pre
                        style={{
                          margin: "10px 0 0 0",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          color: "rgba(255,255,255,0.80)",
                          fontSize: 12,
                          lineHeight: 1.4,
                        }}
                      >
                        {json}
                      </pre>
                    </div>
                    <div className="timelineReceiptRight">
                      <button className="timelineRefresh" type="button" onClick={() => copy(json)}>
                        Copy
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </main>
  );
}
