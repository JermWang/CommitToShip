import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

import { auditLog } from "./auditLog";
import { getClaimableCreatorFeeLamports, buildCollectCreatorFeeInstruction } from "./pumpfun";
import { releasePumpfunCreatorFeeClaimLock, tryAcquirePumpfunCreatorFeeClaimLock } from "./pumpfunClaimLock";
import { privySignSolanaTransaction } from "./privy";
import { getBalanceLamports, getConnection, confirmTransactionSignature, keypairFromBase58Secret, getTokenBalanceForMint } from "./solana";
import { getCommitment, getEscrowSignerRef, listCommitments, updateRewardTotalsAndMilestones } from "./escrowStore";
import { pumpportalBuildCollectCreatorFeeTxBase64 } from "./pumpportal";

const CREATOR_FEE_SWEEP_KEEP_LAMPORTS = (() => {
  const raw = Number(process.env.CTS_CREATOR_FEE_SWEEP_KEEP_LAMPORTS ?? "");
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 25_000;
})();

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function buildCloseTokenAccountIx(input: { tokenAccount: PublicKey; destination: PublicKey; owner: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: input.tokenAccount, isSigner: false, isWritable: true },
      { pubkey: input.destination, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

function getSweepFeePayer(): Keypair {
  const secret = String(process.env.ESCROW_FEE_PAYER_SECRET_KEY ?? "").trim();
  if (!secret) throw new Error("ESCROW_FEE_PAYER_SECRET_KEY is required");
  return keypairFromBase58Secret(secret);
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

  const privyWalletId = signerRef.walletId;
  const connection = getConnection();

  const creatorWallet = new PublicKey(record.authority);
  const escrowPubkey = new PublicKey(record.escrowPubkey);

  const lock = await tryAcquirePumpfunCreatorFeeClaimLock({ creatorPubkey: creatorWallet.toBase58(), maxAgeSeconds: 5 * 60 });
  if (!lock.acquired) {
    return { id: commitmentId, ok: false, status: 409, error: "Sweep already in progress", existing: lock.existing };
  }

  try {
    const feePayer = getSweepFeePayer();
    const feePayerBalanceLamports = await getBalanceLamports(connection, feePayer.publicKey);
    const minFeePayerLamports = 2_000_000; // 0.002 SOL
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

    const sameWallet = creatorWallet.toBase58() === escrowPubkey.toBase58();

    let runningTotalFundedLamports = Number(record.totalFundedLamports ?? 0) || 0;

    let pumpfunSignature: string | null = null;
    let pumpfunClaimedLamports = 0;
    let pumpfunTransferredLamports = 0;
    let pumpfunCreatorVault: string | null = null;

    {
      const { claimableLamports, creatorVault } = await getClaimableCreatorFeeLamports({ connection, creator: creatorWallet });
      pumpfunCreatorVault = creatorVault.toBase58();

      if (claimableLamports > 0) {
        const { ix: claimIx } = buildCollectCreatorFeeInstruction({ creator: creatorWallet });
        const transferAmount = sameWallet ? 0 : Math.max(0, claimableLamports - CREATOR_FEE_SWEEP_KEEP_LAMPORTS);

        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

            const tx = new Transaction();
            tx.feePayer = feePayer.publicKey;
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

            tx.partialSign(feePayer);

            const txBase64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
            const signed = await privySignSolanaTransaction({ walletId: privyWalletId, transactionBase64: txBase64 });

            const raw = Buffer.from(String(signed.signedTransactionBase64), "base64");
            const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "processed", maxRetries: 2 });
            await confirmTransactionSignature({ connection, signature, blockhash, lastValidBlockHeight });

            pumpfunSignature = signature;
            pumpfunClaimedLamports = claimableLamports;
            pumpfunTransferredLamports = transferAmount;

            const delta = sameWallet ? claimableLamports : transferAmount;
            runningTotalFundedLamports += delta;
            await updateRewardTotalsAndMilestones({ id: commitmentId, totalFundedLamports: runningTotalFundedLamports });

            await auditLog("escrow_sweep_ok", {
              commitmentId,
              actor: input.actor?.kind ?? "unknown",
              actorWalletPubkey: input.actor?.walletPubkey ?? null,
              signature,
              claimedLamports: claimableLamports,
              transferredLamports: transferAmount,
              escrowPubkey: escrowPubkey.toBase58(),
              creatorVault: creatorVault.toBase58(),
              attempt,
              source: "pumpfun",
            });

            break;
          } catch (e) {
            const msg = String((e as any)?.message ?? e ?? "");
            const lower = msg.toLowerCase();
            const retryable =
              (lower.includes("blockhash") && (lower.includes("expired") || lower.includes("not found"))) ||
              lower.includes("block height exceeded") ||
              lower.includes("blockheight exceeded") ||
              lower.includes("timed out") ||
              lower.includes("timeout");
            if (!retryable || attempt >= 2) throw e;
            await new Promise((r) => setTimeout(r, 350 + attempt * 450));
          }
        }
      }
    }

    let pumpportalSignature: string | null = null;
    let pumpportalFundedForFeesLamports = 0;
    let pumpportalNetNewSolLamports = 0;
    let pumpportalEscrowDeltaLamports = 0;
    let pumpportalError: string | null = null;
    let wsolBeforeUiAmount: number | null = null;
    let wsolAfterUiAmount: number | null = null;

    try {
      const escrowBefore = await getBalanceLamports(connection, escrowPubkey);
      const solBefore = await getBalanceLamports(connection, creatorWallet);
      const wsolBefore = await getTokenBalanceForMint({ connection, owner: creatorWallet, mint: WSOL_MINT });
      wsolBeforeUiAmount = wsolBefore.uiAmount;

      const minCreatorLamportsForFees = 5_000_000;
      if (solBefore < minCreatorLamportsForFees) {
        const topup = minCreatorLamportsForFees - solBefore;
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const tx = new Transaction();
        tx.feePayer = feePayer.publicKey;
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.add(SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: creatorWallet, lamports: topup }));
        tx.partialSign(feePayer);

        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "processed", maxRetries: 2 });
        await confirmTransactionSignature({ connection, signature: sig, blockhash, lastValidBlockHeight });
        pumpportalFundedForFeesLamports = topup;
      }

      const solBaseline = await getBalanceLamports(connection, creatorWallet);

      const built = await pumpportalBuildCollectCreatorFeeTxBase64({ publicKey: creatorWallet.toBase58(), priorityFee: 0.000001 });

      const signed = await privySignSolanaTransaction({ walletId: privyWalletId, transactionBase64: built.txBase64 });
      const raw = Buffer.from(String(signed.signedTransactionBase64), "base64");
      const sig = await connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "processed", maxRetries: 2 });
      await confirmTransactionSignature({ connection, signature: sig, blockhash: "", lastValidBlockHeight: 0 });

      pumpportalSignature = sig;

      const solAfter = await getBalanceLamports(connection, creatorWallet);
      const wsolAfter = await getTokenBalanceForMint({ connection, owner: creatorWallet, mint: WSOL_MINT });
      wsolAfterUiAmount = wsolAfter.uiAmount;

      const solDelta = solAfter - solBaseline;
      pumpportalNetNewSolLamports = Math.max(0, solDelta);

      try {
        for (let batch = 0; batch < 6; batch++) {
            const c = "confirmed" as const;
            const res = await connection.getParsedTokenAccountsByOwner(creatorWallet, { mint: WSOL_MINT }, c);
            const tokenAccountsToClose: PublicKey[] = [];
            for (const a of res.value) {
              const parsed: any = a.account?.data?.parsed;
              const info = parsed?.info;
              const isNative = info?.isNative;
              const amountStr = info?.tokenAmount?.amount;
              const amount = typeof amountStr === "string" ? Number(amountStr) : 0;

              if (!isNative) continue;
              if (!Number.isFinite(amount) || amount <= 0) continue;

              tokenAccountsToClose.push(a.pubkey);
            }

            if (!tokenAccountsToClose.length) break;

            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
            const tx = new Transaction();
            tx.feePayer = feePayer.publicKey;
            tx.recentBlockhash = blockhash;
            tx.lastValidBlockHeight = lastValidBlockHeight;
            for (const ta of tokenAccountsToClose.slice(0, 3)) {
              tx.add(buildCloseTokenAccountIx({ tokenAccount: ta, destination: escrowPubkey, owner: creatorWallet }));
            }
            tx.partialSign(feePayer);

            const txBase64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
            const signedClose = await privySignSolanaTransaction({ walletId: privyWalletId, transactionBase64: txBase64 });
            const rawClose = Buffer.from(String(signedClose.signedTransactionBase64), "base64");
            const sigClose = await connection.sendRawTransaction(rawClose, { skipPreflight: false, preflightCommitment: "processed", maxRetries: 2 });
            await confirmTransactionSignature({ connection, signature: sigClose, blockhash, lastValidBlockHeight });
        }
      } catch (e) {
        void e;
      }

      const escrowAfter = await getBalanceLamports(connection, escrowPubkey);
      pumpportalEscrowDeltaLamports = Math.max(0, escrowAfter - escrowBefore);
      const netCreatorFeeLamports = pumpportalEscrowDeltaLamports;
      if (netCreatorFeeLamports > 0) {
        runningTotalFundedLamports += netCreatorFeeLamports;
        await updateRewardTotalsAndMilestones({ id: commitmentId, totalFundedLamports: runningTotalFundedLamports });
      }
    } catch (e) {
      pumpportalError = String((e as any)?.message ?? e ?? "PumpPortal claim failed");
    }

    const newTotalFundedLamports = runningTotalFundedLamports;

    return {
      id: commitmentId,
      ok: true,
      swept: Boolean(pumpfunSignature || pumpportalSignature),
      newTotalFundedLamports,
      pumpfun: {
        signature: pumpfunSignature,
        claimedLamports: pumpfunClaimedLamports,
        transferredLamports: pumpfunTransferredLamports,
        creatorVault: pumpfunCreatorVault,
      },
      pumpportal: {
        signature: pumpportalSignature,
        netNewSolLamports: pumpportalNetNewSolLamports,
        escrowDeltaLamports: pumpportalEscrowDeltaLamports,
        fundedForFeesLamports: pumpportalFundedForFeesLamports,
        error: pumpportalError,
        wsolBeforeUiAmount,
        wsolAfterUiAmount,
      },
      escrowPubkey: escrowPubkey.toBase58(),
    };
  } catch (e) {
    return { id: commitmentId, ok: false, status: 500, error: String((e as any)?.message ?? e ?? "Sweep failed") };
  } finally {
    try {
      await releasePumpfunCreatorFeeClaimLock({ creatorPubkey: creatorWallet.toBase58() });
    } catch {
      // ignore
    }
  }
}
