import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { isAdminRequestAsync } from "../../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../../lib/adminSession";
import { getAllowedCreatorWallets } from "../../../../../lib/creatorAuth";
import { checkRateLimit } from "../../../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../../../lib/safeError";
import { getCommitment } from "../../../../../lib/escrowStore";
import { getAsdConfig, upsertAsdDraftConfig } from "../../../../../lib/asdStore";

export const runtime = "nodejs";

function isPublicLaunchEnabled(): boolean {
  // Public launches enabled by default (closed beta ended)
  const raw = String(process.env.CTS_PUBLIC_LAUNCHES ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

function configureMessage(input: {
  commitmentId: string;
  requestId: string;
  destinationPubkey: string;
  dailyPercentBps: number;
  slippageBps: number;
  maxDailyAmountRaw: string | null;
  minIntervalSeconds: number;
}): string {
  return `Commit To Ship\nASD Configure\nCommitment: ${input.commitmentId}\nRequest: ${input.requestId}\nDestination: ${input.destinationPubkey}\nDailyPercentBps: ${input.dailyPercentBps}\nSlippageBps: ${input.slippageBps}\nMaxDailyAmountRaw: ${input.maxDailyAmountRaw ?? ""}\nMinIntervalSeconds: ${input.minIntervalSeconds}`;
}

function defaultDestinationPubkey(): string {
  const raw = String(process.env.CTS_ASD_DEFAULT_DESTINATION_PUBKEY ?? "").trim();
  return raw;
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
    if (!tokenMintRaw) return NextResponse.json({ error: "Missing tokenMint" }, { status: 500 });
    if (!creatorPubkeyRaw) return NextResponse.json({ error: "Missing creator pubkey" }, { status: 500 });

    const tokenMint = new PublicKey(tokenMintRaw).toBase58();
    const creatorPubkey = new PublicKey(creatorPubkeyRaw).toBase58();

    const body = (await req.json().catch(() => null)) as any;

    const isAdmin = await isAdminRequestAsync(req);
    if (isAdmin) {
      verifyAdminOrigin(req);
    }

    const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
    if (!requestId) return NextResponse.json({ error: "requestId is required" }, { status: 400 });
    if (requestId.length > 80) return NextResponse.json({ error: "requestId too long" }, { status: 400 });

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
    const destinationPubkey = destinationRaw.length ? new PublicKey(destinationRaw).toBase58() : defaultDestinationPubkey();
    if (!destinationPubkey) {
      return NextResponse.json({ error: "destinationPubkey is required (or set CTS_ASD_DEFAULT_DESTINATION_PUBKEY)" }, { status: 400 });
    }

    const maxDailyAmountRaw = body?.maxDailyAmountRaw == null ? null : String(body.maxDailyAmountRaw).trim();
    const minIntervalSecondsRaw = body?.minIntervalSeconds != null ? Number(body.minIntervalSeconds) : undefined;
    const minIntervalSeconds = minIntervalSecondsRaw == null ? 20 * 60 * 60 : Math.floor(minIntervalSecondsRaw);

    const maxRawNormalized = maxDailyAmountRaw && maxDailyAmountRaw.length ? maxDailyAmountRaw : null;

    const expected = configureMessage({
      commitmentId,
      requestId,
      destinationPubkey,
      dailyPercentBps,
      slippageBps,
      maxDailyAmountRaw: maxRawNormalized,
      minIntervalSeconds,
    });

    if (!isAdmin) {
      if (!isPublicLaunchEnabled()) {
        const allowed = getAllowedCreatorWallets();
        if (!allowed.has(creatorPubkey)) {
          return NextResponse.json(
            { error: "Wallet is not approved for closed beta", hint: "Ask to be added to CTS_CREATOR_WALLET_PUBKEYS." },
            { status: 403 }
          );
        }
      }

      const signatureB58 =
        typeof body?.signatureB58 === "string"
          ? body.signatureB58.trim()
          : typeof body?.signature === "string"
            ? body.signature.trim()
            : "";
      if (!signatureB58) {
        return NextResponse.json(
          {
            error: "signature required",
            message: expected,
            creatorPubkey,
            tokenMint,
          },
          { status: 400 }
        );
      }

      const providedMessage = typeof body?.message === "string" ? body.message : expected;
      if (providedMessage !== expected) {
        return NextResponse.json({ error: "Invalid message" }, { status: 400 });
      }

      const signature = bs58.decode(signatureB58);
      const creatorPk = new PublicKey(creatorPubkey);
      const ok = nacl.sign.detached.verify(new TextEncoder().encode(expected), signature, creatorPk.toBytes());
      if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const existing = await getAsdConfig(commitmentId);
    if (existing?.activatedAtUnix) {
      return NextResponse.json({ error: "ASD is already activated and cannot be modified" }, { status: 409 });
    }

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
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
