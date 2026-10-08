import { PublicKey, VersionedTransaction } from "@solana/web3.js";

import {
  AsdConfigRecord,
  AsdExecutionRecord,
  claimAsdExecutionSlot,
  insertAsdExecution,
  listUnresolvedAsdExecutions,
  releaseAsdExecutionSlot,
  setAsdLastError,
  updateAsdExecution,
} from "./asdStore";
import { getCommitment } from "./escrowStore";
import { jupiterQuote, jupiterSwapTx } from "./jupiter";
import { privySignSolanaTransaction } from "./privy";
import {
  getBalanceLamports,
  getConnection,
  getSignatureOutcome,
  getTokenBalanceForMint,
  isTxDefinitelyNotLanded,
  isTxSendError,
  sendAndConfirmDurable,
  transferLamportsFromPrivyWallet,
} from "./solana";
import { getSafeErrorMessage } from "./safeError";

/**
 * ASD (automated sell-down) executor.
 *
 * Design (README: "sells a capped daily percentage of a creator-funded token vault through Jupiter"):
 *  - On activation each commitment gets a dedicated Privy vault wallet. The CREATOR funds it (asd/fund-tx builds that
 *    transaction for the creator's wallet): the project tokens to sell + a small SOL reserve for network fees. The
 *    vault is the Jupiter `userPublicKey`, so it signs and pays for its own swaps out of that reserve.
 *  - Every run first resolves any swap/forward whose signature was persisted but whose outcome is unknown, then wins
 *    the interval atomically (claimAsdExecutionSlot: a conditional UPDATE ... RETURNING), so overlapping cron calls
 *    can never sell twice in one interval.
 *  - The swap is signed once, its signature persisted BEFORE broadcast (onPrepared), and the same bytes rebroadcast
 *    until confirmed / failed / provably expired (sendAndConfirmDurable).
 *  - SOL proceeds (everything above the reserve) are forwarded to the creator-signed destinationPubkey.
 */

const WSOL_MINT = "So11111111111111111111111111111111111111112";

