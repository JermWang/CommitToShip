import { NextResponse } from "next/server";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import crypto from "crypto";

import { checkRateLimit } from "../../../lib/rateLimit";
import { apiError } from "../../../lib/apiError";
import { confirmTransactionSignature, getConnection, waitForSignatureConfirmed } from "../../../lib/solana";
import { privySignSolanaTransaction } from "../../../lib/privy";
import { buildUnsignedPumpfunCreateV2Tx } from "../../../lib/pumpfun";
import { createRewardCommitmentRecord, findManagedCommitmentByAuthority, insertCommitment } from "../../../lib/escrowStore";
import { upsertProjectProfile } from "../../../lib/projectProfilesStore";
import { auditLog } from "../../../lib/auditLog";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { authorizeLaunchAccess } from "../../../lib/creatorAuth";
import { getLaunchTreasuryWallet } from "../../../lib/launchTreasuryStore";
import { claimLaunchAttempt, updateLaunchAttempt } from "../../../lib/launchAttemptStore";
import { LAUNCH_DESCRIPTION_MAX, LaunchInputError, loadLaunchImage, validateLaunchInput } from "../../../lib/launchValidation";
import { extFromContentType } from "../../../lib/assetStorage";
import { withRetry } from "../../../lib/rpc";

export const runtime = "nodejs";
export const maxDuration = 120;

const IS_PROD = process.env.NODE_ENV === "production";

function launchAttribution(): string {
  const custom = String(process.env.LAUNCH_ATTRIBUTION ?? "").trim();
  return custom || "Launched with Ship & Commit";
}

export async function GET() {
  const res = NextResponse.json({ error: "Method Not Allowed. Use POST /api/launch/execute." }, { status: 405 });
  res.headers.set("allow", "POST, OPTIONS");
  return res;
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin") ?? "";

  try {
    verifyAdminOrigin(req);
  } catch {
    const res = new NextResponse(null, { status: 204 });
    res.headers.set("allow", "POST, OPTIONS");
    return res;
  }

  const res = new NextResponse(null, { status: 204 });
  res.headers.set("allow", "POST, OPTIONS");
  res.headers.set("access-control-allow-origin", origin);
  res.headers.set("access-control-allow-methods", "POST, OPTIONS");
  res.headers.set("access-control-allow-headers", "content-type");
  res.headers.set("access-control-allow-credentials", "true");
  res.headers.set("vary", "origin");
  return res;
}

/** Pump.fun's metadata endpoint occasionally hiccups; bound it and retry once. */
async function uploadMetadataToPump(form: () => FormData): Promise<string> {
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form(), signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as any;
        const uri = String(json?.metadataUri ?? "").trim();
        if (uri) return uri;
        lastErr = "pump.fun returned no metadata URI";
      } else {
        lastErr = `pump.fun metadata upload failed (${res.status})`;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
  }
  throw Object.assign(new Error("Could not reach pump.fun to publish your token metadata. Nothing was charged beyond your launch wallet top-up. Please try again in a minute."), {
    status: 502,
    detail: lastErr,
  });
}

