import { NextResponse } from "next/server";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import crypto from "crypto";

import { checkRateLimit } from "../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { confirmTransactionSignature, getConnection } from "../../../lib/solana";
import { privyRefundWalletToDestination, privySignSolanaTransaction } from "../../../lib/privy";
import { buildUnsignedPumpfunCreateV2Tx } from "../../../lib/pumpfun";
import { createRewardCommitmentRecord, insertCommitment, listCommitments } from "../../../lib/escrowStore";
import { upsertProjectProfile } from "../../../lib/projectProfilesStore";
import { auditLog } from "../../../lib/auditLog";
import { getAdminCookieName, getAdminSessionWallet, getAllowedAdminWallets, verifyAdminOrigin } from "../../../lib/adminSession";

export const runtime = "nodejs";

const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // mainnet
const IS_PROD = process.env.NODE_ENV === "production";

function isPublicLaunchEnabled(): boolean {
  const raw = String(process.env.CTS_PUBLIC_LAUNCHES ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export async function GET() {
  const res = NextResponse.json({ error: "Method Not Allowed. Use POST /api/launch/execute." }, { status: 405 });
  res.headers.set("allow", "POST, OPTIONS");
  return res;
}

export async function OPTIONS(req: Request) {
  const expected = String(process.env.APP_ORIGIN ?? "").trim();
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
  res.headers.set("access-control-allow-origin", origin || expected);
  res.headers.set("access-control-allow-methods", "POST, OPTIONS");
  res.headers.set("access-control-allow-headers", "content-type");
  res.headers.set("access-control-allow-credentials", "true");
  res.headers.set("vary", "origin");
  return res;
}

export async function POST(req: Request) {
  let stage = "init";
  let walletId = "";
  let treasuryWallet = "";
  let treasuryPubkey: PublicKey | null = null;
  let launchWalletId = "";
  let creatorWallet = "";
  let payerWallet = "";
  let commitmentId = "";
  let launchTxSig = "";
  let tokenMintB58 = "";
  let metadataUri = "";
  let bondingCurveB58 = "";
  let escrowPubkey = "";
  let onchainOk = false;
  let creatorPubkey: PublicKey | null = null;
  let payerPubkey: PublicKey | null = null;
  let funded = false;
  let fundedLamports = 0;
  let fundSignature = "";

  try {
    const rl = await checkRateLimit(req, { keyPrefix: "launch:execute", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    verifyAdminOrigin(req);

    if (!isPublicLaunchEnabled()) {
      const cookieHeader = String(req.headers.get("cookie") ?? "");
      const hasAdminCookie = cookieHeader.includes(`${getAdminCookieName()}=`);
      const allowed = getAllowedAdminWallets();
      const adminWallet = await getAdminSessionWallet(req);

      if (!adminWallet) {
        await auditLog("admin_launch_denied", { hasAdminCookie });
        return NextResponse.json(
          {
            error: hasAdminCookie
              ? "Admin session not found or expired. Try Admin Sign-In again."
              : "Admin Sign-In required",
          },
          { status: 401 }
        );
      }

      if (!allowed.has(adminWallet)) {
        await auditLog("admin_launch_denied", { adminWallet });
        return NextResponse.json({ error: "Not an allowed admin wallet" }, { status: 401 });
      }
    }

    stage = "read_body";
    const body = (await req.json()) as any;

    walletId = typeof body.walletId === "string" ? body.walletId.trim() : "";
    treasuryWallet = typeof body.treasuryWallet === "string" ? body.treasuryWallet.trim() : "";
    creatorWallet = typeof body.creatorWallet === "string" ? body.creatorWallet.trim() : "";
    payerWallet = typeof body.payerWallet === "string" ? body.payerWallet.trim() : "";

    if (!treasuryWallet) treasuryWallet = creatorWallet;

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
    const statement = typeof body.statement === "string" ? body.statement.trim() : "";
    const payoutWallet = typeof body.payoutWallet === "string" ? body.payoutWallet.trim() : "";

    const websiteUrl = typeof body.websiteUrl === "string" ? body.websiteUrl.trim() : "";
    const xUrl = typeof body.xUrl === "string" ? body.xUrl.trim() : "";
    const telegramUrl = typeof body.telegramUrl === "string" ? body.telegramUrl.trim() : "";
    const discordUrl = typeof body.discordUrl === "string" ? body.discordUrl.trim() : "";
    const bannerUrl = typeof body.bannerUrl === "string" ? body.bannerUrl.trim() : "";

    const devBuySolRaw = body.devBuySol;
    const devBuySolParsed = Number(devBuySolRaw ?? 0);
    const devBuySol = Number.isFinite(devBuySolParsed) && devBuySolParsed >= 0 ? devBuySolParsed : 0;
    const devBuyLamports = Math.floor(devBuySol * 1_000_000_000);
    const requiredLamports = devBuyLamports + 10_000_000;

    if (!walletId) return NextResponse.json({ error: "walletId is required" }, { status: 400 });
    if (!treasuryWallet) return NextResponse.json({ error: "treasuryWallet is required" }, { status: 400 });
    if (!payerWallet) return NextResponse.json({ error: "payerWallet is required" }, { status: 400 });

    if (!name) return NextResponse.json({ error: "Token name is required" }, { status: 400 });
    if (!symbol) return NextResponse.json({ error: "Token symbol is required" }, { status: 400 });
    if (!imageUrl) return NextResponse.json({ error: "Token image is required" }, { status: 400 });
    if (!payoutWallet) return NextResponse.json({ error: "Payout wallet is required" }, { status: 400 });

    let payoutPubkey: PublicKey;
    try {
      payoutPubkey = new PublicKey(payoutWallet);
    } catch {
      return NextResponse.json({ error: "Invalid payout wallet address" }, { status: 400 });
    }

    try {
      payerPubkey = new PublicKey(payerWallet);
    } catch {
      return NextResponse.json({ error: "Invalid payer wallet address" }, { status: 400 });
    }

    try {
      treasuryPubkey = new PublicKey(treasuryWallet);
    } catch {
      return NextResponse.json({ error: "Invalid treasury wallet address" }, { status: 400 });
    }

    stage = "verify_treasury_balance";
    const connection = getConnection();
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
      tx.add(
        SystemProgram.transfer({
          fromPubkey: payerPubkey,
          toPubkey: treasuryPubkey,
          lamports: missingLamports,
        })
      );

      const txBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const txBase64 = Buffer.from(Uint8Array.from(txBytes)).toString("base64");

      await auditLog("launch_execute_needs_funding", {
        walletId,
        treasuryWallet,
        payerWallet,
        requiredLamports,
        currentLamports: treasuryBalance,
        missingLamports,
      });

      return NextResponse.json({
        ok: true,
        needsFunding: true,
        walletId,
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
      });
    }

    stage = "use_treasury_wallet";
    launchWalletId = walletId;
    creatorWallet = treasuryWallet;
    creatorPubkey = treasuryPubkey;

    if (!creatorPubkey) {
      throw Object.assign(new Error("Invalid creator wallet"), { status: 400 });
    }

    const creatorWalletPubkey = creatorPubkey.toBase58();
    const existingManaged = (await listCommitments()).find(
      (c) => c.kind === "creator_reward" && c.creatorFeeMode === "managed" && c.status !== "archived" && c.authority === creatorWalletPubkey
    );
    if (existingManaged) {
      await auditLog("launch_denied_shared_creator_wallet", {
        creatorWallet: creatorWalletPubkey,
        existingCommitmentId: existingManaged.id,
      });
      return NextResponse.json(
        {
          error: "Creator wallet already has a managed creator reward commitment",
          creatorWallet: creatorWalletPubkey,
          existingCommitmentId: existingManaged.id,
          hint: "Managed launches require a unique creator wallet. Use a different payer wallet or use manual mode (assisted).",
        },
        { status: 409 }
      );
    }

    stage = "upload_metadata";
    const PUMP_DESCRIPTION_MAX = 600;
    const ATTRIBUTION = "Launched with CommitToShip.xyz";

    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const withAttribution = (raw: string): string => {
      const trimmed = String(raw ?? "").trim();
      const cleaned = trimmed.replace(new RegExp(`\\s*${escapeRegExp(ATTRIBUTION)}\\s*`, "gi"), "").trim();
      const delim = cleaned.length ? "\n\n" : "";
      const reserved = ATTRIBUTION.length + delim.length;
      const baseMax = Math.max(0, PUMP_DESCRIPTION_MAX - reserved);
      const base = cleaned.slice(0, baseMax).trimEnd();
      const out = (base ? base + delim : "") + ATTRIBUTION;
      return out.length <= PUMP_DESCRIPTION_MAX ? out : ATTRIBUTION;
    };

    const pumpDescription = withAttribution(description);
    const metadataFormData = new FormData();
    metadataFormData.append("name", name);
    metadataFormData.append("symbol", symbol);
    metadataFormData.append("description", pumpDescription);
    metadataFormData.append("showName", "true");
    if (websiteUrl) metadataFormData.append("website", websiteUrl);
    if (xUrl) metadataFormData.append("twitter", xUrl);
    if (telegramUrl) metadataFormData.append("telegram", telegramUrl);

    stage = "fetch_image";
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw Object.assign(new Error("Failed to fetch token image"), { status: 400 });
    }
    const imageBlob = await imageResponse.blob();
    metadataFormData.append("file", imageBlob, "token.png");

    stage = "pump_ipfs";
    const ipfsResponse = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: metadataFormData });
    if (!ipfsResponse.ok) {
      const ipfsError = await ipfsResponse.text().catch(() => "Unknown error");
      throw Object.assign(new Error(`Failed to upload metadata: ${ipfsError}`), { status: 500 });
    }

    const ipfsJson = await ipfsResponse.json();
    metadataUri = ipfsJson?.metadataUri;
    if (!metadataUri) {
      throw Object.assign(new Error("Failed to get metadata URI from Pump.fun"), { status: 500 });
    }

    stage = "build_tx";
    const mintKeypair = Keypair.generate();

    const { tx, bondingCurve } = await buildUnsignedPumpfunCreateV2Tx({
      connection,
      user: creatorPubkey,
      mint: mintKeypair.publicKey,
      name,
      symbol,
      uri: metadataUri,
      creator: creatorPubkey,
      isMayhemMode: false,
      spendableSolInLamports: BigInt(devBuyLamports),
      minTokensOut: 0n,
      computeUnitLimit: 300_000,
      computeUnitPriceMicroLamports: 100_000,
    });

    const latestForSend = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = latestForSend.blockhash;
    (tx as any).lastValidBlockHeight = latestForSend.lastValidBlockHeight;
    tx.partialSign(mintKeypair);

    commitmentId = crypto.randomBytes(16).toString("hex");
    tokenMintB58 = mintKeypair.publicKey.toBase58();
    bondingCurveB58 = bondingCurve.toBase58();

    stage = "audit_attempt";
    await auditLog("launch_attempt", {
      commitmentId,
      tokenMint: tokenMintB58,
      payerWallet,
      payoutWallet: payoutPubkey.toBase58(),
      name,
      symbol,
      treasuryWallet,
      treasuryWalletId: walletId,
      launchCreatorWallet: creatorWallet,
      launchWalletId,
      requiredLamports,
      fundSignature,
    });

    stage = "send_tx";
    const { withRetry } = await import("../../../lib/rpc");
    let sendBlockhash = "";
    let sendLastValidBlockHeight = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const latest = await withRetry(() => connection.getLatestBlockhash("processed"));
      sendBlockhash = latest.blockhash;
      sendLastValidBlockHeight = latest.lastValidBlockHeight;

      tx.recentBlockhash = sendBlockhash;
      (tx as any).lastValidBlockHeight = sendLastValidBlockHeight;
      tx.partialSign(mintKeypair);

      try {
        const serializeForPrivy = () => tx.serialize({ requireAllSignatures: false }).toString("base64");
        const signed = await privySignSolanaTransaction({ walletId: launchWalletId, transactionBase64: serializeForPrivy() });
        const raw = Buffer.from(signed.signedTransactionBase64, "base64");
        launchTxSig = await withRetry(() =>
          connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "processed", maxRetries: 3 })
        );
        break;
      } catch (sendErr) {
        const msg = getSafeErrorMessage(sendErr);
        const isBlockhashNotFound = msg.toLowerCase().includes("blockhash not found");
        if (!isBlockhashNotFound || attempt === 3) throw sendErr;
      }
    }

    stage = "confirm_tx";
    await confirmTransactionSignature({
      connection,
      signature: launchTxSig,
      blockhash: sendBlockhash || String(tx.recentBlockhash ?? ""),
      lastValidBlockHeight: sendLastValidBlockHeight || Number((tx as any).lastValidBlockHeight ?? 0),
    });

    await auditLog("launch_onchain_success", {
      commitmentId,
      tokenMint: tokenMintB58,
      launchTxSig,
      treasuryWallet,
      treasuryWalletId: walletId,
      launchCreatorWallet: creatorWallet,
      launchWalletId,
    });

    onchainOk = true;
    escrowPubkey = creatorPubkey.toBase58();

    let postLaunchError: string | null = null;
    try {
      const baseRecord = createRewardCommitmentRecord({
        id: commitmentId,
        statement: statement || `Lock creator fees for ${name}. Ship milestones, release on-chain.`,
        creatorPubkey: payoutPubkey.toBase58(),
        escrowPubkey,
        escrowSecretKeyB58: `privy:${launchWalletId}`,
        milestones: [],
        tokenMint: mintKeypair.publicKey.toBase58(),
        creatorFeeMode: "managed",
      });

      const record = {
        ...baseRecord,
        authority: creatorPubkey.toBase58(),
        destinationOnFail: payoutPubkey.toBase58(),
      };

      stage = "insert_commitment";
      await insertCommitment(record);

      stage = "save_profile";
      try {
        await upsertProjectProfile({
          tokenMint: mintKeypair.publicKey.toBase58(),
          name: name || null,
          symbol: symbol || null,
          description: description || null,
          websiteUrl: websiteUrl || null,
          xUrl: xUrl || null,
          telegramUrl: telegramUrl || null,
          discordUrl: discordUrl || null,
          imageUrl: imageUrl || null,
          bannerUrl: bannerUrl || null,
          metadataUri: metadataUri || null,
          createdByWallet: payoutPubkey.toBase58(),
        });
      } catch (profileErr) {
        await auditLog("launch_profile_save_error", { commitmentId, tokenMint: mintKeypair.publicKey.toBase58(), error: getSafeErrorMessage(profileErr) });
      }

      await auditLog("launch_success", {
        commitmentId,
        tokenMint: mintKeypair.publicKey.toBase58(),
        payerWallet,
        payoutWallet: payoutPubkey.toBase58(),
        treasuryWallet,
        treasuryWalletId: walletId,
        launchCreatorWallet: creatorWallet,
        launchWalletId,
        requiredLamports,
        fundSignature,
        launchTxSig,
      });
    } catch (postErr) {
      const internal = getSafeErrorMessage(postErr);
      postLaunchError = IS_PROD
        ? "Your token launched successfully. We’re finishing a few setup steps in the background."
        : internal;
      try {
        await auditLog("launch_postchain_error", {
          stage,
          commitmentId,
          tokenMint: tokenMintB58,
          launchTxSig,
          error: internal,
        });
      } catch {
        // ignore
      }
    }

    return NextResponse.json({
      ok: true,
      commitmentId,
      tokenMint: mintKeypair.publicKey.toBase58(),
      creatorWallet,
      payerWallet,
      treasuryWallet,
      launchWalletId,
      bondingCurve: bondingCurveB58,
      launchTxSig,
      metadataUri,
      escrowPubkey,
      postLaunchError,
    });
  } catch (e) {
    const msg = getSafeErrorMessage(e);
    const status = Number((e as any)?.status ?? 500);

    if (onchainOk && commitmentId && tokenMintB58 && launchTxSig) {
      await auditLog("launch_postchain_error", { stage, commitmentId, tokenMint: tokenMintB58, launchTxSig, error: msg });
      return NextResponse.json(
        {
          ok: true,
          commitmentId,
          tokenMint: tokenMintB58,
          creatorWallet,
          payerWallet,
          treasuryWallet,
          launchWalletId,
          bondingCurve: bondingCurveB58,
          launchTxSig,
          metadataUri,
          escrowPubkey,
          postLaunchError: IS_PROD
            ? "Your token launched successfully. We’re finishing a few setup steps in the background."
            : msg,
        },
        { status: 200 }
      );
    }

    if (funded && launchWalletId && launchWalletId !== walletId && creatorPubkey && treasuryPubkey && !launchTxSig) {
      try {
        const refund = await privyRefundWalletToDestination({
          walletId: launchWalletId,
          fromPubkey: creatorPubkey,
          toPubkey: treasuryPubkey,
          caip2: SOLANA_CAIP2,
          keepLamports: 10_000,
        });
        await auditLog("launch_refund_attempt", {
          commitmentId,
          treasuryWalletId: walletId,
          launchWalletId,
          treasuryWallet,
          launchCreatorWallet: creatorWallet,
          fundedLamports,
          payerWallet,
          ok: refund.ok,
          refundSignature: refund.ok ? refund.signature : undefined,
          refundedLamports: refund.ok ? refund.refundedLamports : undefined,
          refundError: refund.ok ? undefined : refund.error,
        });
      } catch (refundErr) {
        await auditLog("launch_refund_attempt", {
          commitmentId,
          treasuryWalletId: walletId,
          launchWalletId,
          treasuryWallet,
          launchCreatorWallet: creatorWallet,
          fundedLamports,
          payerWallet,
          ok: false,
          refundError: getSafeErrorMessage(refundErr),
        });
      }
    }

    await auditLog("launch_error", { stage, commitmentId, walletId, creatorWallet, payerWallet, launchTxSig, error: msg });
    if (IS_PROD) {
      const publicMsg = status >= 500 ? "Launch failed due to a server error. Please try again." : msg;
      return NextResponse.json({ error: publicMsg }, { status: status });
    }
    return NextResponse.json({ error: msg, stage, commitmentId, walletId, creatorWallet, payerWallet, launchTxSig }, { status: status });
  }
}
