import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { auditLog } from "../../../lib/auditLog";
import { checkRateLimit } from "../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../lib/safeError";
import { getPool, hasDatabase } from "../../../lib/db";
import { ensureEscrowSchema } from "../../../lib/escrowStore";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "vote-reward:history", limit: 30, windowSeconds: 60 });
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
    const limitRaw = Number(body?.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 60;

    if (!walletPubkey) return NextResponse.json({ error: "walletPubkey required" }, { status: 400 });

    try {
      new PublicKey(walletPubkey);
    } catch {
      return NextResponse.json({ error: "Invalid walletPubkey" }, { status: 400 });
    }

    // These tables are created lazily by escrowStore; never rely on boot-time warm-up.
    await ensureEscrowSchema();
    const pool = getPool();
    const res = await pool.query(
      `select
        s.commitment_id,
        s.milestone_id,
        s.vote,
        s.created_at_unix,
        s.project_value_usd,
        c.token_mint,
        c.statement
       from reward_milestone_signals s
       left join commitments c on c.id=s.commitment_id
       where s.signer_pubkey=$1
       order by s.created_at_unix desc
       limit $2`,
      [walletPubkey, String(limit)]
    );

    const rows = (res.rows ?? []).map((r: any) => ({
      commitmentId: String(r.commitment_id),
      milestoneId: String(r.milestone_id),
      vote: String(r.vote),
      createdAtUnix: Number(r.created_at_unix),
      projectValueUsd: Number(r.project_value_usd ?? 0),
      tokenMint: r.token_mint != null ? String(r.token_mint) : null,
      statement: r.statement != null ? String(r.statement) : null,
    }));

    await auditLog("vote_reward_history_ok", { walletPubkey, rows: rows.length });

    return NextResponse.json({ ok: true, walletPubkey, rows });
  } catch (e) {
    await auditLog("vote_reward_history_error", { error: getSafeErrorMessage(e) });
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
