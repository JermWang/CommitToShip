import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import { auditLog } from "./auditLog";
import { getClaimableCreatorFeeLamports, buildCollectCreatorFeeInstruction } from "./pumpfun";
import {
  releasePumpfunCreatorFeeClaimLock,
  setPumpfunCreatorFeeClaimLockTxSig,
  tryAcquirePumpfunCreatorFeeClaimLock,
} from "./pumpfunClaimLock";
import {
  buildCloseTokenAccountInstruction,
  buildCreateAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
  getBalanceLamports,
  getConnection,
  getRentExemptMinLamports,
  getSignatureOutcome,
  isTxSendError,
  keypairFromBase58Secret,
  signAndSendInstructions,
} from "./solana";
import type { OnPreparedHook, PayoutSigner } from "./solana";
import { getCommitment, getEscrowSignerRef, listCommitments, updateRewardTotalsAndMilestones } from "./escrowStore";
import { recordSweepAccounting } from "./payoutClaimStore";
import { withRetry } from "./rpc";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// PumpSwap (pump_amm) - post-migration creator fees accrue as WSOL in a vault owned by a per-creator PDA.
export const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const AMM_COLLECT_COIN_CREATOR_FEE_DISCRIMINATOR = Buffer.from([160, 57, 89, 42, 181, 139, 43, 66]);
const AMM_CREATOR_VAULT_SEED = Buffer.from("creator_vault");
const EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");

/** Sweep transactions recorded under the lock: a stale lock is only taken over once its transaction is settled. */
const SWEEP_LOCK_MAX_AGE_SECONDS = 10 * 60;

export function getPumpAmmCreatorVaultAuthorityPda(creator: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([AMM_CREATOR_VAULT_SEED, creator.toBuffer()], PUMP_AMM_PROGRAM_ID);
  return pda;
}

export function getPumpAmmEventAuthorityPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], PUMP_AMM_PROGRAM_ID);
  return pda;
}

/** WSOL token account (ATA of the vault-authority PDA) holding a creator's PumpSwap fees. */
export function getPumpAmmCreatorVaultWsolAta(creator: PublicKey): PublicKey {
  const vaultAuthority = getPumpAmmCreatorVaultAuthorityPda(creator);
  const [ata] = PublicKey.findProgramAddressSync([vaultAuthority.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), WSOL_MINT.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
  return ata;
}

/**
 * PumpSwap `collect_coin_creator_fee` (IDL account order): quote_mint, quote_token_program, coin_creator (signer),
 * coin_creator_vault_authority, coin_creator_vault_ata (w), coin_creator_token_account (w), event_authority, program.
 */
export function buildCollectCoinCreatorFeeInstruction(input: { creator: PublicKey; destinationWsolAta: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: input.creator, isSigner: true, isWritable: false },
      { pubkey: getPumpAmmCreatorVaultAuthorityPda(input.creator), isSigner: false, isWritable: false },
      { pubkey: getPumpAmmCreatorVaultWsolAta(input.creator), isSigner: false, isWritable: true },
      { pubkey: input.destinationWsolAta, isSigner: false, isWritable: true },
      { pubkey: getPumpAmmEventAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: AMM_COLLECT_COIN_CREATOR_FEE_DISCRIMINATOR,
  });
}

/** Raw WSOL amount sitting in the creator's PumpSwap fee vault (0 when the vault doesn't exist). */
export async function getClaimablePumpAmmCreatorFeeLamports(input: { connection: Connection; creator: PublicKey }): Promise<{ vaultAta: PublicKey; claimableLamports: number }> {
  const vaultAta = getPumpAmmCreatorVaultWsolAta(input.creator);
  const info = await withRetry(() => input.connection.getAccountInfo(vaultAta, "confirmed"));
  if (!info || info.data.length < 72 || !info.owner.equals(TOKEN_PROGRAM_ID)) return { vaultAta, claimableLamports: 0 };
  const amount = info.data.readBigUInt64LE(64);
  return { vaultAta, claimableLamports: Number(amount) };
}

/**
 * Instructions that move a creator's PumpSwap fees to `escrow` (which must be the creator wallet itself):
 * create the creator's WSOL ATA (fee payer funds rent), collect into it, close it to the escrow (unwraps to SOL), and
 * refund the ATA rent to the fee payer when we created the ATA - so the escrow's balance grows by exactly the fees.
 */
