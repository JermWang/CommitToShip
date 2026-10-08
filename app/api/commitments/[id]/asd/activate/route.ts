import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { checkRateLimit } from "../../../../../lib/rateLimit";
import { apiError } from "../../../../../lib/apiError";
import { getCommitment } from "../../../../../lib/escrowStore";
import { AsdConfigRecord, activateAsdConfig, computeConfigHash, getAsdConfig, upsertAsdDraftConfig } from "../../../../../lib/asdStore";
import { authorizeAsdRequest } from "../../../../../lib/asdAuth";
import { privyCreateSolanaWallet } from "../../../../../lib/privy";

export const runtime = "nodejs";

function activateMessage(input: { commitmentId: string; requestId: string; configHash: string; timestampUnix: number }): string {
  return `Ship & Commit\nASD Activate\nCommitment: ${input.commitmentId}\nRequest: ${input.requestId}\nConfigHash: ${input.configHash}\nTimestamp: ${input.timestampUnix}`;
}

function configView(cfg: AsdConfigRecord) {
  return {
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
  };
}

const FUNDING_HINT =
  "Fund the vault with the tokens to sell plus SOL for network fees: POST /api/commitments/<id>/asd/fund-tx returns an unsigned transaction for the creator wallet to sign.";

export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "asd:activate", limit: 10, windowSeconds: 60 });
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

    const creatorPubkeyRaw = String(record.creatorPubkey ?? "").trim();
    if (!creatorPubkeyRaw) return NextResponse.json({ error: "Commitment has no creator wallet" }, { status: 409 });
    const creatorPubkey = new PublicKey(creatorPubkeyRaw).toBase58();

    const cfg = await getAsdConfig(commitmentId);
    if (!cfg) return NextResponse.json({ error: "ASD config not found. Configure first." }, { status: 404 });

    if (cfg.activatedAtUnix) {
      return NextResponse.json({ ok: true, alreadyActive: true, config: configView(cfg), fundingHint: FUNDING_HINT });
    }

    // The hash the creator signs is computed from the stored draft (read-only); nothing is written before auth.
    const configHash = computeConfigHash({
      commitmentId: cfg.commitmentId,
      tokenMint: cfg.tokenMint,
      creatorPubkey: cfg.creatorPubkey,
      destinationPubkey: cfg.destinationPubkey,
      scheduleKind: cfg.scheduleKind,
      dailyPercentBps: cfg.dailyPercentBps,
      slippageBps: cfg.slippageBps,
      maxDailyAmountRaw: cfg.maxDailyAmountRaw ?? null,
      minIntervalSeconds: cfg.minIntervalSeconds,
    });

    const body = (await req.json().catch(() => null)) as any;
    const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";

    const auth = await authorizeAsdRequest({
      req,
      body,
      commitmentId,
      creatorPubkey,
      action: "activate",
      buildMessage: (timestampUnix) => activateMessage({ commitmentId, requestId, configHash, timestampUnix }),
      extraOnMissingSignature: { configHash },
    });
    if (!auth.ok) return auth.response;

    if (cfg.configHash !== configHash) {
      // Legacy rows hashed with an older field set: refresh the stored hash now that the creator signed this one.
      await upsertAsdDraftConfig({
        commitmentId: cfg.commitmentId,
        tokenMint: cfg.tokenMint,
        creatorPubkey: cfg.creatorPubkey,
        destinationPubkey: cfg.destinationPubkey,
        dailyPercentBps: cfg.dailyPercentBps,
        slippageBps: cfg.slippageBps,
        maxDailyAmountRaw: cfg.maxDailyAmountRaw ?? null,
        minIntervalSeconds: cfg.minIntervalSeconds,
      });
    }

    const created = await privyCreateSolanaWallet();

    const activated = await activateAsdConfig({
      commitmentId,
      vaultWalletId: created.walletId,
      vaultPubkey: created.address,
    });

    return NextResponse.json({ ok: true, requestId: auth.requestId, config: configView(activated), fundingHint: FUNDING_HINT });
  } catch (e) {
    return apiError(e, "asd/activate");
  }
}
