export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cheap liveness probe for the platform healthcheck (no DB / RPC calls, so a slow dependency never restarts the app). */
export function GET() {
  return Response.json({ status: "ok", uptime: Math.round(process.uptime()) }, { headers: { "cache-control": "no-store" } });
}
