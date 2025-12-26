import { NextResponse } from "next/server";

import { buildAdminSessionClearCookie, getAdminSessionWallet, deleteAdminSession, getAdminCookieName, verifyAdminOrigin } from "../../../lib/adminSession";
import { getSafeErrorMessage } from "../../../lib/safeError";

export const runtime = "nodejs";

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const parts = header.split(";");
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx < 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export async function POST(req: Request) {
  try {
    verifyAdminOrigin(req);

    const _wallet = await getAdminSessionWallet(req);

    const cookies = parseCookies(req.headers.get("cookie"));
    const sessionId = cookies[getAdminCookieName()];
    if (sessionId) {
      await deleteAdminSession(sessionId);
    }

    const res = NextResponse.json({ ok: true });
    res.headers.set("set-cookie", buildAdminSessionClearCookie());
    return res;
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
