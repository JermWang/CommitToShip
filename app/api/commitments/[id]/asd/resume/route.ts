import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { checkRateLimit } from "../../../../../lib/rateLimit";
import { apiError } from "../../../../../lib/apiError";
import { getCommitment } from "../../../../../lib/escrowStore";
import { getAsdConfig, resumeAsdConfig } from "../../../../../lib/asdStore";
import { authorizeAsdRequest } from "../../../../../lib/asdAuth";

export const runtime = "nodejs";

function resumeMessage(input: { commitmentId: string; requestId: string; timestampUnix: number }): string {
  return ["Ship & Commit", "ASD Resume", `Commitment: ${input.commitmentId}`, `Request: ${input.requestId}`, `Timestamp: ${input.timestampUnix}`].join("\n");
}

export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "asd:resume", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const commitmentId = String(ctx?.params?.id ?? "").trim();
    if (!commitmentId) return NextResponse.json({ error: "Missing commitment id" }, { status: 400 });

    const record = await getCommitment(commitmentId);
    if (!record || record.status === "archived") return NextResponse.json({ error: "Not found" }, { status: 404 });

    const creatorPubkeyRaw = String(record.creatorPubkey ?? "").trim();
    if (!creatorPubkeyRaw) return NextResponse.json({ error: "Commitment has no creator wallet" }, { status: 409 });
    const creatorPubkey = new PublicKey(creatorPubkeyRaw).toBase58();

    const cfg = await getAsdConfig(commitmentId);
    if (!cfg) return NextResponse.json({ error: "ASD config not found" }, { status: 404 });

    const body = (await req.json().catch(() => null)) as any;
    const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";

    const auth = await authorizeAsdRequest({
      req,
      body,
      commitmentId,
      creatorPubkey,
      action: "resume",
      buildMessage: (timestampUnix) => resumeMessage({ commitmentId, requestId, timestampUnix }),
    });
    if (!auth.ok) return auth.response;

    const res = await resumeAsdConfig({ commitmentId });
    if (!res.changed) {
      return NextResponse.json({ error: "ASD is not paused (a disabled config can only be re-enabled by an admin)", status: res.config?.status ?? null }, { status: 409 });
    }

    return NextResponse.json({
      ok: true,
      requestId: auth.requestId,
      status: res.config?.status ?? null,
      pausedAtUnix: res.config?.pausedAtUnix ?? null,
      resumedAtUnix: res.config?.resumedAtUnix ?? null,
    });
  } catch (e) {
    return apiError(e, "asd/resume");
  }
}
