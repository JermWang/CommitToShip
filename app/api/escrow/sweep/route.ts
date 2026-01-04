import { NextResponse } from "next/server";
import { PublicKey, Transaction, SystemProgram } from "@solana/web3.js";

import { isAdminRequestAsync } from "../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { checkRateLimit } from "../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { confirmTransactionSignature, getConnection } from "../../../lib/solana";
import { getClaimableCreatorFeeLamports, buildCollectCreatorFeeInstruction } from "../../../lib/pumpfun";
import { releasePumpfunCreatorFeeClaimLock, tryAcquirePumpfunCreatorFeeClaimLock } from "../../../lib/pumpfunClaimLock";
import { privySignAndSendSolanaTransaction } from "../../../lib/privy";
import { getCommitment, listCommitments, updateRewardTotalsAndMilestones, getEscrowSignerRef } from "../../../lib/escrowStore";
import { auditLog } from "../../../lib/auditLog";

export const runtime = "nodejs";

const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // mainnet

const CREATOR_FEE_SWEEP_KEEP_LAMPORTS = (() => {
  const raw = Number(process.env.CTS_CREATOR_FEE_SWEEP_KEEP_LAMPORTS ?? "");
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 25_000;
})();

function isCronAuthorized(req: Request): boolean {
  const secret = String(process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = String(req.headers.get("x-cron-secret") ?? "").trim();
  if (!header) return false;
  return header === secret;
}

async function sweepOne(commitmentId: string): Promise<any> {
  const record = await getCommitment(commitmentId);
  if (!record) return { id: commitmentId, ok: false, error: "Commitment not found" };

  if (record.kind !== "creator_reward") return { id: commitmentId, ok: false, error: "Not a creator reward commitment" };
  if (record.creatorFeeMode !== "managed") return { id: commitmentId, ok: false, error: "Commitment is not in managed mode" };

  const all = await listCommitments();
  const shared = all.filter(
    (c) => c.kind === "creator_reward" && c.creatorFeeMode === "managed" && c.status !== "archived" && c.authority === record.authority
  );
  if (shared.length > 1) {
    return {
      id: commitmentId,
      ok: false,
      status: 409,
      error: "Creator wallet is shared across multiple commitments; sweep is blocked to prevent mixing creator fees",
      creatorPubkey: record.authority,
      sharedCommitmentIds: shared.map((c) => c.id),
    };
  }

  const signerRef = getEscrowSignerRef(record);
  if (signerRef.kind !== "privy") return { id: commitmentId, ok: false, error: "Commitment does not use a Privy-managed wallet" };

  const privyWalletId = signerRef.walletId;
  const connection = getConnection();

  const creatorWallet = new PublicKey(record.authority);
  const escrowPubkey = new PublicKey(record.escrowPubkey);

  const lock = await tryAcquirePumpfunCreatorFeeClaimLock({ creatorPubkey: creatorWallet.toBase58(), maxAgeSeconds: 5 * 60 });
  if (!lock.acquired) {
    return { id: commitmentId, ok: false, status: 409, error: "Sweep already in progress", existing: lock.existing };
  }

  try {
    const { claimableLamports, creatorVault } = await getClaimableCreatorFeeLamports({ connection, creator: creatorWallet });
    if (claimableLamports <= 0) {
      await releasePumpfunCreatorFeeClaimLock({ creatorPubkey: creatorWallet.toBase58() });
      return { id: commitmentId, ok: true, swept: false, claimableLamports: 0 };
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("processed");
    const { ix: claimIx } = buildCollectCreatorFeeInstruction({ creator: creatorWallet });

    const sameWallet = creatorWallet.toBase58() === escrowPubkey.toBase58();
    const transferAmount = sameWallet ? 0 : Math.max(0, claimableLamports - CREATOR_FEE_SWEEP_KEEP_LAMPORTS);

    const tx = new Transaction();
    tx.feePayer = creatorWallet;
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.add(claimIx);
    if (!sameWallet && transferAmount > 0) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: creatorWallet,
          toPubkey: escrowPubkey,
          lamports: transferAmount,
        })
      );
    }

    const txBase64 = tx.serialize({ requireAllSignatures: false }).toString("base64");
    const { signature } = await privySignAndSendSolanaTransaction({ walletId: privyWalletId, caip2: SOLANA_CAIP2, transactionBase64: txBase64 });

    await confirmTransactionSignature({ connection, signature, blockhash, lastValidBlockHeight });

    const delta = sameWallet ? claimableLamports : transferAmount;
    const newTotalFunded = (record.totalFundedLamports ?? 0) + delta;
    await updateRewardTotalsAndMilestones({ id: commitmentId, totalFundedLamports: newTotalFunded });

    await releasePumpfunCreatorFeeClaimLock({ creatorPubkey: creatorWallet.toBase58() });
    return {
      id: commitmentId,
      ok: true,
      swept: true,
      claimedLamports: claimableLamports,
      transferredLamports: transferAmount,
      newTotalFundedLamports: newTotalFunded,
      signature,
      creatorVault: creatorVault.toBase58(),
      escrowPubkey: escrowPubkey.toBase58(),
    };
  } catch (e) {
    await releasePumpfunCreatorFeeClaimLock({ creatorPubkey: creatorWallet.toBase58() });
    throw e;
  }
}

