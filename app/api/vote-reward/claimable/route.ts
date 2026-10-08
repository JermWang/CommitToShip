import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { auditLog } from "../../../lib/auditLog";
import { checkRateLimit } from "../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { getPool, hasDatabase } from "../../../lib/db";
import { ensureEscrowSchema } from "../../../lib/escrowStore";
import { ensureVoteRewardDistributionsForWallet } from "../../../lib/voteRewardDistributions";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "vote-reward:claimable", limit: 30, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    if (!hasDatabase()) {
      return NextResponse.json({ error: "Database is required" }, { status: 503 });
    }

    const body = (await req.json().catch(() => null)) as any;
    const walletPubkey = typeof body?.walletPubkey === "string" ? body.walletPubkey.trim() : "";
    const commitmentId = typeof body?.commitmentId === "string" ? body.commitmentId.trim() : "";

    if (!walletPubkey) return NextResponse.json({ error: "walletPubkey required" }, { status: 400 });
    if (!commitmentId) return NextResponse.json({ error: "commitmentId required" }, { status: 400 });

    try {
      new PublicKey(walletPubkey);
    } catch {
      return NextResponse.json({ error: "Invalid walletPubkey" }, { status: 400 });
    }

    try {
      await ensureVoteRewardDistributionsForWallet({ walletPubkey });
    } catch {
    }

    // These tables are created lazily by escrowStore; never rely on boot-time warm-up.
    await ensureEscrowSchema();
    const pool = getPool();
    const res = await pool.query(
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
         and d.commitment_id=$2
       order by d.created_at_unix asc, d.id asc`,
      [walletPubkey, commitmentId]
    );

    const pending = (res.rows ?? []).filter((r: any) => {
      const claimedAt = r?.claimed_at_unix;
      const txSig = String(r?.tx_sig ?? "");
      return claimedAt != null && (!txSig.trim().length);
    });

    if (pending.length) {
      return NextResponse.json(
        {
          error: "Found pending vote reward claims",
          pending: pending.map((r: any) => ({
            distributionId: String(r.distribution_id),
            commitmentId: String(r.commitment_id),
            milestoneId: String(r.milestone_id),
            amountRaw: String(r.alloc_amount_raw),
            claimedAtUnix: Number(r.claimed_at_unix),
          })),
        },
        { status: 409 }
      );
    }

    const claimable = (res.rows ?? []).filter((r: any) => r?.claimed_at_unix == null);

    if (!claimable.length) {
      return NextResponse.json({ ok: true, commitmentId, walletPubkey, amountRaw: "0", distributions: 0 });
    }

    const mintPubkey = String(claimable[0]?.mint_pubkey ?? "");
    const tokenProgramPubkey = String(claimable[0]?.token_program_pubkey ?? "");
    const faucetOwnerPubkey = String(claimable[0]?.faucet_owner_pubkey ?? "");

    let totalAmountRaw = 0n;
    let distributions = 0;

    for (const r of claimable) {
      if (String(r?.mint_pubkey ?? "") !== mintPubkey) throw new Error("Multiple mints in claimable result");
      if (String(r?.token_program_pubkey ?? "") !== tokenProgramPubkey) throw new Error("Multiple token programs in claimable result");
      if (String(r?.faucet_owner_pubkey ?? "") !== faucetOwnerPubkey) throw new Error("Multiple faucet owners in claimable result");

      let amt = 0n;
      try {
        amt = BigInt(String(r?.alloc_amount_raw ?? "0"));
      } catch {
        amt = 0n;
      }
      if (amt <= 0n) continue;
      totalAmountRaw += amt;
      distributions += 1;
    }

    await auditLog("vote_reward_claimable_ok", {
      commitmentId,
      walletPubkey,
      amountRaw: totalAmountRaw.toString(),
      distributions,
    });

    return NextResponse.json({
      ok: true,
      commitmentId,
      walletPubkey,
      amountRaw: totalAmountRaw.toString(),
      distributions,
      mintPubkey,
      tokenProgramPubkey,
      faucetOwnerPubkey,
    });
  } catch (e) {
    await auditLog("vote_reward_claimable_error", { error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
