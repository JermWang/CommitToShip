import { NextResponse } from "next/server";
import { Keypair, PublicKey } from "@solana/web3.js";
import crypto from "crypto";

import { checkRateLimit } from "../../lib/rateLimit";
import { getSafeErrorMessage } from "../../lib/safeError";
import { confirmTransactionSignature, getConnection, getBalanceLamports } from "../../lib/solana";
import { privyCreateSolanaWallet, privySignAndSendSolanaTransaction, privyFundWalletFromFeePayer } from "../../lib/privy";
import { buildUnsignedPumpfunCreateV2Tx } from "../../lib/pumpfun";
import { createRewardCommitmentRecord, insertCommitment, getCommitment } from "../../lib/escrowStore";
import { upsertProjectProfile } from "../../lib/projectProfilesStore";
import { auditLog } from "../../lib/auditLog";
import { getAdminCookieName, getAdminSessionWallet, getAllowedAdminWallets, verifyAdminOrigin } from "../../lib/adminSession";

export const runtime = "nodejs";

const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // mainnet

/**
 * POST /api/launch
 * 
 * Automated token launch flow:
 * 1. Creates a Privy-managed wallet (platform-controlled creator wallet)
 * 2. Uploads metadata to IPFS via Pump.fun
 * 3. Launches token on Pump.fun with the platform wallet as creator
 * 4. Creates a commitment record with milestones
 * 5. The platform wallet receives creator fees, which we auto-escrow
 */