export async function POST(req: Request) {
  let stage = "init";
  let payerWallet = "";
  let treasuryWallet = "";
  let launchWalletId = "";
  let commitmentId = "";
  let launchTxSig = "";
  let tokenMintB58 = "";
  let metadataUri = "";
  let bondingCurveB58 = "";
  let escrowPubkey = "";
  let onchainOk = false;
  let attemptClaimed = false;
  let sendBlockhash = "";
  let sendLastValid = 0;

  try {
    const rl = await checkRateLimit(req, { keyPrefix: "launch:execute", limit: 12, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    verifyAdminOrigin(req);

    stage = "read_body";
    const body = (await req.json().catch(() => null)) as any;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

    payerWallet = typeof body.payerWallet === "string" ? body.payerWallet.trim() : "";
    if (!payerWallet) return NextResponse.json({ error: "payerWallet is required" }, { status: 400 });
    let payerPubkey: PublicKey;
    try {
      payerPubkey = new PublicKey(payerWallet);
    } catch {
      return NextResponse.json({ error: "Invalid payer wallet address" }, { status: 400 });
    }
    payerWallet = payerPubkey.toBase58();

    stage = "authorize";
    const denied = await authorizeLaunchAccess(req, { body, payerWallet, auditEvent: "launch_execute_denied" });
    if (denied) return NextResponse.json({ error: denied.error, hint: denied.hint }, { status: denied.status });

    stage = "validate";
    const input = validateLaunchInput(body);

    const devBuySolParsed = Number(body.devBuySol ?? 0);
    const devBuySol = Number.isFinite(devBuySolParsed) && devBuySolParsed >= 0 ? Math.min(devBuySolParsed, 100) : 0;
    const devBuyLamports = Math.floor(devBuySol * 1_000_000_000);
    const requiredLamports = devBuyLamports + 10_000_000;

    // The launch wallet ALWAYS comes from our own records for this (authenticated) payer - never from the request.
    stage = "load_treasury";
    const treasury = await getLaunchTreasuryWallet(payerWallet);
    if (!treasury) {
      return NextResponse.json({ error: "Your launch wallet isn't ready yet. Please press Create again.", code: "TREASURY_NOT_PREPARED" }, { status: 409 });
    }
    launchWalletId = treasury.walletId;
    treasuryWallet = treasury.treasuryWallet;
    const treasuryPubkey = new PublicKey(treasuryWallet);

    stage = "check_existing";
    const existingManaged = await findManagedCommitmentByAuthority(treasuryPubkey.toBase58());
    if (existingManaged) {
      await auditLog("launch_denied_shared_creator_wallet", { creatorWallet: treasuryWallet, existingCommitmentId: existingManaged.id });
      return NextResponse.json(
        {
          error: "This wallet has already launched a token with Auto-Lock.",
          code: "ALREADY_LAUNCHED",
          existingCommitmentId: existingManaged.id,
          hint: "Connect a different wallet to launch another token, or use Manual Lock for an existing token.",
        },
        { status: 409 }
      );
    }

    stage = "verify_treasury_balance";
    const connection = getConnection();

    // If the client just sent the top-up, give it a moment to land before deciding the wallet is under-funded
    // (otherwise the user would be asked to pay twice).
    const fundingSig = typeof body.fundingSig === "string" ? body.fundingSig.trim() : "";
    if (fundingSig) await waitForSignatureConfirmed({ connection, signature: fundingSig, timeoutMs: 25_000 });

    const treasuryBalance = await connection.getBalance(treasuryPubkey, "confirmed");
    const balanceBufferLamports = 50_000;
    const rentExemptMinRaw = await connection.getMinimumBalanceForRentExemption(0);
    const rentExemptMin = Number.isFinite(rentExemptMinRaw) && rentExemptMinRaw > 0 ? rentExemptMinRaw : 890_880;
    const missingLamports = Math.max(0, requiredLamports + balanceBufferLamports + rentExemptMin - treasuryBalance);
    if (missingLamports > 0) {
      const latest = await connection.getLatestBlockhash("confirmed");

      const tx = new Transaction();
      tx.feePayer = payerPubkey;
      tx.recentBlockhash = latest.blockhash;
      tx.lastValidBlockHeight = latest.lastValidBlockHeight;
      tx.add(SystemProgram.transfer({ fromPubkey: payerPubkey, toPubkey: treasuryPubkey, lamports: missingLamports }));

      const txBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const txBase64 = Buffer.from(Uint8Array.from(txBytes)).toString("base64");

      await auditLog("launch_execute_needs_funding", {
        treasuryWallet,
        payerWallet,
        requiredLamports,
        currentLamports: treasuryBalance,
        missingLamports,
        waitedForFundingSig: Boolean(fundingSig),
      });

      return NextResponse.json({
        ok: true,
        needsFunding: true,
        treasuryWallet,
        payerWallet,
        requiredLamports,
        currentLamports: treasuryBalance,
        missingLamports,
        txBase64,
        txFormat: "base64",
        txType: "fund_treasury_wallet",
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
        stage: "needs_funding",
        // Lets the client tell "still confirming" apart from "genuinely short".
        pendingFundingSig: fundingSig || null,
      });
    }

    // From here on money can move: only one launch per payer at a time.
    stage = "claim_attempt";
    const claim = await claimLaunchAttempt(payerWallet);
    if (!claim.ok) {
      const msg =
        claim.reason === "already_launched"
          ? "This wallet has already launched a token with Auto-Lock."
          : claim.reason === "pending_chain"
            ? "Your previous launch is still confirming on-chain. Please wait a few minutes and check your dashboard - do not launch again."
            : "A launch for this wallet is already in progress. Please wait for it to finish.";
      return NextResponse.json(
        { error: msg, code: claim.reason === "already_launched" ? "ALREADY_LAUNCHED" : "LAUNCH_IN_PROGRESS", tokenMint: claim.attempt.tokenMint, launchTxSig: claim.attempt.txSig },
        { status: 409 }
      );
    }
    attemptClaimed = true;

    stage = "load_image";
    const image = await loadLaunchImage(input.imageUrl);

    stage = "upload_metadata";
    const attribution = launchAttribution();
    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const withAttribution = (raw: string): string => {
      const cleaned = String(raw ?? "")
        .trim()
        .replace(new RegExp(`\\s*${escapeRegExp(attribution)}\\s*`, "gi"), "")
        .trim();
      const delim = cleaned.length ? "\n\n" : "";
      const baseMax = Math.max(0, LAUNCH_DESCRIPTION_MAX - attribution.length - delim.length);
      const base = cleaned.slice(0, baseMax).trimEnd();
      const out = (base ? base + delim : "") + attribution;
      return out.length <= LAUNCH_DESCRIPTION_MAX ? out : attribution;
    };

    const pumpDescription = withAttribution(input.description);
    const imageExt = extFromContentType(image.contentType);
    const buildForm = () => {
      const f = new FormData();
      f.append("name", input.name);
      f.append("symbol", input.symbol);
      f.append("description", pumpDescription);
      f.append("showName", "true");
      if (input.websiteUrl) f.append("website", input.websiteUrl);
      if (input.xUrl) f.append("twitter", input.xUrl);
      if (input.telegramUrl) f.append("telegram", input.telegramUrl);
      f.append("file", new Blob([new Uint8Array(image.data)], { type: image.contentType }), `token.${imageExt}`);
      return f;
    };
    metadataUri = await uploadMetadataToPump(buildForm);

    stage = "build_tx";
    const creatorPubkey = treasuryPubkey;
    const mintKeypair = Keypair.generate();

    const { tx, bondingCurve } = await buildUnsignedPumpfunCreateV2Tx({
      connection,
      user: creatorPubkey,
      mint: mintKeypair.publicKey,
      name: input.name,
      symbol: input.symbol,
      uri: metadataUri,
      creator: creatorPubkey,
      isMayhemMode: false,
      spendableSolInLamports: BigInt(devBuyLamports),
      minTokensOut: 0n,
      computeUnitLimit: 300_000,
      computeUnitPriceMicroLamports: 100_000,
    });

    commitmentId = crypto.randomBytes(16).toString("hex");
    tokenMintB58 = mintKeypair.publicKey.toBase58();
    bondingCurveB58 = bondingCurve.toBase58();

    stage = "audit_attempt";
    await auditLog("launch_attempt", {
      commitmentId,
      tokenMint: tokenMintB58,
      payerWallet,
      payoutWallet: input.payoutWallet,
      name: input.name,
      symbol: input.symbol,
      treasuryWallet,
      requiredLamports,
      fundingSig,
    });

    stage = "send_tx";
    for (let attempt = 0; attempt < 4; attempt++) {
      const latest = await withRetry(() => connection.getLatestBlockhash("processed"));
      sendBlockhash = latest.blockhash;
      sendLastValid = latest.lastValidBlockHeight;

      tx.recentBlockhash = sendBlockhash;
      (tx as any).lastValidBlockHeight = sendLastValid;
      tx.partialSign(mintKeypair);

      try {
        const signed = await privySignSolanaTransaction({
          walletId: launchWalletId,
          transactionBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
        });
        const raw = Buffer.from(signed.signedTransactionBase64, "base64");
        launchTxSig = await withRetry(() => connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "processed", maxRetries: 3 }));
        break;
      } catch (sendErr) {
        const msg = (sendErr instanceof Error ? sendErr.message : String(sendErr)).toLowerCase();
        if (!msg.includes("blockhash not found") || attempt === 3) throw sendErr;
      }
    }

    // The tx is out. Persist mint + signature immediately so a crash/timeout can never lose track of it.
    stage = "confirm_tx";
    await updateLaunchAttempt(payerWallet, { status: "submitted", tokenMint: tokenMintB58, txSig: launchTxSig }).catch(() => null);

    await confirmTransactionSignature({
      connection,
      signature: launchTxSig,
      blockhash: sendBlockhash,
      lastValidBlockHeight: sendLastValid,
    });

    await auditLog("launch_onchain_success", { commitmentId, tokenMint: tokenMintB58, launchTxSig, treasuryWallet });

    onchainOk = true;
    escrowPubkey = creatorPubkey.toBase58();
    await updateLaunchAttempt(payerWallet, { status: "confirmed", tokenMint: tokenMintB58, txSig: launchTxSig }).catch(() => null);

    let postLaunchError: string | null = null;
    try {
      const baseRecord = createRewardCommitmentRecord({
        id: commitmentId,
        statement: input.statement || `Lock creator fees for ${input.name}. Ship milestones, release on-chain.`,
        creatorPubkey: input.payoutWallet,
        escrowPubkey,
        escrowSecretKeyB58: `privy:${launchWalletId}`,
        milestones: [],
        tokenMint: tokenMintB58,
        creatorFeeMode: "managed",
      });

      stage = "insert_commitment";
      await insertCommitment({ ...baseRecord, authority: creatorPubkey.toBase58(), destinationOnFail: escrowPubkey });

      stage = "save_profile";
      try {
        await upsertProjectProfile({
          tokenMint: tokenMintB58,
          name: input.name,
          symbol: input.symbol,
          description: input.description || null,
          websiteUrl: input.websiteUrl || null,
          xUrl: input.xUrl || null,
          telegramUrl: input.telegramUrl || null,
          discordUrl: input.discordUrl || null,
          imageUrl: input.imageUrl,
          bannerUrl: input.bannerUrl || null,
          metadataUri: metadataUri || null,
          createdByWallet: input.payoutWallet,
        });
      } catch (profileErr) {
        console.error("[launch/execute] profile save failed", profileErr);
        await auditLog("launch_profile_save_error", { commitmentId, tokenMint: tokenMintB58, error: profileErr });
      }

      await auditLog("launch_success", { commitmentId, tokenMint: tokenMintB58, payerWallet, payoutWallet: input.payoutWallet, treasuryWallet, requiredLamports, fundingSig, launchTxSig });
    } catch (postErr) {
      console.error("[launch/execute] post-chain step failed", stage, postErr);
      await updateLaunchAttempt(payerWallet, { status: "onchain_unrecorded", tokenMint: tokenMintB58, txSig: launchTxSig }).catch(() => null);
      postLaunchError = IS_PROD
        ? "Your token launched successfully. We're finishing a few setup steps in the background."
        : postErr instanceof Error
          ? postErr.message
          : String(postErr);
      await auditLog("launch_postchain_error", { stage, commitmentId, tokenMint: tokenMintB58, launchTxSig, error: postErr });
    }

    return NextResponse.json({
      ok: true,
      commitmentId,
      tokenMint: tokenMintB58,
      creatorWallet: treasuryWallet,
      payerWallet,
      treasuryWallet,
      bondingCurve: bondingCurveB58,
      launchTxSig,
      metadataUri,
      escrowPubkey,
      postLaunchError,
    });
  } catch (e) {
    const code = String((e as any)?.code ?? "");
    const rawMsg = e instanceof Error ? e.message : String(e);

    // The token is live on-chain: whatever failed afterwards, the user must see success.
    if (onchainOk && commitmentId && tokenMintB58 && launchTxSig) {
      await auditLog("launch_postchain_error", { stage, commitmentId, tokenMint: tokenMintB58, launchTxSig, error: e });
      return NextResponse.json({
        ok: true,
        commitmentId,
        tokenMint: tokenMintB58,
        creatorWallet: treasuryWallet,
        payerWallet,
        treasuryWallet,
        bondingCurve: bondingCurveB58,
        launchTxSig,
        metadataUri,
        escrowPubkey,
        postLaunchError: IS_PROD ? "Your token launched successfully. We're finishing a few setup steps in the background." : rawMsg,
      });
    }

    console.error(`[launch/execute] failed at stage "${stage}"`, e);

    // Release the per-payer lock unless the transaction might still land.
    if (attemptClaimed) {
      if (launchTxSig && code === "TX_UNCERTAIN") {
        await auditLog("launch_error", { stage, commitmentId, tokenMint: tokenMintB58, payerWallet, launchTxSig, error: e });
        return NextResponse.json(
          {
            error: "Your launch was submitted but hasn't confirmed yet. Do NOT launch again - check your dashboard in a few minutes.",
            code: "LAUNCH_PENDING",
            tokenMint: tokenMintB58,
            launchTxSig,
          },
          { status: 202 }
        );
      }
      await updateLaunchAttempt(payerWallet, { status: "failed" }).catch(() => null);
    }

    await auditLog("launch_error", { stage, commitmentId, payerWallet, launchTxSig, code, error: e });

    if (e instanceof LaunchInputError || Number.isFinite(Number((e as any)?.status))) {
      // Deliberate, user-actionable failures (validation, pump.fun unreachable, conflicts).
      return apiError(e, "launch/execute", IS_PROD ? undefined : { stage });
    }

    const lower = rawMsg.toLowerCase();
    let friendly = "Launch failed. Your funds are safe in your launch wallet - please try again.";
    if (lower.includes("insufficient") || lower.includes("0x1")) friendly = "Your launch wallet doesn't have enough SOL to cover the launch. Please press Create again to top it up.";
    else if (code === "TX_EXPIRED" || lower.includes("blockhash")) friendly = "The network was congested and the launch didn't land. You weren't charged - please press Create again.";
    else if (lower.includes("simulation failed")) friendly = "The network rejected the launch transaction. Please try again in a moment.";
    else if (lower.includes("privy")) friendly = "Our wallet service had a hiccup. Your funds are safe - please try again.";

    return NextResponse.json({ error: friendly, code: code || "LAUNCH_FAILED", ...(IS_PROD ? {} : { stage, detail: rawMsg }) }, { status: 502 });
  }
}
