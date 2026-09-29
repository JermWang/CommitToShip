import { NextResponse } from "next/server";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";

import { checkRateLimit } from "../../../lib/rateLimit";
import { apiError } from "../../../lib/apiError";
import { getConnection } from "../../../lib/solana";
import { getOrCreateLaunchTreasuryWallet } from "../../../lib/launchTreasuryStore";
import { auditLog } from "../../../lib/auditLog";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { authorizeLaunchAccess } from "../../../lib/creatorAuth";
import { validateLaunchInput } from "../../../lib/launchValidation";
import { getLaunchAttempt } from "../../../lib/launchAttemptStore";
import { findManagedCommitmentByAuthority } from "../../../lib/escrowStore";

export const runtime = "nodejs";

export async function GET() {
  const res = NextResponse.json({ error: "Method Not Allowed. Use POST /api/launch/prepare." }, { status: 405 });
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

/**
 * POST /api/launch/prepare
 *
 * Step 1 of the automated launch. Validates the launch form and returns an unsigned SOL transfer that funds
 * the payer's launch wallet. Everything that could make the launch fail (bad input, wallet already used,
 * a launch already running) is rejected HERE, before the user is asked to send any SOL.
 */
export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "launch:prepare", limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    verifyAdminOrigin(req);

    const body = (await req.json().catch(() => null)) as any;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

    const payerWallet = typeof body.payerWallet === "string" ? body.payerWallet.trim() : "";
    const devBuySolParsed = Number(body.devBuySol ?? 0);
    const devBuySol = Number.isFinite(devBuySolParsed) && devBuySolParsed >= 0 ? Math.min(devBuySolParsed, 100) : 0;

    if (!payerWallet) return NextResponse.json({ error: "payerWallet is required" }, { status: 400 });

    let payerPubkey: PublicKey;
    try {
      payerPubkey = new PublicKey(payerWallet);
    } catch {
      return NextResponse.json({ error: "Invalid payer wallet address" }, { status: 400 });
    }

    const denied = await authorizeLaunchAccess(req, { body, payerWallet: payerPubkey.toBase58(), auditEvent: "launch_prepare_denied" });
    if (denied) return NextResponse.json({ error: denied.error, hint: denied.hint }, { status: denied.status });

    // Reject bad input before any SOL moves.
    if (body.launch && typeof body.launch === "object") validateLaunchInput(body.launch);

    const { record: treasury, created } = await getOrCreateLaunchTreasuryWallet({ payerWallet: payerPubkey.toBase58() });
    const treasuryWallet = treasury.treasuryWallet;
    const treasuryPubkey = new PublicKey(treasuryWallet);

    // One managed launch per wallet: tell the user now, not after they have paid.
    const existing = await findManagedCommitmentByAuthority(treasuryPubkey.toBase58());
    if (existing) {
      return NextResponse.json(
        {
          error: "This wallet has already launched a token with Auto-Lock.",
          code: "ALREADY_LAUNCHED",
          existingCommitmentId: existing.id,
          hint: "Connect a different wallet to launch another token, or use Manual Lock for an existing token.",
        },
        { status: 409 }
      );
    }

    const attempt = await getLaunchAttempt(payerPubkey.toBase58());
    if (attempt && (attempt.status === "confirmed" || attempt.status === "onchain_unrecorded")) {
      return NextResponse.json(
        {
          error: "This wallet has already launched a token with Auto-Lock.",
          code: "ALREADY_LAUNCHED",
          tokenMint: attempt.tokenMint,
          hint: "Connect a different wallet to launch another token.",
        },
        { status: 409 }
      );
    }

    const devBuyLamports = Math.floor(devBuySol * 1_000_000_000);
    const requiredLamports = devBuyLamports + 10_000_000;
    const balanceBufferLamports = 50_000;

    const connection = getConnection();
    const rentExemptMinRaw = await connection.getMinimumBalanceForRentExemption(0);
    const rentExemptMin = Number.isFinite(rentExemptMinRaw) && rentExemptMinRaw > 0 ? rentExemptMinRaw : 890_880;
    const currentLamports = await connection.getBalance(treasuryPubkey, "confirmed");
    const missingLamports = Math.max(0, requiredLamports + balanceBufferLamports + rentExemptMin - currentLamports);
    const needsFunding = missingLamports > 0;

    let txBase64: string | null = null;
    let blockhash = "";
    let lastValidBlockHeight = 0;

    if (needsFunding) {
      const latest = await connection.getLatestBlockhash("confirmed");
      blockhash = latest.blockhash;
      lastValidBlockHeight = latest.lastValidBlockHeight;

      const tx = new Transaction();
      tx.feePayer = payerPubkey;
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.add(
        SystemProgram.transfer({
          fromPubkey: payerPubkey,
          toPubkey: treasuryPubkey,
          lamports: missingLamports,
        })
      );

      const txBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      txBase64 = Buffer.from(Uint8Array.from(txBytes)).toString("base64");
    }

    await auditLog("launch_prepare", {
      treasuryWallet,
      payerWallet: payerPubkey.toBase58(),
      requiredLamports,
      currentLamports,
      missingLamports,
      needsFunding,
      createdTreasury: created,
      devBuySol,
    });

    // The Privy wallet id stays server-side; only the public treasury address is returned.
    return NextResponse.json({
      ok: true,
      treasuryWallet,
      payerWallet: payerPubkey.toBase58(),
      requiredLamports,
      currentLamports,
      missingLamports,
      needsFunding,
      txBase64,
      txFormat: txBase64 ? "base64" : null,
      txType: txBase64 ? "fund_treasury_wallet" : null,
      blockhash: blockhash || null,
      lastValidBlockHeight: lastValidBlockHeight || null,
    });
  } catch (e) {
    await auditLog("launch_prepare_error", { error: e instanceof Error ? e.message : String(e) });
    return apiError(e, "launch/prepare");
  }
}
