import { NextResponse } from "next/server";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Buffer } from "buffer";

import { checkRateLimit } from "../../../../../../../lib/rateLimit";
import {
  getVoteRewardAllocation,
  getVoteRewardDistribution,
} from "../../../../../../../lib/escrowStore";
import { getPool, hasDatabase } from "../../../../../../../lib/db";
import { confirmSignatureViaRpc, getServerCommitment, withRetry } from "../../../../../../../lib/rpc";
import { privySignSolanaTransaction } from "../../../../../../../lib/privy";
import {
  buildCreateAssociatedTokenAccountIdempotentInstruction,
  buildSplTokenTransferInstruction,
  getAssociatedTokenAddress,
  getChainUnixTime,
  getConnection,
  keypairFromBase58Secret,
} from "../../../../../../../lib/solana";
import { auditLog } from "../../../../../../../lib/auditLog";
import { getSafeErrorMessage } from "../../../../../../../lib/safeError";

export const runtime = "nodejs";

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

export async function POST(req: Request, ctx: { params: { id: string; milestoneId: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "vote-reward:claim", limit: 20, windowSeconds: 60 });
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
      return NextResponse.json({ error: "Database is required for vote reward claim" }, { status: 503 });
    }

    const commitmentId = ctx.params.id;
    const milestoneId = ctx.params.milestoneId;

    const body = (await req.json().catch(() => null)) as any;

    const walletPubkey = typeof body?.walletPubkey === "string" ? body.walletPubkey.trim() : "";
    const action = typeof body?.action === "string" ? body.action.trim() : "prepare";
    const signedTransactionBase64 = typeof body?.signedTransactionBase64 === "string" ? body.signedTransactionBase64.trim() : "";

    if (!walletPubkey) return NextResponse.json({ error: "walletPubkey required" }, { status: 400 });

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);
    const pk = new PublicKey(walletPubkey);

    const ttlSeconds = getPendingClaimTtlSeconds();

    const distribution = await getVoteRewardDistribution({ commitmentId, milestoneId });
    if (!distribution) return NextResponse.json({ error: "No vote reward distribution found" }, { status: 404 });

    const alloc = await getVoteRewardAllocation({ distributionId: distribution.id, walletPubkey });
    if (!alloc) return NextResponse.json({ error: "Not eligible for this distribution" }, { status: 403 });

    const amountRawStr = String(alloc.amountRaw ?? "0");
    let amountRaw = 0n;
    try {
      amountRaw = BigInt(amountRawStr);
    } catch {
      amountRaw = 0n;
    }
    if (amountRaw <= 0n) {
      return NextResponse.json({ error: "No claimable amount" }, { status: 400 });
    }

    const faucetOwner = new PublicKey(distribution.faucetOwnerPubkey);
    const mint = new PublicKey(distribution.mintPubkey);
    const tokenProgram = new PublicKey(distribution.tokenProgramPubkey);

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`vote_reward_claim_wallet:${walletPubkey}`]);

      const pendingAnyRes = await client.query(
        `select distribution_id, claimed_at_unix
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

      const existingRes = await client.query(
        "select claimed_at_unix, amount_raw::text as amount_raw, tx_sig from vote_reward_distribution_claims where distribution_id=$1 and wallet_pubkey=$2",
        [distribution.id, walletPubkey]
      );
      const existingRow = existingRes.rows?.[0];
      if (existingRow) {
        const txSigExisting = String(existingRow?.tx_sig ?? "").trim();
        if (txSigExisting) {
          await client.query("commit");
          return NextResponse.json({
            ok: true,
            idempotent: true,
            action,
            nowUnix,
            signature: txSigExisting,
            amountRaw: amountRaw.toString(),
            distributionId: distribution.id,
          });
        }

        const claimedAt = Number(existingRow?.claimed_at_unix);
        if (Number.isFinite(claimedAt) && claimedAt > 0 && nowUnix - claimedAt <= ttlSeconds) {
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

      if (action === "finalize") {
        if (!signedTransactionBase64) return NextResponse.json({ error: "signedTransactionBase64 required" }, { status: 400 });

        const tx = Transaction.from(Buffer.from(signedTransactionBase64, "base64"));

        const feePayerStr = tx.feePayer?.toBase58?.() ?? "";
        if (feePayerStr !== walletPubkey) {
          await client.query("rollback");
          return NextResponse.json({ error: "Transaction fee payer does not match wallet" }, { status: 400 });
        }

        const userSigEntry = tx.signatures.find((s) => s.publicKey.equals(pk));
        const userSigBytes = userSigEntry?.signature ?? null;
        if (!userSigBytes) {
          await client.query("rollback");
          return NextResponse.json({ error: "Missing user signature" }, { status: 400 });
        }
        const msg = tx.serializeMessage();
        const ok = nacl.sign.detached.verify(new Uint8Array(msg), new Uint8Array(userSigBytes), pk.toBytes());
        if (!ok) {
          await client.query("rollback");
          return NextResponse.json({ error: "Invalid transaction signature" }, { status: 401 });
        }

        const txSig = bs58.encode(userSigBytes);

        const staleBefore = nowUnix - ttlSeconds;
        await client.query(
          `delete from vote_reward_distribution_claims
           where wallet_pubkey=$1
             and claimed_at_unix < $2
             and (tx_sig is null or tx_sig='')`,
          [walletPubkey, String(staleBefore)]
        );

        const expected = new Transaction();
        expected.recentBlockhash = tx.recentBlockhash;
        expected.lastValidBlockHeight = tx.lastValidBlockHeight;
        expected.feePayer = pk;

        const sourceAta = getAssociatedTokenAddress({ owner: faucetOwner, mint, tokenProgram });
        const { ix: createIx, ata: destinationAta } = buildCreateAssociatedTokenAccountIdempotentInstruction({ payer: pk, owner: pk, mint, tokenProgram });
        const transferIx = buildSplTokenTransferInstruction({ sourceAta, destinationAta, owner: faucetOwner, amountRaw, tokenProgram });
        expected.add(createIx);
        expected.add(transferIx);

        const msgA = tx.serializeMessage();
        const msgB = expected.serializeMessage();
        if (Buffer.compare(Buffer.from(msgA), Buffer.from(msgB)) !== 0) {
          await client.query("rollback");
          return NextResponse.json({ error: "Signed transaction does not match expected claim" }, { status: 400 });
        }

        const inserted = await client.query(
          `insert into vote_reward_distribution_claims (distribution_id, wallet_pubkey, claimed_at_unix, amount_raw, tx_sig)
           values ($1,$2,$3,$4,'')
           on conflict (distribution_id, wallet_pubkey) do nothing
           returning distribution_id`,
          [distribution.id, walletPubkey, String(nowUnix), amountRaw.toString()]
        );

        if (!inserted.rows?.[0]) {
          await client.query("rollback");
          return NextResponse.json(
            {
              error: "Found pending vote reward claims",
              hint: "A claim is already in progress. Wait a moment and try again.",
            },
            { status: 409 }
          );
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
              "update vote_reward_distribution_claims set tx_sig=$3 where distribution_id=$1 and wallet_pubkey=$2 and (tx_sig is null or tx_sig='')",
              [distribution.id, walletPubkey, sig]
            )
          );

          await auditLog("vote_reward_claim_ok", {
            commitmentId,
            milestoneId,
            distributionId: distribution.id,
            walletPubkey,
            amountRaw: amountRaw.toString(),
            txSig: sig,
          });

          return NextResponse.json({ ok: true, action: "finalize", nowUnix, signature: sig, amountRaw: amountRaw.toString(), distributionId: distribution.id });
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
            getPool().query(
              "delete from vote_reward_distribution_claims where distribution_id=$1 and wallet_pubkey=$2 and (tx_sig is null or tx_sig='')",
              [distribution.id, walletPubkey]
            )
          );
          throw e;
        }
      }

      const latest = await withRetry(() => connection.getLatestBlockhash("processed"));

      const tx = new Transaction();
      tx.recentBlockhash = latest.blockhash;
      tx.lastValidBlockHeight = latest.lastValidBlockHeight;
      tx.feePayer = pk;

      const sourceAta = getAssociatedTokenAddress({ owner: faucetOwner, mint, tokenProgram });
      const { ix: createIx, ata: destinationAta } = buildCreateAssociatedTokenAccountIdempotentInstruction({ payer: pk, owner: pk, mint, tokenProgram });
      const transferIx = buildSplTokenTransferInstruction({ sourceAta, destinationAta, owner: faucetOwner, amountRaw, tokenProgram });
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

      await auditLog("vote_reward_claim_prepare_ok", {
        commitmentId,
        milestoneId,
        distributionId: distribution.id,
        walletPubkey,
        amountRaw: amountRaw.toString(),
        requiredLamports,
      });

      return NextResponse.json({
        ok: true,
        action: "prepare",
        nowUnix,
        walletPubkey,
        commitmentId,
        milestoneId,
        distributionId: distribution.id,
        amountRaw: amountRaw.toString(),
        mintPubkey: distribution.mintPubkey,
        tokenProgramPubkey: distribution.tokenProgramPubkey,
        faucetOwnerPubkey: distribution.faucetOwnerPubkey,
        requiredLamports,
        transactionBase64,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      });
    } finally {
      // Never hand a connection with an open transaction (or a held advisory lock) back to the pool.
      try {
        await client.query("rollback");
      } catch {
        // connection already unusable
      }
      client.release();
    }
  } catch (e) {
    await auditLog("vote_reward_claim_error", {
      commitmentId: ctx.params.id,
      milestoneId: ctx.params.milestoneId,
      error: getSafeErrorMessage(e),
    });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
