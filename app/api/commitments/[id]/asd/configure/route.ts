import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { checkRateLimit } from "../../../../../lib/rateLimit";
import { apiError } from "../../../../../lib/apiError";
import { getCommitment } from "../../../../../lib/escrowStore";
import { getAsdConfig, upsertAsdDraftConfig } from "../../../../../lib/asdStore";
import { authorizeAsdRequest } from "../../../../../lib/asdAuth";

export const runtime = "nodejs";

function configureMessage(input: {
  commitmentId: string;
  requestId: string;
  destinationPubkey: string;
  dailyPercentBps: number;
  slippageBps: number;
  maxDailyAmountRaw: string | null;
  minIntervalSeconds: number;
  timestampUnix: number;
}): string {
  return `Ship & Commit\nASD Configure\nCommitment: ${input.commitmentId}\nRequest: ${input.requestId}\nDestination: ${input.destinationPubkey}\nDailyPercentBps: ${input.dailyPercentBps}\nSlippageBps: ${input.slippageBps}\nMaxDailyAmountRaw: ${input.maxDailyAmountRaw ?? ""}\nMinIntervalSeconds: ${input.minIntervalSeconds}\nTimestamp: ${input.timestampUnix}`;
}

function defaultDestinationPubkey(): string {
  const raw = String(process.env.CTS_ASD_DEFAULT_DESTINATION_PUBKEY ?? "").trim();
  return raw ? new PublicKey(raw).toBase58() : "";
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "asd:configure", limit: 15, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const commitmentId = String(ctx?.params?.id ?? "").trim();
    if (!commitmentId) return NextResponse.json({ error: "Missing commitment id" }, { status: 400 });

    const record = await getCommitment(commitmentId);
    if (!record || record.status === "archived") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (record.kind !== "creator_reward") return NextResponse.json({ error: "Not a creator reward commitment" }, { status: 400 });

    const tokenMintRaw = String(record.tokenMint ?? "").trim();
    const creatorPubkeyRaw = String(record.creatorPubkey ?? "").trim();
    if (!tokenMintRaw) return NextResponse.json({ error: "Commitment has no token mint" }, { status: 409 });
    if (!creatorPubkeyRaw) return NextResponse.json({ error: "Commitment has no creator wallet" }, { status: 409 });

    const tokenMint = new PublicKey(tokenMintRaw).toBase58();
    const creatorPubkey = new PublicKey(creatorPubkeyRaw).toBase58();

    const body = (await req.json().catch(() => null)) as any;

    const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";

    const dailyPercentBpsRaw = Number(body?.dailyPercentBps);
    if (!Number.isFinite(dailyPercentBpsRaw) || dailyPercentBpsRaw <= 0 || dailyPercentBpsRaw > 10_000) {
      return NextResponse.json({ error: "dailyPercentBps must be between 1 and 10000" }, { status: 400 });
    }
    const dailyPercentBps = Math.floor(dailyPercentBpsRaw);

    const slippageBpsRaw = body?.slippageBps;
    const slippageBps = slippageBpsRaw == null ? 800 : Math.floor(Number(slippageBpsRaw));
    if (!Number.isFinite(slippageBps) || slippageBps < 1 || slippageBps > 1000) {
      return NextResponse.json({ error: "slippageBps must be between 1 and 1000" }, { status: 400 });
    }

    const destinationRaw = typeof body?.destinationPubkey === "string" ? body.destinationPubkey.trim() : "";
    let destinationPubkey: string;
    try {
      destinationPubkey = destinationRaw.length ? new PublicKey(destinationRaw).toBase58() : defaultDestinationPubkey();
    } catch {
      throw httpError(400, "Invalid destinationPubkey");
    }
    if (!destinationPubkey) {
      return NextResponse.json({ error: "destinationPubkey is required (or set CTS_ASD_DEFAULT_DESTINATION_PUBKEY)" }, { status: 400 });
    }

    const maxDailyAmountRaw = body?.maxDailyAmountRaw == null ? null : String(body.maxDailyAmountRaw).trim();
    const maxRawNormalized = maxDailyAmountRaw && maxDailyAmountRaw.length ? maxDailyAmountRaw : null;
    if (maxRawNormalized != null && !/^\d{1,20}$/.test(maxRawNormalized)) {
      return NextResponse.json({ error: "maxDailyAmountRaw must be a positive integer (raw token units)" }, { status: 400 });
    }

    const minIntervalSecondsRaw = body?.minIntervalSeconds != null ? Number(body.minIntervalSeconds) : undefined;
    const minIntervalSeconds = minIntervalSecondsRaw == null ? 20 * 60 * 60 : Math.floor(minIntervalSecondsRaw);
    if (!Number.isFinite(minIntervalSeconds) || minIntervalSeconds < 60 || minIntervalSeconds > 14 * 24 * 60 * 60) {
      return NextResponse.json({ error: "minIntervalSeconds must be between 60 and 1209600" }, { status: 400 });
    }

    const existing = await getAsdConfig(commitmentId);
    if (existing?.activatedAtUnix) {
      return NextResponse.json({ error: "ASD is already activated and cannot be modified" }, { status: 409 });
    }

    const auth = await authorizeAsdRequest({
      req,
      body,
      commitmentId,
      creatorPubkey,
      action: "configure",
      buildMessage: (timestampUnix) =>
        configureMessage({
          commitmentId,
          requestId,
          destinationPubkey,
          dailyPercentBps,
          slippageBps,
          maxDailyAmountRaw: maxRawNormalized,
          minIntervalSeconds,
          timestampUnix,
        }),
      extraOnMissingSignature: { tokenMint },
    });
    if (!auth.ok) return auth.response;

    const updated = await upsertAsdDraftConfig({
      commitmentId,
      tokenMint,
      creatorPubkey,
      destinationPubkey,
      dailyPercentBps,
      slippageBps,
      maxDailyAmountRaw: maxRawNormalized,
      minIntervalSeconds,
    });

    return NextResponse.json({
      ok: true,
      requestId: auth.requestId,
      config: {
        commitmentId: updated.commitmentId,
        tokenMint: updated.tokenMint,
        creatorPubkey: updated.creatorPubkey,
        status: updated.status,
        scheduleKind: updated.scheduleKind,
        dailyPercentBps: updated.dailyPercentBps,
        slippageBps: updated.slippageBps,
        maxDailyAmountRaw: updated.maxDailyAmountRaw ?? null,
        minIntervalSeconds: updated.minIntervalSeconds,
        destinationPubkey: updated.destinationPubkey,
        configHash: updated.configHash,
        vaultPubkey: updated.vaultPubkey ?? null,
        activatedAtUnix: updated.activatedAtUnix ?? null,
        lastExecutedAtUnix: updated.lastExecutedAtUnix ?? null,
      },
    });
  } catch (e) {
    if (String((e as any)?.message ?? "") === "ASD is already activated and cannot be modified") {
      return NextResponse.json({ error: "ASD is already activated and cannot be modified" }, { status: 409 });
    }
    return apiError(e, "asd/configure");
  }
}
