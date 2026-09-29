import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { auditLog } from "../../../lib/auditLog";
import { isAdminRequestAsync } from "../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../lib/adminSession";
import { checkRateLimit } from "../../../lib/rateLimit";
import { confirmSignatureViaRpc, getServerCommitment, withRetry } from "../../../lib/rpc";
import { getConnection, getTokenBalanceForMint } from "../../../lib/solana";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { getCommitment } from "../../../lib/escrowStore";
import { getAsdConfig, insertAsdExecution, listActiveAsdConfigs, updateAsdAfterExecution } from "../../../lib/asdStore";
import { jupiterQuote, jupiterSwapTx } from "../../../lib/jupiter";
import { privySignSolanaTransaction } from "../../../lib/privy";
import { isCronAuthorized } from "../../../lib/cronAuth";

export const runtime = "nodejs";

function swapsEnabled(): boolean {
  const raw = String(process.env.CTS_ASD_ENABLE_SWAPS ?? process.env.CTS_ASD_ENABLE_TRANSFERS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

const WSOL_MINT = "So11111111111111111111111111111111111111112";

async function sendJupiterSwapViaPrivy(input: {
  connection: ReturnType<typeof getConnection>;
  walletId: string;
  swapTransactionBase64: string;
}): Promise<string> {
  const walletId = String(input.walletId ?? "").trim();
  const swapTransactionBase64 = String(input.swapTransactionBase64 ?? "").trim();
  if (!walletId) throw new Error("walletId is required");
  if (!swapTransactionBase64) throw new Error("swapTransactionBase64 is required");

  const signed = await privySignSolanaTransaction({ walletId, transactionBase64: swapTransactionBase64 });
  const rawSigned = Buffer.from(String(signed.signedTransactionBase64), "base64");

  const sig = await withRetry(() => input.connection.sendRawTransaction(rawSigned, { skipPreflight: false, preflightCommitment: "processed", maxRetries: 3 }));
  const c = getServerCommitment();
  await confirmSignatureViaRpc(input.connection, sig, c);
  return sig;
}

function computePlannedAmountRaw(input: {
  vaultBalanceRaw: bigint;
  dailyPercentBps: number;
  maxDailyAmountRaw: string | null;
}): bigint {
  const pct = BigInt(Math.max(0, Math.min(10_000, Math.floor(Number(input.dailyPercentBps ?? 0)))));
  let amount = (input.vaultBalanceRaw * pct) / 10_000n;
  if (amount <= 0n) return 0n;

  if (input.maxDailyAmountRaw) {
    try {
      const cap = BigInt(input.maxDailyAmountRaw);
      if (cap > 0n && amount > cap) amount = cap;
    } catch {
      return 0n;
    }
  }

  return amount;
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "admin:asd-execute", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const cronOk = isCronAuthorized(req);
    if (!cronOk) {
      verifyAdminOrigin(req);
      if (!(await isAdminRequestAsync(req))) {
        await auditLog("admin_asd_execute_denied", {});
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const body = (await req.json().catch(() => null)) as any;
    const commitmentIdFilter = typeof body?.commitmentId === "string" ? body.commitmentId.trim() : "";
    const limitRaw = body?.limit != null ? Number(body.limit) : undefined;
    const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;

    const connection = getConnection();
    const nowUnix = Math.floor(Date.now() / 1000);

    const targets = commitmentIdFilter ? [] : await listActiveAsdConfigs({ limit });

    const configs = commitmentIdFilter
      ? (() => {
          const c: any[] = [];
          c.push(commitmentIdFilter);
          return c;
        })()
      : targets.map((c) => c.commitmentId);

    const results: any[] = [];

    for (const commitmentId of configs) {
      try {
        const cfg = commitmentIdFilter ? await getAsdConfig(commitmentId) : targets.find((x) => x.commitmentId === commitmentId) ?? null;
        if (!cfg) {
          results.push({ commitmentId, ok: false, error: "ASD config not found" });
          continue;
        }

        if (cfg.status !== "active" || !cfg.activatedAtUnix) {
          results.push({ commitmentId, ok: true, skipped: true, reason: "not_active" });
          continue;
        }

        const record = await getCommitment(commitmentId);
        if (!record || record.status === "archived") {
          results.push({ commitmentId, ok: true, skipped: true, reason: "commitment_missing" });
          continue;
        }

        const vaultPubkeyStr = String(cfg.vaultPubkey ?? "").trim();
        const vaultWalletId = String(cfg.vaultWalletId ?? "").trim();
        if (!vaultPubkeyStr || !vaultWalletId) {
          results.push({ commitmentId, ok: false, error: "Missing vault" });
          continue;
        }

        const tokenMint = new PublicKey(cfg.tokenMint);
        const vault = new PublicKey(vaultPubkeyStr);
        const destination = new PublicKey(cfg.destinationPubkey);

        const since = cfg.lastExecutedAtUnix == null ? 0 : Number(cfg.lastExecutedAtUnix);
        if (since > 0 && nowUnix - since < cfg.minIntervalSeconds) {
          results.push({ commitmentId, ok: true, skipped: true, reason: "min_interval" });
          continue;
        }

        const bal = await getTokenBalanceForMint({ connection, owner: vault, mint: tokenMint });
        const vaultBalanceRaw = bal.amountRaw;

        const planned = computePlannedAmountRaw({
          vaultBalanceRaw,
          dailyPercentBps: cfg.dailyPercentBps,
          maxDailyAmountRaw: cfg.maxDailyAmountRaw ?? null,
        });

        if (planned <= 0n) {
          const exec = await insertAsdExecution({
            commitmentId,
            tokenMint: tokenMint.toBase58(),
            runAtUnix: nowUnix,
            plannedAmountRaw: "0",
            executedAmountRaw: "0",
            status: "skipped",
            txSig: null,
            vaultPubkey: vault.toBase58(),
            destinationPubkey: destination.toBase58(),
            vaultBalanceRaw: vaultBalanceRaw.toString(),
            error: null,
          });
          results.push({ commitmentId, ok: true, skipped: true, reason: "zero_planned", executionId: exec.id });
          continue;
        }

        const quote = await jupiterQuote({
          inputMint: tokenMint.toBase58(),
          outputMint: WSOL_MINT,
          amount: planned.toString(),
          slippageBps: cfg.slippageBps,
        });

        let quoteUsed = quote;
        let quoteJson = JSON.stringify(quoteUsed);
        let outMint = String(quoteUsed.outputMint ?? WSOL_MINT);
        let outAmountRaw = String(quoteUsed.outAmount ?? "");

        if (!swapsEnabled()) {
          const exec = await insertAsdExecution({
            commitmentId,
            tokenMint: tokenMint.toBase58(),
            runAtUnix: nowUnix,
            plannedAmountRaw: planned.toString(),
            executedAmountRaw: "0",
            status: "dry_run",
            txSig: null,
            vaultPubkey: vault.toBase58(),
            destinationPubkey: destination.toBase58(),
            vaultBalanceRaw: vaultBalanceRaw.toString(),
            outMint,
            outAmountRaw,
            quoteJson,
            error: null,
          });
          await updateAsdAfterExecution({ commitmentId, executedAtUnix: nowUnix, lastError: null });
          results.push({ commitmentId, ok: true, dryRun: true, executionId: exec.id, plannedAmountRaw: planned.toString(), outAmountRaw });
          continue;
        }

        let swapTxBase64 = "";
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const built = await jupiterSwapTx({ quoteResponse: quote, userPublicKey: vault.toBase58() });
            swapTxBase64 = built.swapTransaction;
            break;
          } catch (e) {
            if (attempt === 2) throw e;
          }
        }

        if (!swapTxBase64) throw new Error("Failed to build Jupiter swap transaction");

        let txSig = "";
        let sentOk = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            txSig = await sendJupiterSwapViaPrivy({ connection, walletId: vaultWalletId, swapTransactionBase64: swapTxBase64 });
            sentOk = true;
            break;
          } catch (e) {
            const msg = getSafeErrorMessage(e).toLowerCase();
            const isBlockhash = msg.includes("blockhash") || msg.includes("expired") || msg.includes("not found");
            if (!isBlockhash || attempt === 2) throw e;

            quoteUsed = await jupiterQuote({
              inputMint: tokenMint.toBase58(),
              outputMint: WSOL_MINT,
              amount: planned.toString(),
              slippageBps: cfg.slippageBps,
            });

            quoteJson = JSON.stringify(quoteUsed);
            outMint = String(quoteUsed.outputMint ?? WSOL_MINT);
            outAmountRaw = String(quoteUsed.outAmount ?? "");

            const built = await jupiterSwapTx({ quoteResponse: quoteUsed, userPublicKey: vault.toBase58() });
            swapTxBase64 = built.swapTransaction;
          }
        }

        if (!sentOk || !txSig) throw new Error("Swap submission failed");

        const exec = await insertAsdExecution({
          commitmentId,
          tokenMint: tokenMint.toBase58(),
          runAtUnix: nowUnix,
          plannedAmountRaw: planned.toString(),
          executedAmountRaw: planned.toString(),
          status: "sent",
          txSig,
          vaultPubkey: vault.toBase58(),
          destinationPubkey: destination.toBase58(),
          vaultBalanceRaw: vaultBalanceRaw.toString(),
          outMint,
          outAmountRaw,
          quoteJson,
          error: null,
        });

        await updateAsdAfterExecution({ commitmentId, executedAtUnix: nowUnix, lastError: null });

        results.push({ commitmentId, ok: true, executionId: exec.id, txSig, amountInRaw: planned.toString(), outAmountRaw });
      } catch (e) {
        const msg = getSafeErrorMessage(e);
        try {
          await updateAsdAfterExecution({ commitmentId, executedAtUnix: nowUnix, lastError: msg });
        } catch {
        }
        try {
          const cfg = await getAsdConfig(commitmentId);
          const tokenMint = cfg?.tokenMint ? String(cfg.tokenMint) : "";
          const dest = cfg?.destinationPubkey ? String(cfg.destinationPubkey) : "";
          const vaultPubkey = cfg?.vaultPubkey ? String(cfg.vaultPubkey) : null;
          await insertAsdExecution({
            commitmentId,
            tokenMint,
            runAtUnix: nowUnix,
            plannedAmountRaw: "0",
            executedAmountRaw: "0",
            status: "error",
            txSig: null,
            vaultPubkey,
            destinationPubkey: dest,
            vaultBalanceRaw: null,
            outMint: WSOL_MINT,
            outAmountRaw: null,
            quoteJson: null,
            error: msg,
          });
        } catch {
        }
        results.push({ commitmentId, ok: false, error: msg });
      }
    }

    await auditLog("admin_asd_execute_completed", { cron: cronOk, count: results.length, swapsEnabled: swapsEnabled() });

    return NextResponse.json({ ok: true, nowUnix, swapsEnabled: swapsEnabled(), results });
  } catch (e) {
    await auditLog("admin_asd_execute_error", { error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
