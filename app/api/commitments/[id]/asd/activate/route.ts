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
import { activateAsdConfig, getAsdConfig, upsertAsdDraftConfig } from "../../../../../lib/asdStore";
import { privyCreateSolanaWallet } from "../../../../../lib/privy";

export const runtime = "nodejs";

function isPublicLaunchEnabled(): boolean {
  // Public launches enabled by default (closed beta ended)
  const raw = String(process.env.CTS_PUBLIC_LAUNCHES ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

function activateMessage(input: { commitmentId: string; requestId: string; configHash: string }): string {
  return `Commit To Ship\nASD Activate\nCommitment: ${input.commitmentId}\nRequest: ${input.requestId}\nConfigHash: ${input.configHash}`;
}

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
    if (!creatorPubkeyRaw) return NextResponse.json({ error: "Missing creator pubkey" }, { status: 500 });
    const creatorPubkey = new PublicKey(creatorPubkeyRaw).toBase58();

    let cfg = await getAsdConfig(commitmentId);
    if (!cfg) return NextResponse.json({ error: "ASD config not found. Configure first." }, { status: 404 });

    if (!cfg.activatedAtUnix) {
      cfg = await upsertAsdDraftConfig({
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

    if (cfg.activatedAtUnix) {
      return NextResponse.json({
        ok: true,
        alreadyActive: true,
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
        },
      });
    }

    const body = (await req.json().catch(() => null)) as any;

    const isAdmin = await isAdminRequestAsync(req);
    if (isAdmin) {
      verifyAdminOrigin(req);
    }

    const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
    if (!requestId) return NextResponse.json({ error: "requestId is required" }, { status: 400 });
    if (requestId.length > 80) return NextResponse.json({ error: "requestId too long" }, { status: 400 });

    const expected = activateMessage({ commitmentId, requestId, configHash: cfg.configHash });

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

    const created = await privyCreateSolanaWallet();

    const activated = await activateAsdConfig({
      commitmentId,
      vaultWalletId: created.walletId,
      vaultPubkey: created.address,
    });

    return NextResponse.json({
      ok: true,
      config: {
        commitmentId: activated.commitmentId,
        tokenMint: activated.tokenMint,
        creatorPubkey: activated.creatorPubkey,
        status: activated.status,
        scheduleKind: activated.scheduleKind,
        dailyPercentBps: activated.dailyPercentBps,
        slippageBps: activated.slippageBps,
        maxDailyAmountRaw: activated.maxDailyAmountRaw ?? null,
        minIntervalSeconds: activated.minIntervalSeconds,
        destinationPubkey: activated.destinationPubkey,
        configHash: activated.configHash,
        vaultPubkey: activated.vaultPubkey ?? null,
        activatedAtUnix: activated.activatedAtUnix ?? null,
        lastExecutedAtUnix: activated.lastExecutedAtUnix ?? null,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