export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "launch:post", limit: 5, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    verifyAdminOrigin(req);

    const cookieHeader = String(req.headers.get("cookie") ?? "");
    const hasAdminCookie = cookieHeader.includes(`${getAdminCookieName()}=`);
    const allowed = getAllowedAdminWallets();
    const adminWallet = await getAdminSessionWallet(req);

    if (!adminWallet) {
      await auditLog("admin_launch_denied", { hasAdminCookie });
      return NextResponse.json(
        {
          error: hasAdminCookie
            ? "Admin session not found or expired. Try Admin Sign-In again. If this keeps happening, your server may not have a persistent DATABASE_URL (or is running in mock mode)."
            : "Admin Sign-In required",
        },
        { status: 401 }
      );
    }

    if (!allowed.has(adminWallet)) {
      await auditLog("admin_launch_denied", { adminWallet });
      return NextResponse.json({ error: "Not an allowed admin wallet" }, { status: 401 });
    }

    const body = (await req.json()) as any;

    // Validate required fields
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
    const statement = typeof body.statement === "string" ? body.statement.trim() : "";
    const payoutWallet = typeof body.payoutWallet === "string" ? body.payoutWallet.trim() : "";

    if (!name) return NextResponse.json({ error: "Token name is required" }, { status: 400 });
    if (!symbol) return NextResponse.json({ error: "Token symbol is required" }, { status: 400 });
    if (!imageUrl) return NextResponse.json({ error: "Token image is required" }, { status: 400 });
    if (!payoutWallet) return NextResponse.json({ error: "Payout wallet is required" }, { status: 400 });

    // Validate payout wallet
    let payoutPubkey: PublicKey;
    try {
      payoutPubkey = new PublicKey(payoutWallet);
    } catch {
      return NextResponse.json({ error: "Invalid payout wallet address" }, { status: 400 });
    }

    // Milestones are optional at launch - can be added post-launch from the dashboard
    const milestones: Array<{ id: string; title: string; unlockPercent: number }> = [];

    // Optional social links
    const websiteUrl = typeof body.websiteUrl === "string" ? body.websiteUrl.trim() : "";
    const xUrl = typeof body.xUrl === "string" ? body.xUrl.trim() : "";
    const telegramUrl = typeof body.telegramUrl === "string" ? body.telegramUrl.trim() : "";
    const discordUrl = typeof body.discordUrl === "string" ? body.discordUrl.trim() : "";
    const bannerUrl = typeof body.bannerUrl === "string" ? body.bannerUrl.trim() : "";

    // Dev buy amount (optional, defaults to 0.01 SOL)
    const devBuySol = Number(body.devBuySol ?? 0.01);
    const devBuyLamports = Math.floor(devBuySol * 1_000_000_000);

    // Step 1: Create Privy-managed wallet for the token creator
    const { walletId, address: creatorWalletAddress } = await privyCreateSolanaWallet();
    const creatorPubkey = new PublicKey(creatorWalletAddress);

    // Step 1b: Fund the Privy wallet from fee payer for dev buy + tx fees
    const requiredLamports = devBuyLamports + 10_000_000; // dev buy + ~0.01 SOL for fees
    const fundResult = await privyFundWalletFromFeePayer({
      toPubkey: creatorPubkey,
      lamports: requiredLamports,
    });
    if (!fundResult.ok) {
      await auditLog("launch_funding_failed", { walletId, creatorWallet: creatorWalletAddress, requiredLamports, error: fundResult.error });
      return NextResponse.json({ error: fundResult.error || "Failed to fund creator wallet for launch" }, { status: 500 });
    }

    // Step 2: Upload metadata to IPFS via Pump.fun
    const metadataFormData = new FormData();
    metadataFormData.append("name", name);
    metadataFormData.append("symbol", symbol);
    metadataFormData.append("description", description);
    metadataFormData.append("showName", "true");
    if (websiteUrl) metadataFormData.append("website", websiteUrl);
    if (xUrl) metadataFormData.append("twitter", xUrl);
    if (telegramUrl) metadataFormData.append("telegram", telegramUrl);

    // Fetch image and add to form
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      return NextResponse.json({ error: "Failed to fetch token image" }, { status: 400 });
    }
    const imageBlob = await imageResponse.blob();
    metadataFormData.append("file", imageBlob, "token.png");

    const ipfsResponse = await fetch("https://pump.fun/api/ipfs", {
      method: "POST",
      body: metadataFormData,
    });

    if (!ipfsResponse.ok) {
      const ipfsError = await ipfsResponse.text().catch(() => "Unknown error");
      return NextResponse.json({ error: `Failed to upload metadata: ${ipfsError}` }, { status: 500 });
    }

    const ipfsJson = await ipfsResponse.json();
    const metadataUri = ipfsJson?.metadataUri;
    if (!metadataUri) {
      return NextResponse.json({ error: "Failed to get metadata URI from Pump.fun" }, { status: 500 });
    }

    // Step 3: Generate mint keypair and build transaction
    const connection = getConnection();
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

    // Sign with mint keypair (we control this locally)
    tx.partialSign(mintKeypair);

    // Generate commitment ID early for recovery tracking
    const commitmentId = crypto.randomBytes(16).toString("hex");
    const tokenMintB58 = mintKeypair.publicKey.toBase58();

    // Log launch attempt for orphan recovery - if tx succeeds but DB fails, we can recover
    await auditLog("launch_attempt", {
      commitmentId,
      tokenMint: tokenMintB58,
      creatorWallet: creatorWalletAddress,
      payoutWallet: payoutPubkey.toBase58(),
      walletId,
      name,
      symbol,
    });

    // Step 4: Send transaction via Privy (they sign with the creator wallet)
    const txBase64 = tx.serialize({ requireAllSignatures: false }).toString("base64");
    
    const { signature: launchTxSig } = await privySignAndSendSolanaTransaction({
      walletId,
      caip2: SOLANA_CAIP2,
      transactionBase64: txBase64,
    });

    await confirmTransactionSignature({
      connection,
      signature: launchTxSig,
      blockhash: String(tx.recentBlockhash ?? ""),
      lastValidBlockHeight: Number((tx as any).lastValidBlockHeight ?? 0),
    });

    // Log successful on-chain launch - commitment record creation follows
    await auditLog("launch_onchain_success", {
      commitmentId,
      tokenMint: tokenMintB58,
      launchTxSig,
    });
    const escrowPubkey = creatorPubkey.toBase58();

    const baseRecord = createRewardCommitmentRecord({
      id: commitmentId,
      statement: statement || `Lock creator fees for ${name}. Ship milestones, release on-chain.`,
      creatorPubkey: payoutPubkey.toBase58(), // User's payout wallet
      escrowPubkey,
      escrowSecretKeyB58: `privy:${walletId}`, // Reference to Privy wallet
      milestones,
      tokenMint: mintKeypair.publicKey.toBase58(),
      creatorFeeMode: "managed",
    });

    const record = {
      ...baseRecord,
      authority: creatorPubkey.toBase58(),
      destinationOnFail: payoutPubkey.toBase58(),
    };

    await insertCommitment(record);

    // Step 6: Save project profile with social links and banner
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
      // Log but don't fail the launch - commitment is already created
      await auditLog("launch_profile_save_error", { commitmentId, tokenMint: mintKeypair.publicKey.toBase58(), error: getSafeErrorMessage(profileErr) });
    }

    await auditLog("launch_success", {
      commitmentId,
      tokenMint: mintKeypair.publicKey.toBase58(),
      creatorWallet: creatorWalletAddress,
      payoutWallet: payoutPubkey.toBase58(),
      launchTxSig,
    });

    return NextResponse.json({
      ok: true,
      commitmentId,
      tokenMint: mintKeypair.publicKey.toBase58(),
      creatorWallet: creatorWalletAddress,
      payoutWallet: payoutPubkey.toBase58(),
      bondingCurve: bondingCurve.toBase58(),
      launchTxSig,
      metadataUri,
      escrowPubkey,
    });

  } catch (e) {
    await auditLog("launch_error", { error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
