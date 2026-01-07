import { NextResponse } from "next/server";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";
import nacl from "tweetnacl";

import { auditLog } from "../../../lib/auditLog";
import { checkRateLimit } from "../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { getPool, hasDatabase } from "../../../lib/db";
import { confirmSignatureViaRpc, getServerCommitment, withRetry } from "../../../lib/rpc";
import { privySignSolanaTransaction } from "../../../lib/privy";
import {
  buildCreateAssociatedTokenAccountIdempotentInstruction,
  buildSplTokenTransferInstruction,
  getAssociatedTokenAddress,
  getChainUnixTime,
  getConnection,
  keypairFromBase58Secret,
} from "../../../lib/solana";

export const runtime = "nodejs";

const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey("ComputeBudget111111111111111111111111111111");

function stripComputeBudgetInstructions(tx: Transaction): Transaction {
  const out = new Transaction();
  out.recentBlockhash = tx.recentBlockhash;
  out.lastValidBlockHeight = tx.lastValidBlockHeight;
  out.feePayer = tx.feePayer ?? undefined;
  for (const ix of tx.instructions) {
    if (ix.programId.equals(COMPUTE_BUDGET_PROGRAM_ID)) continue;
    out.add(ix);
  }
  return out;
}

function instructionsEqual(a: TransactionInstruction, b: TransactionInstruction): boolean {
  if (!a.programId.equals(b.programId)) return false;
  if (Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) !== 0) return false;
  if (a.keys.length !== b.keys.length) return false;
  for (let i = 0; i < a.keys.length; i++) {
    const ak = a.keys[i];
    const bk = b.keys[i];
    if (!ak.pubkey.equals(bk.pubkey)) return false;
    if (ak.isSigner !== bk.isSigner) return false;
    if (ak.isWritable !== bk.isWritable) return false;
  }
  return true;
}

function validateClaimTransaction(input: {
  tx: Transaction;
  faucetOwner: PublicKey;
  expectedCreateIx: TransactionInstruction;
  expectedTransferIx: TransactionInstruction;
}):
  | { ok: true }
  | {
      ok: false;
      actualProgramIds: string[];
      expectedProgramIds: string[];
    } {
  const stripped = stripComputeBudgetInstructions(input.tx);
  const ixs = stripped.instructions;

  const transferIdx = ixs.findIndex((ix) => instructionsEqual(ix, input.expectedTransferIx));
  if (transferIdx < 0) {
    return {
      ok: false,
      actualProgramIds: ixs.map((ix) => ix.programId.toBase58()),
      expectedProgramIds: [input.expectedCreateIx.programId.toBase58(), input.expectedTransferIx.programId.toBase58()],
    };
  }

  const createIdx = ixs.findIndex((ix) => instructionsEqual(ix, input.expectedCreateIx));
  const matched = new Set<number>([transferIdx]);
  if (createIdx >= 0) matched.add(createIdx);

  for (let idx = 0; idx < ixs.length; idx++) {
    if (matched.has(idx)) continue;
    const ix = ixs[idx];
    for (const k of ix.keys) {
      if (k.pubkey.equals(input.faucetOwner)) {
        return {
          ok: false,
          actualProgramIds: ixs.map((t) => t.programId.toBase58()),
          expectedProgramIds: [input.expectedCreateIx.programId.toBase58(), input.expectedTransferIx.programId.toBase58()],
        };
      }
    }
  }

  let faucetSignerUses = 0;
  for (const ix of ixs) {
    for (const k of ix.keys) {
      if (k.isSigner && k.pubkey.equals(input.faucetOwner)) faucetSignerUses++;
    }
  }
  if (faucetSignerUses !== 1) {
    return {
      ok: false,
      actualProgramIds: ixs.map((t) => t.programId.toBase58()),
      expectedProgramIds: [input.expectedCreateIx.programId.toBase58(), input.expectedTransferIx.programId.toBase58()],
    };
  }

  return { ok: true };
}

function isVoteRewardPayoutsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_VOTE_REWARD_PAYOUTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function getPendingClaimTtlSeconds(): number {
  const raw = Number(process.env.CTS_VOTE_REWARD_CLAIM_TTL_SECONDS ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 5 * 60;
}

function getFaucetSigner(input: { faucetOwnerPubkey: PublicKey }): { kind: "privy"; walletId: string; owner: PublicKey } | { kind: "keypair"; keypair: Keypair } {
  const privyWalletId = String(process.env.CTS_VOTE_REWARD_FAUCET_PRIVY_WALLET_ID ?? "").trim();
  if (privyWalletId) {
    return { kind: "privy", walletId: privyWalletId, owner: input.faucetOwnerPubkey };
  }

  const secret = String(process.env.CTS_VOTE_REWARD_FAUCET_OWNER_SECRET_KEY ?? "").trim();
  if (!secret) {
    throw new Error("CTS_VOTE_REWARD_FAUCET_OWNER_SECRET_KEY (or CTS_VOTE_REWARD_FAUCET_PRIVY_WALLET_ID) is required");
  }

  const kp = keypairFromBase58Secret(secret);
  if (!kp.publicKey.equals(input.faucetOwnerPubkey)) {
    throw new Error("Faucet owner secret key does not match CTS_VOTE_REWARD_FAUCET_OWNER_PUBKEY");
  }

  return { kind: "keypair", keypair: kp };
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "vote-reward:claim-all-global", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    if (!isVoteRewardPayoutsEnabled()) {
      return NextResponse.json(
        {
          error: "Vote reward payouts are disabled",
          hint: "Set CTS_ENABLE_VOTE_REWARD_PAYOUTS=1 (or true) to enable vote reward claims.",
        },
        { status: 503 }
      );
    }

    if (!hasDatabase()) {
      return NextResponse.json({ error: "Database is required for claim-all-global" }, { status: 503 });
    }

    const body = (await req.json().catch(() => null)) as any;

    const walletPubkey = typeof body?.walletPubkey === "string" ? body.walletPubkey.trim() : "";
    const action = typeof body?.action === "string" ? body.action.trim() : "prepare";
    const signedTransactionBase64 = typeof body?.signedTransactionBase64 === "string" ? body.signedTransactionBase64.trim() : "";

    if (!walletPubkey) return NextResponse.json({ error: "walletPubkey required" }, { status: 400 });

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);
    const pk = new PublicKey(walletPubkey);

    const ttlSeconds = getPendingClaimTtlSeconds();

    if (action === "finalize") {
      if (!signedTransactionBase64) return NextResponse.json({ error: "signedTransactionBase64 required" }, { status: 400 });

      const tx = Transaction.from(Buffer.from(signedTransactionBase64, "base64"));

      const feePayerStr = tx.feePayer?.toBase58?.() ?? "";
      if (feePayerStr !== walletPubkey) return NextResponse.json({ error: "Transaction fee payer does not match wallet" }, { status: 400 });

      const userSigEntry = tx.signatures.find((s) => s.publicKey.equals(pk));
      const userSigBytes = userSigEntry?.signature ?? null;
      if (!userSigBytes) return NextResponse.json({ error: "Missing user signature" }, { status: 400 });
      const msg = tx.serializeMessage();
      const ok = nacl.sign.detached.verify(new Uint8Array(msg), new Uint8Array(userSigBytes), pk.toBytes());
      if (!ok) return NextResponse.json({ error: "Invalid transaction signature" }, { status: 401 });

      const txSig = bs58.encode(userSigBytes);
      const claimedAtUnix = nowUnix;

      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`vote_reward_claim_wallet:${walletPubkey}`]);

        const pendingAnyRes = await client.query(
          `select distribution_id, claimed_at_unix, tx_sig
           from vote_reward_distribution_claims
           where wallet_pubkey=$1
             and claimed_at_unix is not null
             and (tx_sig is null or tx_sig='')`,
          [walletPubkey]
        );

        const pendingAny = pendingAnyRes.rows ?? [];
        if (pendingAny.length) {
          const staleIds: string[] = [];
          for (const r of pendingAny) {
            const claimedAt = Number(r?.claimed_at_unix);
            const id = String(r?.distribution_id ?? "");
            if (!id) continue;
            if (!Number.isFinite(claimedAt) || claimedAt <= 0) continue;
            if (nowUnix - claimedAt > ttlSeconds) staleIds.push(id);
          }

          if (staleIds.length) {
            await client.query(
              `delete from vote_reward_distribution_claims
               where wallet_pubkey=$1
                 and distribution_id = any($2::text[])
                 and (tx_sig is null or tx_sig='')`,
              [walletPubkey, staleIds]
            );
          }
        }

        const pendingRes = await client.query(
          `select
             c.distribution_id,
             c.amount_raw::text as amount_raw,
             c.claimed_at_unix,
             d.mint_pubkey,
             d.token_program_pubkey,
             d.faucet_owner_pubkey
           from vote_reward_distribution_claims c
           join vote_reward_distributions d on d.id=c.distribution_id
           where c.wallet_pubkey=$1
             and (c.tx_sig is null or c.tx_sig='')`,
          [walletPubkey]
        );

        const pendingRows = pendingRes.rows ?? [];
        if (pendingRows.length) {
          const freshIds: string[] = [];
          for (const r of pendingRows) {
            const claimedAt = Number(r?.claimed_at_unix);
            const id = String(r?.distribution_id ?? "");
            if (!id) continue;
            if (!Number.isFinite(claimedAt) || claimedAt <= 0) continue;
            if (nowUnix - claimedAt <= ttlSeconds) freshIds.push(id);
          }

          if (freshIds.length) {
            let expectedMint = "";
            let expectedTokenProgram = "";
            let expectedFaucetOwner = "";
            let expectedAmountRaw = 0n;
            const pendingIds: string[] = [];

            for (const r of pendingRows) {
              const id = String(r?.distribution_id ?? "").trim();
              if (!id) continue;
              pendingIds.push(id);
              const mp = String(r?.mint_pubkey ?? "").trim();
              const tp = String(r?.token_program_pubkey ?? "").trim();
              const fp = String(r?.faucet_owner_pubkey ?? "").trim();
              if (!expectedMint) expectedMint = mp;
              if (!expectedTokenProgram) expectedTokenProgram = tp;
              if (!expectedFaucetOwner) expectedFaucetOwner = fp;
              if (mp !== expectedMint) throw new Error("Multiple mints in pending claim");
              if (tp !== expectedTokenProgram) throw new Error("Multiple token programs in pending claim");
              if (fp !== expectedFaucetOwner) throw new Error("Multiple faucet owners in pending claim");
              let amt = 0n;
              try {
                amt = BigInt(String(r?.amount_raw ?? "0"));
              } catch {
                amt = 0n;
              }
              if (amt > 0n) expectedAmountRaw += amt;
            }

            const faucetOwner = new PublicKey(expectedFaucetOwner);
            const mint = new PublicKey(expectedMint);
            const tokenProgram = new PublicKey(expectedTokenProgram);

            const expected = new Transaction();
            expected.recentBlockhash = tx.recentBlockhash;
            expected.lastValidBlockHeight = tx.lastValidBlockHeight;
            expected.feePayer = pk;
            const sourceAta = getAssociatedTokenAddress({ owner: faucetOwner, mint, tokenProgram });
            const { ix: createIx, ata: destinationAta } = buildCreateAssociatedTokenAccountIdempotentInstruction({ payer: pk, owner: pk, mint, tokenProgram });
            const transferIx = buildSplTokenTransferInstruction({ sourceAta, destinationAta, owner: faucetOwner, amountRaw: expectedAmountRaw, tokenProgram });
            expected.add(createIx);
            expected.add(transferIx);

            const v = validateClaimTransaction({ tx, faucetOwner, expectedCreateIx: createIx, expectedTransferIx: transferIx });
            if (!v.ok) {
              await client.query("rollback");
              return NextResponse.json(
                {
                  error: "Found pending vote reward claims",
                  hint: "A claim is already in progress. Wait a moment and try again.",
                  actualProgramIds: v.actualProgramIds,
                  expectedProgramIds: v.expectedProgramIds,
                },
                { status: 409 }
              );
            }

            const st = await withRetry(() => connection.getSignatureStatuses([txSig], { searchTransactionHistory: true }));
            const s = (st?.value?.[0] as any) ?? null;
            if (s?.err) {
              await client.query("rollback");
              return NextResponse.json({ error: `Transaction failed: ${JSON.stringify(s.err)}` }, { status: 400 });
            }

            const desired = getServerCommitment() as any;
            const cs = String(s?.confirmationStatus ?? "");
            const satisfied =
              desired === "processed"
                ? cs === "processed" || cs === "confirmed" || cs === "finalized"
                : desired === "confirmed"
                  ? cs === "confirmed" || cs === "finalized"
                  : desired === "finalized"
                    ? cs === "finalized"
                    : cs === String(desired);

            if (!satisfied) {
              await client.query("rollback");
              return NextResponse.json(
                {
                  error: "Found pending vote reward claims",
                  hint: "A claim is already in progress. Wait a moment and try again.",
                },
                { status: 409 }
              );
            }

            await client.query(
              `update vote_reward_distribution_claims
               set tx_sig=$3
               where wallet_pubkey=$1
                 and distribution_id = any($2::text[])
                 and (tx_sig is null or tx_sig='')`,
              [walletPubkey, pendingIds, txSig]
            );

            await client.query("commit");

            await auditLog("vote_reward_claim_all_global_finalize_ok", {
              walletPubkey,
              distributions: pendingIds.length,
              txSig,
            });

            return NextResponse.json({ ok: true, action: "finalize", nowUnix, signature: txSig, distributions: pendingIds.length });
          }
        }

        const res = await client.query(
          `select
            d.id as distribution_id,
            d.commitment_id,
            d.milestone_id,
            d.mint_pubkey,
            d.token_program_pubkey,
            d.faucet_owner_pubkey,
            a.amount_raw::text as alloc_amount_raw,
            c.claimed_at_unix,
            c.tx_sig
           from vote_reward_distribution_allocations a
           join vote_reward_distributions d on d.id=a.distribution_id
           left join vote_reward_distribution_claims c
             on c.distribution_id=a.distribution_id and c.wallet_pubkey=a.wallet_pubkey
           where a.wallet_pubkey=$1
           order by d.created_at_unix asc, d.id asc`,
          [walletPubkey]
        );

        const claimable = (res.rows ?? []).filter((r: any) => r?.claimed_at_unix == null);
        if (!claimable.length) {
          await client.query("commit");
          return NextResponse.json({ ok: true, action: "finalize", nowUnix, claimed: 0, amountRaw: "0", signature: "" });
        }

        let mintPubkey = String(claimable[0]?.mint_pubkey ?? "");
        let tokenProgramPubkey = String(claimable[0]?.token_program_pubkey ?? "");
        let faucetOwnerPubkey = String(claimable[0]?.faucet_owner_pubkey ?? "");

        const insertedDistributionIds: string[] = [];
        const insertedAmountsRaw: string[] = [];
        let totalAmountRaw = 0n;
        for (const r of claimable) {
          if (String(r?.mint_pubkey ?? "") !== mintPubkey) throw new Error("Multiple mints in claim-all-global result");
          if (String(r?.token_program_pubkey ?? "") !== tokenProgramPubkey) throw new Error("Multiple token programs in claim-all-global result");
          if (String(r?.faucet_owner_pubkey ?? "") !== faucetOwnerPubkey) throw new Error("Multiple faucet owners in claim-all-global result");

          let amt = 0n;
          try {
            amt = BigInt(String(r?.alloc_amount_raw ?? "0"));
          } catch {
            amt = 0n;
          }
          if (amt <= 0n) continue;
          insertedDistributionIds.push(String(r.distribution_id));
          insertedAmountsRaw.push(amt.toString());
          totalAmountRaw += amt;
        }

        if (totalAmountRaw <= 0n || insertedDistributionIds.length === 0) {
          await client.query("rollback");
          return NextResponse.json({ error: "No claimable amount" }, { status: 400 });
        }

        const faucetOwner = new PublicKey(faucetOwnerPubkey);
        const mint = new PublicKey(mintPubkey);
        const tokenProgram = new PublicKey(tokenProgramPubkey);

        const expected = new Transaction();
        expected.recentBlockhash = tx.recentBlockhash;
        expected.lastValidBlockHeight = tx.lastValidBlockHeight;
        expected.feePayer = pk;
        const sourceAta = getAssociatedTokenAddress({ owner: faucetOwner, mint, tokenProgram });
        const { ix: createIx, ata: destinationAta } = buildCreateAssociatedTokenAccountIdempotentInstruction({ payer: pk, owner: pk, mint, tokenProgram });
        const transferIx = buildSplTokenTransferInstruction({ sourceAta, destinationAta, owner: faucetOwner, amountRaw: totalAmountRaw, tokenProgram });
        expected.add(createIx);
        expected.add(transferIx);

        const v = validateClaimTransaction({ tx, faucetOwner, expectedCreateIx: createIx, expectedTransferIx: transferIx });
        if (!v.ok) {
          await client.query("rollback");
          return NextResponse.json(
            {
              error: "Signed transaction does not match expected claim",
              hint: "Your wallet may have modified the prepared transaction (e.g. priority fee). Try disabling priority fees and retry.",
              actualProgramIds: v.actualProgramIds,
              expectedProgramIds: v.expectedProgramIds,
            },
            { status: 400 }
          );
        }

        const inserted = await client.query(
          `insert into vote_reward_distribution_claims (distribution_id, wallet_pubkey, claimed_at_unix, amount_raw, tx_sig)
           select t.distribution_id, $3 as wallet_pubkey, $4 as claimed_at_unix, t.amount_raw, '' as tx_sig
           from unnest($1::text[], $2::text[]) as t(distribution_id, amount_raw)
           on conflict (distribution_id, wallet_pubkey) do nothing
           returning distribution_id`,
          [insertedDistributionIds, insertedAmountsRaw, walletPubkey, String(claimedAtUnix)]
        );

        const lockedIds = (inserted.rows ?? []).map((r: any) => String(r?.distribution_id ?? "")).filter(Boolean);
        if (!lockedIds.length) {
          await client.query("rollback");
          return NextResponse.json({ error: "No claimable amount" }, { status: 400 });
        }

        await client.query("commit");

        const signer = getFaucetSigner({ faucetOwnerPubkey: faucetOwner });
        let sendTx = tx;
        try {
          if (signer.kind === "privy") {
            const txBytes = sendTx.serialize({ requireAllSignatures: false, verifySignatures: false });
            const txBase64 = Buffer.from(Uint8Array.from(txBytes)).toString("base64");
            const signed = await privySignSolanaTransaction({ walletId: signer.walletId, transactionBase64: txBase64 });
            sendTx = Transaction.from(Buffer.from(signed.signedTransactionBase64, "base64"));
          } else {
            sendTx.partialSign(signer.keypair);
          }

          const sig = await withRetry(() =>
            connection.sendRawTransaction(sendTx.serialize(), {
              skipPreflight: false,
              preflightCommitment: "processed" as any,
            })
          );

          if (sig !== txSig) {
            throw new Error("Transaction signature mismatch");
          }

          await confirmSignatureViaRpc(connection, sig, getServerCommitment());

          await withRetry(() =>
            getPool().query(
              `update vote_reward_distribution_claims
               set tx_sig=$3
               where wallet_pubkey=$1
                 and distribution_id = any($2::text[])
                 and claimed_at_unix=$4
                 and (tx_sig is null or tx_sig='')`,
              [walletPubkey, lockedIds, sig, String(claimedAtUnix)]
            )
          );

          await auditLog("vote_reward_claim_all_global_finalize_ok", {
            walletPubkey,
            distributions: lockedIds.length,
            txSig: sig,
          });

          return NextResponse.json({ ok: true, action: "finalize", nowUnix, signature: sig, distributions: lockedIds.length, amountRaw: totalAmountRaw.toString() });
        } catch (e) {
          const msg = getSafeErrorMessage(e);
          if (msg.toLowerCase().includes("timeout")) {
            return NextResponse.json(
              {
                error: "Transaction confirmation timeout",
                code: "confirmation_timeout",
                hint: "Your transaction may still confirm. Check your wallet activity and try again later.",
                signature: txSig,
              },
              { status: 202 }
            );
          }

          await withRetry(() =>
            client.query(
              `delete from vote_reward_distribution_claims
               where wallet_pubkey=$1
                 and distribution_id = any($2::text[])
                 and claimed_at_unix=$3
                 and (tx_sig is null or tx_sig='')`,
              [walletPubkey, lockedIds, String(claimedAtUnix)]
            )
          );
          throw e;
        }
      } catch (e) {
        try {
          await client.query("rollback");
        } catch {
        }
        throw e;
      } finally {
        client.release();
      }
    }

    const pool = getPool();
    const client = await pool.connect();

    let insertedDistributionIds: string[] = [];
    let insertedAmountsRaw: string[] = [];
    let totalAmountRaw = 0n;
    let mintPubkey = "";
    let tokenProgramPubkey = "";
    let faucetOwnerPubkey = "";

    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`vote_reward_claim_wallet:${walletPubkey}`]);

      const pendingAnyRes = await client.query(
        `select distribution_id, claimed_at_unix, tx_sig
         from vote_reward_distribution_claims
         where wallet_pubkey=$1
           and claimed_at_unix is not null
           and (tx_sig is null or tx_sig='')`,
        [walletPubkey]
      );

      const pendingAny = pendingAnyRes.rows ?? [];
      if (pendingAny.length) {
        const freshIds: string[] = [];
        for (const r of pendingAny) {
          const claimedAt = Number(r?.claimed_at_unix);
          const id = String(r?.distribution_id ?? "");
          if (!id) continue;
          if (!Number.isFinite(claimedAt) || claimedAt <= 0) continue;
          if (nowUnix - claimedAt <= ttlSeconds) freshIds.push(id);
        }

        if (freshIds.length) {
          await client.query("rollback");
          return NextResponse.json(
            {
              error: "Found pending vote reward claims",
              hint: "A claim is already in progress. Wait a moment and try again.",
            },
            { status: 409 }
          );
        }
      }

      const res = await client.query(
        `select
          d.id as distribution_id,
          d.commitment_id,
          d.milestone_id,
          d.mint_pubkey,
          d.token_program_pubkey,
          d.faucet_owner_pubkey,
          a.amount_raw::text as alloc_amount_raw,
          c.claimed_at_unix,
          c.tx_sig
         from vote_reward_distribution_allocations a
         join vote_reward_distributions d on d.id=a.distribution_id
         left join vote_reward_distribution_claims c
           on c.distribution_id=a.distribution_id and c.wallet_pubkey=a.wallet_pubkey
         where a.wallet_pubkey=$1
         order by d.created_at_unix asc, d.id asc`,
        [walletPubkey]
      );

      const claimable = (res.rows ?? []).filter((r: any) => {
        const claimedAt = r?.claimed_at_unix;
        const txSigRow = String(r?.tx_sig ?? "").trim();
        if (claimedAt == null) return true;
        if (txSigRow) return false;
        const ca = Number(claimedAt);
        if (!Number.isFinite(ca) || ca <= 0) return false;
        return nowUnix - ca > ttlSeconds;
      });
      if (!claimable.length) {
        await client.query("commit");
        return NextResponse.json({ ok: true, action: "prepare", nowUnix, claimed: 0, amountRaw: "0", transfers: [] });
      }

      mintPubkey = String(claimable[0]?.mint_pubkey ?? "");
      tokenProgramPubkey = String(claimable[0]?.token_program_pubkey ?? "");
      faucetOwnerPubkey = String(claimable[0]?.faucet_owner_pubkey ?? "");

      for (const r of claimable) {
        const mintPubkeyRow = String(r?.mint_pubkey ?? "");
        const tokenProgramPubkeyRow = String(r?.token_program_pubkey ?? "");
        const faucetOwnerPubkeyRow = String(r?.faucet_owner_pubkey ?? "");

        if (mintPubkeyRow !== mintPubkey) throw new Error("Multiple mints in claim-all-global result");
        if (tokenProgramPubkeyRow !== tokenProgramPubkey) throw new Error("Multiple token programs in claim-all-global result");
        if (faucetOwnerPubkeyRow !== faucetOwnerPubkey) throw new Error("Multiple faucet owners in claim-all-global result");

        let amt = 0n;
        try {
          amt = BigInt(String(r?.alloc_amount_raw ?? "0"));
        } catch {
          amt = 0n;
        }
        if (amt <= 0n) continue;

        insertedDistributionIds.push(String(r.distribution_id));
        insertedAmountsRaw.push(amt.toString());
        totalAmountRaw += amt;
      }

      if (totalAmountRaw <= 0n || insertedDistributionIds.length === 0) {
        await client.query("rollback");
        return NextResponse.json({ error: "No claimable amount" }, { status: 400 });
      }

      const faucetOwner = new PublicKey(faucetOwnerPubkey);

      const mint = new PublicKey(mintPubkey);
      const tokenProgram = new PublicKey(tokenProgramPubkey);

      const latest = await withRetry(() => connection.getLatestBlockhash("processed"));

      const tx = new Transaction();
      tx.recentBlockhash = latest.blockhash;
      tx.lastValidBlockHeight = latest.lastValidBlockHeight;
      tx.feePayer = pk;

      const sourceAta = getAssociatedTokenAddress({ owner: faucetOwner, mint, tokenProgram });
      const { ix: createIx, ata: destinationAta } = buildCreateAssociatedTokenAccountIdempotentInstruction({ payer: pk, owner: pk, mint, tokenProgram });
      const transferIx = buildSplTokenTransferInstruction({ sourceAta, destinationAta, owner: faucetOwner, amountRaw: totalAmountRaw, tokenProgram });
      tx.add(createIx);
      tx.add(transferIx);

      const c = getServerCommitment();
      const fee = await withRetry(() => connection.getFeeForMessage(tx.compileMessage(), c));
      const feeLamports = fee.value ?? 5000;
      const ataInfo = await withRetry(() => connection.getAccountInfo(destinationAta, c));
      const ataRentLamports = ataInfo ? 0 : await withRetry(() => connection.getMinimumBalanceForRentExemption(165, c));
      const requiredLamports = Math.max(0, Number(feeLamports) + Number(ataRentLamports));
      const balanceLamports = await withRetry(() => connection.getBalance(pk, c));

      if (balanceLamports < requiredLamports) {
        await client.query("rollback");
        return NextResponse.json(
          {
            error: "Insufficient SOL to cover claim transaction fees",
            code: "insufficient_sol",
            balanceLamports,
            requiredLamports,
            hint: "Send SOL to this wallet before claiming, then try again.",
          },
          { status: 409 }
        );
      }

      const txBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const transactionBase64 = Buffer.from(Uint8Array.from(txBytes)).toString("base64");

      await client.query("commit");

      await auditLog("vote_reward_claim_all_global_prepare_ok", {
        walletPubkey,
        distributions: insertedDistributionIds.length,
        amountRaw: totalAmountRaw.toString(),
        requiredLamports,
      });

      return NextResponse.json({
        ok: true,
        action: "prepare",
        nowUnix,
        walletPubkey,
        amountRaw: totalAmountRaw.toString(),
        distributions: insertedDistributionIds.length,
        mintPubkey,
        tokenProgramPubkey,
        faucetOwnerPubkey,
        requiredLamports,
        transactionBase64,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      });
    } catch (e) {
      try {
        await client.query("rollback");
      } catch {
      }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    await auditLog("vote_reward_claim_all_global_error", {
      error: getSafeErrorMessage(e),
    });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