/**
 * POST /api/escrow/sweep
 * 
 * Auto-escrow flow for managed commitments:
 * 1. Check if the commitment uses a Privy-managed creator wallet
 * 2. Check claimable creator fees in the Pump.fun creator vault
 * 3. Claim fees to the creator wallet
 * 4. Transfer claimed fees to the escrow address
 * 5. Update commitment totals
 * 
 * This should be called periodically (cron) or triggered after trades.
 */
export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "escrow:sweep", limit: 30, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const cronOk = isCronAuthorized(req);

    if (!cronOk) {
      verifyAdminOrigin(req);
      const adminOk = await isAdminRequestAsync(req);
      if (!adminOk) {
        await auditLog("escrow_sweep_denied", { reason: "unauthorized" });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const body = (await req.json().catch(() => ({}))) as any;
    const commitmentId = typeof body.commitmentId === "string" ? body.commitmentId.trim() : "";
    const limit = body?.limit != null ? Number(body.limit) : undefined;

    if (!commitmentId && !cronOk) {
      return NextResponse.json({ error: "commitmentId is required" }, { status: 400 });
    }

    if (!commitmentId && cronOk) {
      const all = await listCommitments();
      const targets = all.filter((c) => c.kind === "creator_reward" && c.creatorFeeMode === "managed" && c.status !== "archived");
      const sharedCreatorPubkeys = new Map<string, string[]>();
      for (const c of all) {
        if (c.kind !== "creator_reward") continue;
        if (c.creatorFeeMode !== "managed") continue;
        if (c.status === "archived") continue;
        const key = String(c.authority);
        const arr = sharedCreatorPubkeys.get(key) ?? [];
        arr.push(c.id);
        sharedCreatorPubkeys.set(key, arr);
      }

      const capped = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? targets.slice(0, Math.min(200, Math.floor(limit))) : targets;
      const results: any[] = [];
      const failed: Array<{ id: string; error: string; attempts: number }> = [];
      
      for (const c of capped) {
        const sharedIds = sharedCreatorPubkeys.get(String(c.authority)) ?? [];
        if (sharedIds.length > 1) {
          const msg = "Creator wallet is shared across multiple commitments; sweep is blocked to prevent mixing creator fees";
          results.push({
            id: c.id,
            ok: false,
            status: 409,
            error: msg,
            creatorPubkey: c.authority,
            sharedCommitmentIds: sharedIds,
          });
          failed.push({ id: c.id, error: msg, attempts: 0 });
          continue;
        }

        let attempts = 0;
        const maxAttempts = 2;
        let lastError = "";
        
        while (attempts < maxAttempts) {
          attempts++;
          try {
            const r = await sweepOne(c.id);
            results.push(r);
            break; // Success, exit retry loop
          } catch (e) {
            lastError = getSafeErrorMessage(e);
            if (attempts >= maxAttempts) {
              results.push({ id: c.id, ok: false, error: lastError, attempts });
              failed.push({ id: c.id, error: lastError, attempts });
            } else {
              // Wait before retry
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
        }
      }
      
      // Log failed sweeps for monitoring
      if (failed.length > 0) {
        await auditLog("sweep_batch_failures", { failedCount: failed.length, failed });
      }
      
      return NextResponse.json({ ok: true, swept: results.length, failedCount: failed.length, results });
    }

    const result = await sweepOne(commitmentId);
    if (!result.ok && result.status === 409) {
      return NextResponse.json(result, { status: 409 });
    }
    if (!result.ok && result.error === "Commitment not found") {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Sweep failed" }, { status: 400 });
    }
    return NextResponse.json(result);

  } catch (e) {
    await auditLog("sweep_error", { error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
