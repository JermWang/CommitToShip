import { NextResponse } from "next/server";
import { PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";

import { checkRateLimit } from "../../../../../../../lib/rateLimit";
import { getVoteRewardAllocation, getVoteRewardDistribution } from "../../../../../../../lib/escrowStore";
import { getPool, hasDatabase } from "../../../../../../../lib/db";
import { getChainUnixTime, getConnection, getMintDecimals } from "../../../../../../../lib/solana";
import { auditLog } from "../../../../../../../lib/auditLog";
import { apiError } from "../../../../../../../lib/apiError";
import { getSafeErrorMessage } from "../../../../../../../lib/safeError";
import {
  buildVoteRewardClaimInstructions,
  checkSignedVoteRewardTransaction,
  ensurePayoutClaimSchema,
  insertVoteRewardPendingClaims,
  prepareVoteRewardClaimTransaction,
  resolveVoteRewardWalletPending,
  submitVoteRewardClaim,
} from "../../../../../../../lib/payoutClaimStore";

export const runtime = "nodejs";

function isVoteRewardPayoutsEnabled(): boolean {
  const raw = String(process.env.CTS_ENABLE_VOTE_REWARD_PAYOUTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
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
    if (action !== "prepare" && action !== "finalize") return NextResponse.json({ error: "Invalid action" }, { status: 400 });

    const connection = getConnection();
    const nowUnix = await getChainUnixTime(connection);
    const pk = new PublicKey(walletPubkey);

    let signedTx: Transaction | null = null;
    if (action === "finalize") {
      if (!signedTransactionBase64) return NextResponse.json({ error: "signedTransactionBase64 required" }, { status: 400 });
      try {
        signedTx = Transaction.from(Buffer.from(signedTransactionBase64, "base64"));
      } catch {
        return NextResponse.json({ error: "Invalid transaction encoding" }, { status: 400 });
      }
      if (!signedTx.feePayer || !signedTx.feePayer.equals(pk)) {
        return NextResponse.json({ error: "Transaction fee payer does not match wallet" }, { status: 400 });
      }
    }

    const distribution = await getVoteRewardDistribution({ commitmentId, milestoneId });
    if (!distribution) return NextResponse.json({ error: "No vote reward distribution found" }, { status: 404 });

    const alloc = await getVoteRewardAllocation({ distributionId: distribution.id, walletPubkey });
    if (!alloc) return NextResponse.json({ error: "Not eligible for this distribution" }, { status: 403 });

    let amountRaw = 0n;
    try {
      amountRaw = BigInt(String(alloc.amountRaw ?? "0"));
    } catch {
      amountRaw = 0n;
    }
    if (amountRaw <= 0n) {
      return NextResponse.json({ error: "No claimable amount" }, { status: 400 });
    }

    const faucetOwner = new PublicKey(distribution.faucetOwnerPubkey);
    const mint = new PublicKey(distribution.mintPubkey);
    const tokenProgram = new PublicKey(distribution.tokenProgramPubkey);
    const decimals = await getMintDecimals({ connection, mint });
    const instructions = buildVoteRewardClaimInstructions({ wallet: pk, faucetOwner, mint, tokenProgram, amountRaw, decimals });

    await ensurePayoutClaimSchema();
    const client = await getPool().connect();
    let submit: { tx: Transaction; txSig: string; lvbhBound: number } | null = null;
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`vote_reward_claim_wallet:${walletPubkey}`]);

      // Unpaid claim rows are resolved from the chain (confirmed → paid, failed/expired → released), never by age.
      const pending = await resolveVoteRewardWalletPending(client, connection, walletPubkey);

      const existingRes = await client.query(
        "select tx_sig from vote_reward_distribution_claims where distribution_id=$1 and wallet_pubkey=$2",
        [distribution.id, walletPubkey]
      );
      const txSigExisting = String(existingRes.rows?.[0]?.tx_sig ?? "").trim();
      if (txSigExisting) {
        await client.query("commit");
        return NextResponse.json({ ok: true, idempotent: true, action, nowUnix, signature: txSigExisting, amountRaw: amountRaw.toString(), distributionId: distribution.id });
      }

      if (pending.inFlight.length || pending.legacy.length) {
        await client.query("commit");
        const submittedSig = signedTx?.signatures?.[0]?.signature ? bs58.encode(Uint8Array.from(signedTx.signatures[0].signature)) : null;
        const same = submittedSig ? pending.inFlight.find((p) => p.signature === submittedSig) : null;
        if (same) {
          return NextResponse.json(
            { ok: false, pending: true, code: "confirmation_timeout", error: "Transaction confirmation timeout", signature: same.signature, hint: "Your claim transaction is still pending; try again shortly." },
            { status: 202 }
          );
        }
        return NextResponse.json(
          {
            error: "Found pending vote reward claims",
            hint: pending.legacy.length && !pending.inFlight.length ? "A previous claim has no recorded transaction; contact support." : "A claim is already in progress. Wait a moment and try again.",
          },
          { status: 409 }
        );
      }

      if (action === "prepare") {
        await client.query("commit");
        const prepared = await prepareVoteRewardClaimTransaction({ connection, wallet: pk, instructions });
        if (prepared.balanceLamports < prepared.requiredLamports) {
          return NextResponse.json(
            {
              error: "Insufficient SOL to cover claim transaction fees",
              code: "insufficient_sol",
              balanceLamports: prepared.balanceLamports,
              requiredLamports: prepared.requiredLamports,
              hint: "Send SOL to this wallet before claiming, then try again.",
            },
            { status: 409 }
          );
        }
        await auditLog("vote_reward_claim_prepare_ok", {
          commitmentId,
          milestoneId,
          distributionId: distribution.id,
          walletPubkey,
          amountRaw: amountRaw.toString(),
          requiredLamports: prepared.requiredLamports,
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
          requiredLamports: prepared.requiredLamports,
          transactionBase64: prepared.transactionBase64,
          blockhash: prepared.blockhash,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
        });
      }

      const tx = signedTx as Transaction;
      const check = await checkSignedVoteRewardTransaction({ connection, tx, wallet: pk, expectedInstructions: instructions });
      if (!check.ok) {
        await client.query("commit"); // keep the pending-claim resolution done above
        return NextResponse.json({ error: check.error }, { status: check.status });
      }

      const locked = await insertVoteRewardPendingClaims(client, {
        walletPubkey,
        distributionIds: [distribution.id],
        amountsRaw: [amountRaw.toString()],
        claimedAtUnix: nowUnix,
        txSig: check.txSig,
        lvbhBound: check.lvbhBound,
      });
      if (locked.length !== 1) {
        await client.query("rollback");
        return NextResponse.json({ error: "Found pending vote reward claims", hint: "A claim is already in progress. Wait a moment and try again." }, { status: 409 });
      }
      await client.query("commit");
      submit = { tx, txSig: check.txSig, lvbhBound: check.lvbhBound };
    } finally {
      // Never hand a connection with an open transaction (or a held advisory lock) back to the pool.
      try {
        await client.query("rollback");
      } catch {
        // connection already unusable
      }
      client.release();
    }

    const result = await submitVoteRewardClaim({ connection, tx: submit.tx, faucetOwner, walletPubkey, txSig: submit.txSig, lvbhBound: submit.lvbhBound });
    if (result.status === 200) {
      await auditLog("vote_reward_claim_ok", { commitmentId, milestoneId, distributionId: distribution.id, walletPubkey, amountRaw: amountRaw.toString(), txSig: submit.txSig });
      return NextResponse.json({ ok: true, action: "finalize", nowUnix, signature: submit.txSig, amountRaw: amountRaw.toString(), distributionId: distribution.id });
    }
    return NextResponse.json({ action: "finalize", nowUnix, distributionId: distribution.id, ...result.body }, { status: result.status });
  } catch (e) {
    await auditLog("vote_reward_claim_error", {
      commitmentId: ctx.params.id,
      milestoneId: ctx.params.milestoneId,
      error: getSafeErrorMessage(e),
    }).catch(() => null);
    return apiError(e, "vote-reward/claim");
  }
}
