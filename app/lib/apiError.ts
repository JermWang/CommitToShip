import { NextResponse } from "next/server";

import { getSafeErrorMessage, redactSensitive } from "./safeError";

/**
 * Turns a thrown error into a JSON response without hiding actionable problems:
 *  - errors we throw on purpose with a 4xx `status` (validation, auth, conflicts) keep their message
 *  - origin failures become a clear 403
 *  - everything else is logged in full (server logs are private) and answered with a safe message
 */
export function apiError(e: unknown, scope: string, extra?: Record<string, unknown>): NextResponse {
  const status = Number((e as any)?.status);
  const message = e instanceof Error ? e.message : String(e);

  if (message === "Invalid Origin" || message === "Missing Origin") {
    return NextResponse.json({ error: "Request blocked: this page is not allowed to call the API.", ...extra }, { status: 403 });
  }

  if (Number.isFinite(status) && status >= 400 && status < 500) {
    return NextResponse.json({ error: redactSensitive(message), ...(e as any)?.body, ...extra }, { status });
  }

  console.error(`[${scope}] failed:`, e);
  return NextResponse.json({ error: getSafeErrorMessage(e), ...extra }, { status: Number.isFinite(status) && status >= 500 ? status : 500 });
}
