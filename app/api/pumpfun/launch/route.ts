import { NextResponse } from "next/server";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";

import { isAdminRequestAsync } from "../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { checkRateLimit } from "../../../lib/rateLimit";
import { auditLog } from "../../../lib/auditLog";
import { apiError } from "../../../lib/apiError";
import { upsertProjectProfile } from "../../../lib/projectProfilesStore";
import { getConnection } from "../../../lib/solana";
import { isTxSendError, sendAndConfirmDurable } from "../../../lib/rpc";
import {
  assertSignedAsBuilt,
  buildUnsignedPumpfunBuyTx,
  buildUnsignedPumpfunCreateV2Tx,
  loadPumpLookupTable,
  type PumpfunCreatePlan,
} from "../../../lib/pumpfun";
import { privySignSolanaTransaction } from "../../../lib/privy";
import { findCommitmentUsingWallet } from "../../../lib/launchTreasuryStore";
import { getSafeErrorMessage } from "../../../lib/safeError";

export const runtime = "nodejs";
export const maxDuration = 300;

function parseBigIntLike(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && value.trim().length) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * POST /api/pumpfun/launch (admin)
 *
 * Creates a pump.fun coin from a Privy wallet (create_v2 + dev buy as ONE v0 transaction through pump.fun's address
 * lookup table; if that can't be built, create first and send the dev buy as a second transaction).
 */
export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "pumpfun:launch", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    verifyAdminOrigin(req);
    if (!(await isAdminRequestAsync(req))) {
      await auditLog("admin_pumpfun_launch_denied", {});
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as any;

    const walletId = typeof body?.walletId === "string" ? body.walletId.trim() : "";
    const walletPubkeyRaw = typeof body?.walletPubkey === "string" ? body.walletPubkey.trim() : "";

    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const symbol = typeof body?.symbol === "string" ? body.symbol.trim() : "";
    const uri = typeof body?.uri === "string" ? body.uri.trim() : "";

    const creatorPubkeyRaw = typeof body?.creatorPubkey === "string" ? body.creatorPubkey.trim() : "";
    const isMayhemMode = Boolean(body?.isMayhemMode);

    const spendableSolInLamports = parseBigIntLike(body?.spendableSolInLamports);
    const minTokensOut = parseBigIntLike(body?.minTokensOut);

    const computeUnitLimit = body?.computeUnitLimit != null ? Number(body.computeUnitLimit) : 300_000;
    const computeUnitPriceMicroLamports = body?.computeUnitPriceMicroLamports != null ? Number(body.computeUnitPriceMicroLamports) : 100_000;

    if (!walletId) return NextResponse.json({ error: "walletId is required" }, { status: 400 });
    if (!walletPubkeyRaw) return NextResponse.json({ error: "walletPubkey is required" }, { status: 400 });

    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
    if (!symbol) return NextResponse.json({ error: "symbol is required" }, { status: 400 });
    if (!uri) return NextResponse.json({ error: "uri is required" }, { status: 400 });

    if (name.length > 32) return NextResponse.json({ error: "name too long" }, { status: 400 });
    if (symbol.length > 10) return NextResponse.json({ error: "symbol too long" }, { status: 400 });
    if (uri.length > 200) return NextResponse.json({ error: "uri too long" }, { status: 400 });
    if (!/^https?:\/\//i.test(uri)) return NextResponse.json({ error: "uri must be http(s)" }, { status: 400 });

    if (spendableSolInLamports == null || spendableSolInLamports <= 0n) {
      return NextResponse.json({ error: "spendableSolInLamports must be a positive integer" }, { status: 400 });
    }

    const user = new PublicKey(walletPubkeyRaw);
    const creator = creatorPubkeyRaw ? new PublicKey(creatorPubkeyRaw) : user;

    // Never spend from a wallet that is a commitment escrow/authority (it holds locked creator fees).
    const usedBy = await findCommitmentUsingWallet(user.toBase58());
    if (usedBy) {
      await auditLog("admin_pumpfun_launch_denied", { reason: "live_escrow", walletPubkey: user.toBase58(), commitmentId: usedBy });
      return NextResponse.json({ error: "This wallet is a commitment escrow and can't fund a launch", commitmentId: usedBy }, { status: 409 });
    }

    const mintKeypair = Keypair.generate();
    const mintB58 = mintKeypair.publicKey.toBase58();
    const connection = getConnection();
    const lookupTable = await loadPumpLookupTable(connection);

    const planRef: { current: PumpfunCreatePlan | null } = { current: null };
    const sent = await sendAndConfirmDurable({
      connection,
      maxRebuilds: 1,
      confirmTimeoutMs: 90_000,
      sign: async (latest) => {
        const plan = await buildUnsignedPumpfunCreateV2Tx({
          connection,
          user,
          mint: mintKeypair.publicKey,
          name,
          symbol,
          uri,
          creator,
          isMayhemMode,
          spendableSolInLamports,
          minTokensOut: minTokensOut ?? 1n,
          computeUnitLimit,
          computeUnitPriceMicroLamports,
          latestBlockhash: latest,
          lookupTable,
        });
        plan.tx.sign([mintKeypair]);
        const signed = await privySignSolanaTransaction({ walletId, transactionBase64: Buffer.from(plan.tx.serialize()).toString("base64") });
        const raw = Buffer.from(signed.signedTransactionBase64, "base64");
        assertSignedAsBuilt(raw, plan.tx.message.serialize());
        planRef.current = plan;
        return raw;
      },
      onPrepared: async (info) => {
        await auditLog("admin_pumpfun_launch_prepared", { signature: info.signature, mint: mintB58, walletId, user: user.toBase58(), attempt: info.attempt });
      },
    });
    const signature = sent.signature;
    const plan = planRef.current as PumpfunCreatePlan | null;

    await auditLog("admin_pumpfun_launch_sent", {
      signature,
      mint: mintB58,
      creator: creator.toBase58(),
      walletId,
      user: user.toBase58(),
      devBuyIncluded: plan?.devBuyIncluded ?? null,
      txSizeBytes: plan?.sizeBytes ?? null,
      lookupTable: plan?.lookupTable ?? null,
    });

    let devBuySignature: string | null = null;
    let devBuyError: string | null = null;
    if (plan && plan.devBuyRequested && !plan.devBuyIncluded) {
      try {
        const buy = await sendAndConfirmDurable({
          connection,
          maxRebuilds: 1,
          confirmTimeoutMs: 60_000,
          sign: async (latest) => {
            const { tx } = await buildUnsignedPumpfunBuyTx({
              connection,
              user,
              mint: mintKeypair.publicKey,
              creator,
              spendableSolInLamports,
              minTokensOut: minTokensOut ?? undefined,
              computeUnitLimit: 200_000,
              computeUnitPriceMicroLamports,
              latestBlockhash: latest,
            });
            const signed = await privySignSolanaTransaction({
              walletId,
              transactionBase64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
            });
            const raw = Buffer.from(signed.signedTransactionBase64, "base64");
            assertSignedAsBuilt(raw, tx.serializeMessage());
            return raw;
          },
          onPrepared: async (info) => {
            devBuySignature = info.signature;
            await auditLog("admin_pumpfun_devbuy_prepared", { signature: info.signature, mint: mintB58, walletId });
          },
        });
        devBuySignature = buy.signature;
      } catch (buyErr) {
        devBuyError = isTxSendError(buyErr) && buyErr.code === "TX_UNCERTAIN" ? "Dev buy submitted, still confirming" : getSafeErrorMessage(buyErr);
        await auditLog("admin_pumpfun_devbuy_error", { mint: mintB58, devBuySignature, error: buyErr });
      }
    }

    await upsertProjectProfile({
      tokenMint: mintB58,
      name,
      symbol,
      metadataUri: uri,
      createdByWallet: creator.toBase58(),
    });

    return NextResponse.json({
      ok: true,
      signature,
      explorerUrl: `https://solscan.io/tx/${encodeURIComponent(signature)}`,
      mint: mintB58,
      bondingCurve: plan?.bondingCurve.toBase58() ?? null,
      associatedBondingCurve: plan?.associatedBondingCurve.toBase58() ?? null,
      associatedUser: plan?.associatedUser.toBase58() ?? null,
      feeRecipient: plan?.feeRecipient.toBase58() ?? null,
      creator: creator.toBase58(),
      launchMode: plan?.devBuyIncluded ? "single" : "split",
      devBuySignature,
      devBuyError,
    });
  } catch (e) {
    await auditLog("admin_pumpfun_launch_error", { error: getSafeErrorMessage(e) });
    if (isTxSendError(e) && e.code === "TX_UNCERTAIN") {
      return NextResponse.json({ error: "Launch submitted but not confirmed yet - do not retry; check the signature", code: e.code, signature: e.signature }, { status: 202 });
    }
    return apiError(e, "pumpfun/launch");
  }
}