export function buildPumpAmmSweepInstructions(input: {
  creator: PublicKey;
  feePayer: PublicKey;
  ataExisted: boolean;
  ataRentLamports: number;
}): TransactionInstruction[] {
  const { ix: createIx, ata } = buildCreateAssociatedTokenAccountIdempotentInstruction({ payer: input.feePayer, owner: input.creator, mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM_ID });
  const ixs = [
    createIx,
    buildCollectCoinCreatorFeeInstruction({ creator: input.creator, destinationWsolAta: ata }),
    buildCloseTokenAccountInstruction({ tokenAccount: ata, destination: input.creator, owner: input.creator }),
  ];
  if (!input.ataExisted && input.ataRentLamports > 0) {
    ixs.push(SystemProgram.transfer({ fromPubkey: input.creator, toPubkey: input.feePayer, lamports: input.ataRentLamports }));
  }
  return ixs;
}

function getSweepFeePayer(): Keypair {
  const secret = String(process.env.ESCROW_FEE_PAYER_SECRET_KEY ?? "").trim();
  if (!secret) throw new Error("ESCROW_FEE_PAYER_SECRET_KEY is required");
  return keypairFromBase58Secret(secret);
}

/**
 * Exact lamports a confirmed sweep transaction added to the escrow (post − pre balance in the transaction meta).
 * Returns null when the transaction can't be read yet.
 */
