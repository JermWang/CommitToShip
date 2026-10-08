import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { auditLog } from "../../../lib/auditLog";
import { checkRateLimit } from "../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { getPool, hasDatabase } from "../../../lib/db";
import { ensureEscrowSchema } from "../../../lib/escrowStore";
import { getConnection, verifyTokenExistsOnChain } from "../../../lib/solana";
import { ensureVoteRewardDistributionsForWallet } from "../../../lib/voteRewardDistributions";

export const runtime = "nodejs";

function uiAmountString(amountRaw: bigint, decimals: number): string {
  const d = Math.max(0, Math.min(18, Math.floor(Number(decimals) || 0)));
  if (d === 0) return amountRaw.toString();
  const divisor = 10n ** BigInt(d);
  const whole = amountRaw / divisor;
  const frac = amountRaw % divisor;
  const fracStr = frac.toString().padStart(d, "0").replace(/0+$/, "");
  return fracStr.length ? `${whole.toString()}.${fracStr}` : whole.toString();
}

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "vote-reward:claimable-all", limit: 30, windowSeconds: 60 });
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

    if (!walletPubkey) return NextResponse.json({ error: "walletPubkey required" }, { status: 400 });

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
        c.tx_sig,
        cm.token_mint,
        cm.statement
       from vote_reward_distribution_allocations a
       join vote_reward_distributions d on d.id=a.distribution_id
       left join vote_reward_distribution_claims c
         on c.distribution_id=a.distribution_id and c.wallet_pubkey=a.wallet_pubkey
       left join commitments cm on cm.id=d.commitment_id
       where a.wallet_pubkey=$1
       order by d.created_at_unix asc, d.id asc`,
      [walletPubkey]
    );

    const pending = (res.rows ?? []).filter((r: any) => {
      const claimedAt = r?.claimed_at_unix;
      const txSig = String(r?.tx_sig ?? "");
      return claimedAt != null && !txSig.trim().length;
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
      return NextResponse.json({ ok: true, walletPubkey, amountRaw: "0", commitments: 0, distributions: 0, breakdown: [] });
    }

    const mintPubkey = String(claimable[0]?.mint_pubkey ?? "");
    const tokenProgramPubkey = String(claimable[0]?.token_program_pubkey ?? "");
    const faucetOwnerPubkey = String(claimable[0]?.faucet_owner_pubkey ?? "");
    let decimals = 0;
    try {
      const connection = getConnection();
      const mintInfo = await verifyTokenExistsOnChain({ connection, mint: new PublicKey(mintPubkey) });
      decimals = Number(mintInfo.decimals ?? 0);
      if (!Number.isFinite(decimals) || decimals < 0 || decimals > 18) decimals = 0;
    } catch {
      decimals = 0;
    }

    let totalAmountRaw = 0n;
    let distributions = 0;

    const byCommitment = new Map<
      string,
      {
        commitmentId: string;
        amountRaw: bigint;
        distributions: number;
        mintPubkey: string;
        tokenProgramPubkey: string;
        faucetOwnerPubkey: string;
        tokenMint?: string | null;
        statement?: string | null;
      }
    >();

    for (const r of claimable) {
      let amt = 0n;
      try {
        amt = BigInt(String(r?.alloc_amount_raw ?? "0"));
      } catch {
        amt = 0n;
      }
      if (amt <= 0n) continue;

      const commitmentId = String(r?.commitment_id ?? "");
      if (!commitmentId) continue;

      const mintPubkeyRow = String(r?.mint_pubkey ?? "");
      const tokenProgramPubkeyRow = String(r?.token_program_pubkey ?? "");
      const faucetOwnerPubkeyRow = String(r?.faucet_owner_pubkey ?? "");

      if (mintPubkeyRow !== mintPubkey) throw new Error("Multiple mints in claimable-all result");
      if (tokenProgramPubkeyRow !== tokenProgramPubkey) throw new Error("Multiple token programs in claimable-all result");
      if (faucetOwnerPubkeyRow !== faucetOwnerPubkey) throw new Error("Multiple faucet owners in claimable-all result");

      const entry = byCommitment.get(commitmentId);
      if (!entry) {
        byCommitment.set(commitmentId, {
          commitmentId,
          amountRaw: amt,
          distributions: 1,
          mintPubkey: mintPubkeyRow,
          tokenProgramPubkey: tokenProgramPubkeyRow,
          faucetOwnerPubkey: faucetOwnerPubkeyRow,
          tokenMint: r?.token_mint != null ? String(r.token_mint) : null,
          statement: r?.statement != null ? String(r.statement) : null,
        });
      } else {
        if (entry.mintPubkey !== mintPubkeyRow) throw new Error("Multiple mints in claimable-all result");
        if (entry.tokenProgramPubkey !== tokenProgramPubkeyRow) throw new Error("Multiple token programs in claimable-all result");
        if (entry.faucetOwnerPubkey !== faucetOwnerPubkeyRow) throw new Error("Multiple faucet owners in claimable-all result");
        entry.amountRaw += amt;
        entry.distributions += 1;
      }

      totalAmountRaw += amt;
      distributions += 1;
    }

    const breakdown = Array.from(byCommitment.values()).sort((a, b) => {
      if (a.amountRaw === b.amountRaw) return a.commitmentId.localeCompare(b.commitmentId);
      return a.amountRaw > b.amountRaw ? -1 : 1;
    });

    await auditLog("vote_reward_claimable_all_ok", {
      walletPubkey,
      amountRaw: totalAmountRaw.toString(),
      commitments: breakdown.length,
      distributions,
    });

    return NextResponse.json({
      ok: true,
      walletPubkey,
      amountRaw: totalAmountRaw.toString(),
      decimals,
      uiAmount: uiAmountString(totalAmountRaw, decimals),
      commitments: breakdown.length,
      distributions,
      breakdown: breakdown.map((b) => ({
        commitmentId: b.commitmentId,
        amountRaw: b.amountRaw.toString(),
        uiAmount: uiAmountString(b.amountRaw, decimals),
        distributions: b.distributions,
        mintPubkey: b.mintPubkey,
        tokenProgramPubkey: b.tokenProgramPubkey,
        faucetOwnerPubkey: b.faucetOwnerPubkey,
        tokenMint: b.tokenMint ?? null,
        statement: b.statement ?? null,
      })),
    });
  } catch (e) {
    await auditLog("vote_reward_claimable_all_error", { error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
