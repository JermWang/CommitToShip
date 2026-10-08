import { NextResponse } from "next/server";

import { checkRateLimit } from "../../../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../../../lib/safeError";
import { getAsdConfig, listAsdExecutions } from "../../../../../lib/asdStore";
import { getAsdVaultSolReserveLamports } from "../../../../../lib/asdExecution";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: { id: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "asd:status", limit: 120, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const commitmentId = String(ctx?.params?.id ?? "").trim();
    if (!commitmentId) return NextResponse.json({ error: "Missing commitment id" }, { status: 400 });

    const cfg = await getAsdConfig(commitmentId);
    if (!cfg) return NextResponse.json({ ok: true, config: null });

    const execs = await listAsdExecutions({ commitmentId, limit: 20 });

    return NextResponse.json({
      ok: true,
      config: {
        commitmentId: cfg.commitmentId,
        tokenMint: cfg.tokenMint,
        creatorPubkey: cfg.creatorPubkey,
        status: cfg.status,
        scheduleKind: cfg.scheduleKind,
        dailyPercentBps: cfg.dailyPercentBps,
        slippageBps: cfg.slippageBps,
        maxDailyAmountRaw: cfg.maxDailyAmountRaw ?? null,
        minIntervalSeconds: cfg.minIntervalSeconds,
        destinationPubkey: cfg.destinationPubkey,
        configHash: cfg.configHash,
        vaultPubkey: cfg.vaultPubkey ?? null,
        activatedAtUnix: cfg.activatedAtUnix ?? null,
        lastExecutedAtUnix: cfg.lastExecutedAtUnix ?? null,
        lastError: cfg.lastError ?? null,
        pausedAtUnix: cfg.pausedAtUnix ?? null,
        resumedAtUnix: cfg.resumedAtUnix ?? null,
        lastRequestId: cfg.lastRequestId ?? null,
        lastRequestAction: cfg.lastRequestAction ?? null,
        lastRequestAtUnix: cfg.lastRequestAtUnix ?? null,
        vaultSolReserveLamports: getAsdVaultSolReserveLamports(),
      },
      recentExecutions: execs.map((e) => ({
        id: e.id,
        runAtUnix: e.runAtUnix,
        plannedAmountRaw: e.plannedAmountRaw,
        executedAmountRaw: e.executedAmountRaw,
        status: e.status,
        txSig: e.txSig ?? null,
        vaultPubkey: e.vaultPubkey ?? null,
        destinationPubkey: e.destinationPubkey,
        vaultBalanceRaw: e.vaultBalanceRaw ?? null,
        outMint: e.outMint ?? null,
        outAmountRaw: e.outAmountRaw ?? null,
        error: e.error ?? null,
        confirmedAtUnix: e.confirmedAtUnix ?? null,
        forwardStatus: e.forwardStatus ?? null,
        forwardTxSig: e.forwardTxSig ?? null,
        forwardedLamports: e.forwardedLamports ?? null,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