export function asdSwapsEnabled(): boolean {
  const raw = String(process.env.CTS_ASD_ENABLE_SWAPS ?? process.env.CTS_ASD_ENABLE_TRANSFERS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(String(process.env[name] ?? "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

/** SOL the vault always keeps for swap fees (+ the temporary WSOL account rent). Never forwarded. Default 0.01 SOL. */
export function getAsdVaultSolReserveLamports(): number {
  return intEnv("CTS_ASD_VAULT_SOL_RESERVE_LAMPORTS", 10_000_000, 3_000_000, 1_000_000_000);
}

/** fund-tx tops the vault up to this much SOL (reserve + headroom for the first swaps). */
export function getAsdFundingTargetLamports(): number {
  return getAsdVaultSolReserveLamports() + intEnv("CTS_ASD_FUNDING_HEADROOM_LAMPORTS", 5_000_000, 0, 1_000_000_000);
}

/** Proceeds below this are left in the vault until they add up (saves fees). Default 0.001 SOL. */
export function getAsdMinForwardLamports(): number {
  return intEnv("CTS_ASD_MIN_FORWARD_LAMPORTS", 1_000_000, 5_000, 1_000_000_000);
}

export function computePlannedAmountRaw(input: { vaultBalanceRaw: bigint; dailyPercentBps: number; maxDailyAmountRaw: string | null }): bigint {
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

export type AsdRunResult = {
  commitmentId: string;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  dryRun?: boolean;
  executionId?: string;
  txSig?: string | null;
  plannedAmountRaw?: string;
  outAmountRaw?: string | null;
  forward?: { status: string; txSig?: string | null; lamports?: string | null; reason?: string };
  error?: string;
};

/** Resolves swaps/forwards whose signature is known but whose outcome is not. Returns false while any is still open. */
async function resolveUnresolvedExecutions(commitmentId: string): Promise<boolean> {
  const connection = getConnection();
  const rows = await listUnresolvedAsdExecutions(commitmentId);
  let allResolved = true;
  for (const e of rows) {
    if (e.status === "pending") {
      if (!e.txSig) {
        await updateAsdExecution({ id: e.id, status: "error", error: "Swap was never signed" });
      } else {
        const o = await getSignatureOutcome(connection, e.txSig, e.lastValidBlockHeight ?? null);
        if (o.outcome === "confirmed") {
          await updateAsdExecution({ id: e.id, status: "confirmed", executedAmountRaw: e.plannedAmountRaw, confirmedAtUnix: Math.floor(Date.now() / 1000) });
        } else if (o.outcome === "failed") {
          await updateAsdExecution({ id: e.id, status: "error", error: `Swap failed on-chain: ${JSON.stringify(o.err ?? null)}` });
        } else if (o.outcome === "expired") {
          await updateAsdExecution({ id: e.id, status: "error", error: "Swap expired without landing (nothing sold)" });
        } else {
          allResolved = false;
        }
      }
    }
    if (e.forwardStatus === "pending") {
      if (!e.forwardTxSig) {
        await updateAsdExecution({ id: e.id, forwardStatus: "error" });
      } else {
        const o = await getSignatureOutcome(connection, e.forwardTxSig, e.forwardLastValidBlockHeight ?? null);
        if (o.outcome === "confirmed") await updateAsdExecution({ id: e.id, forwardStatus: "confirmed" });
        else if (o.outcome === "failed" || o.outcome === "expired") await updateAsdExecution({ id: e.id, forwardStatus: "error" });
        else allResolved = false;
      }
    }
  }
  return allResolved;
}

/** Forwards everything above the reserve to the destination; the signature is persisted before broadcast. */
async function forwardProceeds(input: { cfg: AsdConfigRecord; executionId: string }): Promise<AsdRunResult["forward"]> {
  const connection = getConnection();
  const vault = new PublicKey(String(input.cfg.vaultPubkey));
  const destination = new PublicKey(input.cfg.destinationPubkey);
  const balance = await getBalanceLamports(connection, vault);
  const amount = balance - getAsdVaultSolReserveLamports();
  if (amount < getAsdMinForwardLamports()) return { status: "none", reason: "below_min_forward", lamports: "0" };

  try {
    const tx = await transferLamportsFromPrivyWallet({
      connection,
      walletId: String(input.cfg.vaultWalletId),
      fromPubkey: vault,
      to: destination,
      lamports: amount,
      onPrepared: async (info) => {
        await updateAsdExecution({
          id: input.executionId,
          forwardStatus: "pending",
          forwardTxSig: info.signature,
          forwardLastValidBlockHeight: info.lastValidBlockHeight,
          forwardedLamports: String(amount),
        });
        return true;
      },
    });
    await updateAsdExecution({ id: input.executionId, forwardStatus: "confirmed", forwardTxSig: tx.signature, forwardedLamports: String(tx.amountLamports) });
    return { status: "confirmed", txSig: tx.signature, lamports: String(tx.amountLamports) };
  } catch (e) {
    if (isTxDefinitelyNotLanded(e)) {
      await updateAsdExecution({ id: input.executionId, forwardStatus: "error" });
      return { status: "error", reason: getSafeErrorMessage(e) };
    }
    // Uncertain: stays "pending" with its signature; the next run resolves it before forwarding again.
    return { status: "pending", reason: getSafeErrorMessage(e) };
  }
}

/** One ASD run for one commitment (called by the cron/admin route). */
export async function runAsdForCommitment(input: { commitmentId: string; nowUnix: number }): Promise<AsdRunResult> {
  const commitmentId = String(input.commitmentId);
  const nowUnix = Math.floor(input.nowUnix);

  if (!(await resolveUnresolvedExecutions(commitmentId))) {
    return { commitmentId, ok: true, skipped: true, reason: "previous_transaction_unresolved" };
  }

  const claim = await claimAsdExecutionSlot({ commitmentId, nowUnix });
  if (!claim) return { commitmentId, ok: true, skipped: true, reason: "not_due_or_not_active" };
  const cfg = claim.config;
  const giveBack = () => releaseAsdExecutionSlot({ commitmentId, claimedAtUnix: nowUnix, previousLastExecutedAtUnix: claim.previousLastExecutedAtUnix });

  const record = await getCommitment(commitmentId);
  if (!record || record.status === "archived") {
    await setAsdLastError({ commitmentId, lastError: "Commitment missing or archived" });
    return { commitmentId, ok: true, skipped: true, reason: "commitment_missing" };
  }
  const vaultPubkey = String(cfg.vaultPubkey ?? "").trim();
  const vaultWalletId = String(cfg.vaultWalletId ?? "").trim();
  if (!vaultPubkey || !vaultWalletId) {
    await setAsdLastError({ commitmentId, lastError: "Missing vault" });
    return { commitmentId, ok: false, error: "Missing vault" };
  }

  const connection = getConnection();
  const vault = new PublicKey(vaultPubkey);
  const tokenMint = new PublicKey(cfg.tokenMint);
  const destination = new PublicKey(cfg.destinationPubkey);

  let exec: AsdExecutionRecord | null = null;
  let signed = false;
  try {
    const [vaultSol, bal] = await Promise.all([getBalanceLamports(connection, vault), getTokenBalanceForMint({ connection, owner: vault, mint: tokenMint })]);
    const vaultBalanceRaw = bal.amountRaw;
    const planned = computePlannedAmountRaw({ vaultBalanceRaw, dailyPercentBps: cfg.dailyPercentBps, maxDailyAmountRaw: cfg.maxDailyAmountRaw ?? null });

    const base = {
      commitmentId,
      tokenMint: tokenMint.toBase58(),
      runAtUnix: nowUnix,
      vaultPubkey: vault.toBase58(),
      destinationPubkey: destination.toBase58(),
      vaultBalanceRaw: vaultBalanceRaw.toString(),
    };

    if (planned <= 0n) {
      exec = await insertAsdExecution({ ...base, plannedAmountRaw: "0", executedAmountRaw: "0", status: "skipped", txSig: null, error: null });
      const forward = asdSwapsEnabled() ? await forwardProceeds({ cfg, executionId: exec.id }) : undefined;
      await setAsdLastError({ commitmentId, lastError: null });
      return { commitmentId, ok: true, skipped: true, reason: "zero_planned", executionId: exec.id, forward };
    }

    const reserve = getAsdVaultSolReserveLamports();
    if (vaultSol < reserve) {
      const msg = `Vault needs SOL for swap fees: send at least ${(reserve - vaultSol) / 1e9} SOL to ${vault.toBase58()} (see asd/fund-tx)`;
      exec = await insertAsdExecution({ ...base, plannedAmountRaw: planned.toString(), executedAmountRaw: "0", status: "skipped", txSig: null, error: msg });
      await setAsdLastError({ commitmentId, lastError: msg });
      return { commitmentId, ok: true, skipped: true, reason: "vault_needs_sol", executionId: exec.id };
    }

    const quote = await jupiterQuote({ inputMint: tokenMint.toBase58(), outputMint: WSOL_MINT, amount: planned.toString(), slippageBps: cfg.slippageBps });
    const quoteJson = JSON.stringify(quote);
    const outAmountRaw = String(quote.outAmount ?? "");

    if (!asdSwapsEnabled()) {
      exec = await insertAsdExecution({
        ...base,
        plannedAmountRaw: planned.toString(),
        executedAmountRaw: "0",
        status: "dry_run",
        txSig: null,
        outMint: WSOL_MINT,
        outAmountRaw,
        quoteJson,
        error: null,
      });
      await setAsdLastError({ commitmentId, lastError: null });
      return { commitmentId, ok: true, dryRun: true, executionId: exec.id, plannedAmountRaw: planned.toString(), outAmountRaw };
    }

    const built = await jupiterSwapTx({ quoteResponse: quote, userPublicKey: vault.toBase58() });
    const vtx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, "base64"));
    if (!vtx.message.staticAccountKeys[0]?.equals(vault)) throw new Error("Jupiter swap is not paid by the vault");

    const result = await sendAndConfirmDurable({
      connection,
      maxRebuilds: 1,
      sign: async (latest) => {
        // The swap is unsigned; point it at a fresh blockhash so expiry is judged against a known lastValidBlockHeight.
        vtx.message.recentBlockhash = latest.blockhash;
        const expected = Buffer.from(vtx.message.serialize());
        const out = await privySignSolanaTransaction({ walletId: vaultWalletId, transactionBase64: Buffer.from(vtx.serialize()).toString("base64") });
        const raw = Buffer.from(String(out.signedTransactionBase64 ?? ""), "base64");
        const parsed = VersionedTransaction.deserialize(raw);
        if (!Buffer.from(parsed.message.serialize()).equals(expected)) throw new Error("Privy returned a different transaction than the one it was asked to sign");
        return raw;
      },
      onPrepared: async (info) => {
        signed = true;
        if (!exec) {
          exec = await insertAsdExecution({
            ...base,
            plannedAmountRaw: planned.toString(),
            executedAmountRaw: "0",
            status: "pending",
            txSig: info.signature,
            lastValidBlockHeight: info.lastValidBlockHeight,
            outMint: WSOL_MINT,
            outAmountRaw,
            quoteJson,
            error: null,
          });
        } else {
          await updateAsdExecution({ id: exec.id, status: "pending", txSig: info.signature, lastValidBlockHeight: info.lastValidBlockHeight });
        }
        return true;
      },
    });

    const execId = (exec as AsdExecutionRecord | null)?.id as string;
    await updateAsdExecution({ id: execId, status: "confirmed", txSig: result.signature, executedAmountRaw: planned.toString(), confirmedAtUnix: Math.floor(Date.now() / 1000) });
    await setAsdLastError({ commitmentId, lastError: null });

    const forward = await forwardProceeds({ cfg, executionId: execId });
    return { commitmentId, ok: true, executionId: execId, txSig: result.signature, plannedAmountRaw: planned.toString(), outAmountRaw, forward };
  } catch (e) {
    const msg = getSafeErrorMessage(e);
    const execNow = exec as AsdExecutionRecord | null;
    if (isTxSendError(e) && e.code === "TX_UNCERTAIN") {
      // Signed and broadcast but not confirmed yet: keep the interval and the pending row; the next run resolves it.
      await setAsdLastError({ commitmentId, lastError: `Swap pending confirmation: ${msg}` });
      return { commitmentId, ok: false, executionId: execNow?.id, txSig: execNow?.txSig ?? null, error: msg };
    }

    const nothingMoved = !signed || isTxDefinitelyNotLanded(e);
    if (execNow) {
      await updateAsdExecution({ id: execNow.id, status: "error", error: msg });
    } else {
      await insertAsdExecution({
        commitmentId,
        tokenMint: tokenMint.toBase58(),
        runAtUnix: nowUnix,
        plannedAmountRaw: "0",
        executedAmountRaw: "0",
        status: "error",
        txSig: null,
        vaultPubkey: vault.toBase58(),
        destinationPubkey: destination.toBase58(),
        error: msg,
      }).catch(() => null);
    }
    // A run that provably sold nothing gives its interval back so the next cron tick retries; an on-chain failure keeps
    // it (fees were paid) and retries next interval.
    const failedOnChain = isTxSendError(e) && e.code === "TX_FAILED";
    if (nothingMoved && !failedOnChain) await giveBack().catch(() => false);
    await setAsdLastError({ commitmentId, lastError: msg });
    return { commitmentId, ok: false, error: msg };
  }
}