export async function getEscrowDeltaFromTransaction(input: { connection: Connection; signature: string; escrow: PublicKey }): Promise<number | null> {
  for (let i = 0; i < 4; i++) {
    const tx = await withRetry(() => input.connection.getTransaction(input.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).catch(() => null);
    if (tx?.meta) {
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
      for (let k = 0; k < keys.length; k++) {
        if (keys.get(k)?.equals(input.escrow)) return Number(tx.meta.postBalances[k]) - Number(tx.meta.preBalances[k]);
      }
      return 0;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/** Adds a confirmed sweep's escrow delta to totalFundedLamports exactly once (ledger keyed by signature). */
async function accountSweep(input: { connection: Connection; commitmentId: string; signature: string; escrow: PublicKey; source: string }): Promise<{ accounted: boolean; lamports: number | null }> {
  const delta = await getEscrowDeltaFromTransaction({ connection: input.connection, signature: input.signature, escrow: input.escrow });
  if (delta == null) return { accounted: false, lamports: null };
  const lamports = Math.max(0, delta);
  const first = await recordSweepAccounting({ signature: input.signature, commitmentId: input.commitmentId, source: input.source, lamports });
  if (first && lamports > 0) {
    const latest = await getCommitment(input.commitmentId);
    const current = Number(latest?.totalFundedLamports ?? 0) || 0;
    await updateRewardTotalsAndMilestones({ id: input.commitmentId, totalFundedLamports: current + lamports });
  }
  return { accounted: true, lamports };
}

export async function sweepManagedCreatorFeesToEscrow(input: { commitmentId: string; actor?: { kind: "cron" | "admin" | "creator"; walletPubkey?: string } }): Promise<any> {
  const commitmentId = String(input.commitmentId ?? "").trim();
  if (!commitmentId) return { id: commitmentId, ok: false, error: "commitmentId required" };

  const record = await getCommitment(commitmentId);
  if (!record) return { id: commitmentId, ok: false, error: "Commitment not found" };

  if (record.kind !== "creator_reward") return { id: commitmentId, ok: false, error: "Not a creator reward commitment" };
  if (record.creatorFeeMode !== "managed") return { id: commitmentId, ok: false, error: "Commitment is not in managed mode" };
  if (record.status === "archived") return { id: commitmentId, ok: false, status: 404, error: "Commitment not found" };

  const all = await listCommitments();
  const shared = all.filter((c) => c.kind === "creator_reward" && c.creatorFeeMode === "managed" && c.status !== "archived" && c.authority === record.authority);
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

  const creatorWallet = new PublicKey(record.authority);
  const escrowPubkey = new PublicKey(record.escrowPubkey);
  if (!creatorWallet.equals(escrowPubkey)) {
    // The server can only sign for the escrow's own Privy wallet; fees owned by another wallet can't be collected here.
    return {
      id: commitmentId,
      ok: false,
      status: 409,
      error: "Managed sweeps require the creator wallet to be the escrow wallet",
      creatorPubkey: creatorWallet.toBase58(),
      escrowPubkey: escrowPubkey.toBase58(),
    };
  }

  const connection = getConnection();
  const creatorKey = creatorWallet.toBase58();

  // A stale lock is only taken over when its recorded sweep transaction is settled; a landed one is accounted first.
  const lock = await tryAcquirePumpfunCreatorFeeClaimLock({
    creatorPubkey: creatorKey,
    maxAgeSeconds: SWEEP_LOCK_MAX_AGE_SECONDS,
    canTakeOver: async (existing) => {
      if (!existing.txSig) return true;
      const o = await getSignatureOutcome(connection, existing.txSig, existing.pendingLvbh ?? null);
      if (o.outcome === "failed" || o.outcome === "expired") return true;
      if (o.outcome !== "confirmed") return false;
      const acc = await accountSweep({ connection, commitmentId, signature: existing.txSig, escrow: escrowPubkey, source: "recovered" });
      return acc.accounted;
    },
  });
  if (!lock.acquired) {
    return { id: commitmentId, ok: false, status: 409, error: "Sweep already in progress", existing: lock.existing };
  }

  const token = lock.token;
  let lastLockSig: string | null = null;
  let keepPendingSig = false;
  const lockRecorder: OnPreparedHook = async (info) => {
    const ok = await setPumpfunCreatorFeeClaimLockTxSig({
      creatorPubkey: creatorKey,
      token,
      txSig: info.signature,
      lastValidBlockHeight: info.lastValidBlockHeight,
      previousTxSig: info.previousSignature ?? lastLockSig,
    });
    if (ok) lastLockSig = info.signature;
    return ok;
  };

  try {
    const feePayer = getSweepFeePayer();
    const feePayerBalanceLamports = await getBalanceLamports(connection, feePayer.publicKey);
    const minFeePayerLamports = 5_000_000; // 0.005 SOL: fees + temporary WSOL ATA rent
    if (!Number.isFinite(feePayerBalanceLamports) || feePayerBalanceLamports < minFeePayerLamports) {
      return {
        id: commitmentId,
        ok: false,
        status: 503,
        error: "Escrow fee payer has insufficient SOL balance",
        feePayerPubkey: feePayer.publicKey.toBase58(),
        feePayerBalanceLamports,
        hint: "Top up the fee payer wallet (ESCROW_FEE_PAYER_SECRET_KEY) and retry.",
      };
    }

    const rentMin = await getRentExemptMinLamports(connection, 0);
    const privySigner: PayoutSigner = { kind: "privy", walletId: signerRef.walletId, pubkey: escrowPubkey };
    const feePayerSigner: PayoutSigner = { kind: "keypair", keypair: feePayer };

    const send = async (ixs: TransactionInstruction[], computeUnits?: number) => {
      // Only ask Privy to sign when the escrow is actually a required signer.
      const needsEscrowSig = ixs.some((ix) => ix.keys.some((k) => k.isSigner && k.pubkey.equals(escrowPubkey)));
      return signAndSendInstructions({
        connection,
        signer: needsEscrowSig ? privySigner : feePayerSigner,
        feePayer,
        instructions: ixs,
        computeUnits,
        onPrepared: lockRecorder,
      });
    };

    const describe = (e: unknown) => String((e as any)?.message ?? e ?? "Sweep failed");

    // ---- 1) pump.fun bonding-curve creator vault (SOL)
    const pumpfun: Record<string, unknown> = { signature: null, claimedLamports: 0, transferredLamports: 0, creatorVault: null, error: null };
    try {
      const { claimableLamports, creatorVault } = await getClaimableCreatorFeeLamports({ connection, creator: creatorWallet });
      pumpfun.creatorVault = creatorVault.toBase58();
      if (claimableLamports > 0) {
        const escrowBal = await getBalanceLamports(connection, escrowPubkey);
        if (escrowBal + claimableLamports < rentMin) {
          pumpfun.error = "Claimable fees are below the rent-exempt minimum for the escrow; waiting for more fees";
        } else {
          const { ix } = buildCollectCreatorFeeInstruction({ creator: creatorWallet });
          const { signature } = await send([ix], 60_000);
          pumpfun.signature = signature;
          const acc = await accountSweep({ connection, commitmentId, signature, escrow: escrowPubkey, source: "pumpfun" });
          if (!acc.accounted) keepPendingSig = true;
          pumpfun.claimedLamports = acc.lamports ?? claimableLamports;
          pumpfun.transferredLamports = acc.lamports ?? 0;
          await auditLog("escrow_sweep_ok", { commitmentId, actor: input.actor?.kind ?? "unknown", actorWalletPubkey: input.actor?.walletPubkey ?? null, signature, claimedLamports: acc.lamports, escrowPubkey: escrowPubkey.toBase58(), source: "pumpfun" });
        }
      }
    } catch (e) {
      if (isTxSendError(e) && e.code === "TX_UNCERTAIN") keepPendingSig = true;
      pumpfun.error = describe(e);
      pumpfun.signature = isTxSendError(e) ? e.signature : null;
    }

    // ---- 2) PumpSwap creator vault (WSOL), only after step 1 settled (never stack sweeps on an uncertain one)
    const pumpswap: Record<string, unknown> = { signature: null, claimableLamports: 0, escrowDeltaLamports: 0, error: null };
    if (!keepPendingSig) {
      try {
        const { claimableLamports, vaultAta } = await getClaimablePumpAmmCreatorFeeLamports({ connection, creator: creatorWallet });
        pumpswap.vaultAta = vaultAta.toBase58();
        pumpswap.claimableLamports = claimableLamports;
        if (claimableLamports > 0) {
          const creatorWsolAta = getAssociatedTokenAddress({ owner: creatorWallet, mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM_ID });
          const [ataInfo, ataRentLamports, escrowBal] = await Promise.all([
            withRetry(() => connection.getAccountInfo(creatorWsolAta, "confirmed")),
            getRentExemptMinLamports(connection, 165),
            getBalanceLamports(connection, escrowPubkey),
          ]);
          if (escrowBal + claimableLamports < rentMin) {
            pumpswap.error = "Claimable fees are below the rent-exempt minimum for the escrow; waiting for more fees";
          } else {
            const ixs = buildPumpAmmSweepInstructions({ creator: creatorWallet, feePayer: feePayer.publicKey, ataExisted: Boolean(ataInfo), ataRentLamports });
            const { signature } = await send(ixs);
            pumpswap.signature = signature;
            const acc = await accountSweep({ connection, commitmentId, signature, escrow: escrowPubkey, source: "pumpswap" });
            if (!acc.accounted) keepPendingSig = true;
            pumpswap.escrowDeltaLamports = acc.lamports ?? 0;
            await auditLog("escrow_sweep_ok", { commitmentId, actor: input.actor?.kind ?? "unknown", actorWalletPubkey: input.actor?.walletPubkey ?? null, signature, claimedLamports: acc.lamports, escrowPubkey: escrowPubkey.toBase58(), source: "pumpswap" });
          }
        }
      } catch (e) {
        if (isTxSendError(e) && e.code === "TX_UNCERTAIN") keepPendingSig = true;
        pumpswap.error = describe(e);
        pumpswap.signature = isTxSendError(e) ? e.signature : null;
      }
    }

    const latest = await getCommitment(commitmentId);
    return {
      id: commitmentId,
      ok: true,
      swept: Boolean(pumpfun.signature || pumpswap.signature),
      pending: keepPendingSig,
      newTotalFundedLamports: Number(latest?.totalFundedLamports ?? record.totalFundedLamports ?? 0),
      pumpfun,
      pumpswap,
      escrowPubkey: escrowPubkey.toBase58(),
    };
  } catch (e) {
    const status = Number((e as any)?.status);
    return { id: commitmentId, ok: false, status: Number.isFinite(status) && status >= 400 ? status : 500, error: String((e as any)?.message ?? e ?? "Sweep failed") };
  } finally {
    try {
      // An unsettled (uncertain / unaccounted) sweep transaction stays recorded so the next sweep settles it first.
      await releasePumpfunCreatorFeeClaimLock({ creatorPubkey: creatorKey, token, keepPendingSig });
    } catch {
      // ignore
    }
  }
}
