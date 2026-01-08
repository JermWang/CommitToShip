import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { isAdminRequestAsync } from "../../../../../lib/adminAuth";
import { verifyAdminOrigin } from "../../../../../lib/adminSession";
import { getAllowedCreatorWallets } from "../../../../../lib/creatorAuth";
import { checkRateLimit } from "../../../../../lib/rateLimit";
import { getSafeErrorMessage } from "../../../../../lib/safeError";
import { getCommitment } from "../../../../../lib/escrowStore";
import { getAsdConfig, setAsdStatus } from "../../../../../lib/asdStore";

export const runtime = "nodejs";

function isPublicLaunchEnabled(): boolean {
  // Public launches enabled by default (closed beta ended)
  const raw = String(process.env.CTS_PUBLIC_LAUNCHES ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

function pauseMessage(input: { commitmentId: string; requestId: string }): string {
  return `Commit To Ship\nASD Pause\nCommitment: ${input.commitmentId}\nRequest: ${input.requestId}`;
}

export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const rl = await checkRateLimit(req, { keyPrefix: "asd:pause", limit: 10, windowSeconds: 60 });
    if (!rl.allowed) {
      const res = NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
      res.headers.set("retry-after", String(rl.retryAfterSeconds));
      return res;
    }

    const commitmentId = String(ctx?.params?.id ?? "").trim();
    if (!commitmentId) return NextResponse.json({ error: "Missing commitment id" }, { status: 400 });

    const record = await getCommitment(commitmentId);
    if (!record || record.status === "archived") return NextResponse.json({ error: "Not found" }, { status: 404 });

    const creatorPubkeyRaw = String(record.creatorPubkey ?? "").trim();
    if (!creatorPubkeyRaw) return NextResponse.json({ error: "Missing creator pubkey" }, { status: 500 });
    const creatorPubkey = new PublicKey(creatorPubkeyRaw).toBase58();

    const cfg = await getAsdConfig(commitmentId);
    if (!cfg) return NextResponse.json({ error: "ASD config not found" }, { status: 404 });

    const body = (await req.json().catch(() => null)) as any;

    const isAdmin = await isAdminRequestAsync(req);
    if (isAdmin) {
      verifyAdminOrigin(req);
    }

    const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
    if (!requestId) return NextResponse.json({ error: "requestId is required" }, { status: 400 });

    const expected = pauseMessage({ commitmentId, requestId });

    if (!isAdmin) {
      if (!isPublicLaunchEnabled()) {
        const allowed = getAllowedCreatorWallets();
        if (!allowed.has(creatorPubkey)) {
          return NextResponse.json(
            { error: "Wallet is not approved for closed beta", hint: "Ask to be added to CTS_CREATOR_WALLET_PUBKEYS." },
            { status: 403 }
          );
        }
      }

      const signatureB58 =
        typeof body?.signatureB58 === "string"
          ? body.signatureB58.trim()
          : typeof body?.signature === "string"
            ? body.signature.trim()
            : "";
      if (!signatureB58) {
        return NextResponse.json({ error: "signature required", message: expected, creatorPubkey }, { status: 400 });
      }

      const providedMessage = typeof body?.message === "string" ? body.message : expected;
      if (providedMessage !== expected) {
        return NextResponse.json({ error: "Invalid message" }, { status: 400 });
      }

      const signature = bs58.decode(signatureB58);
      const creatorPk = new PublicKey(creatorPubkey);
      const ok = nacl.sign.detached.verify(new TextEncoder().encode(expected), signature, creatorPk.toBytes());
      if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const updated = await setAsdStatus({ commitmentId, status: "paused" });

    return NextResponse.json({
      ok: true,
      status: updated.status,
    });
  } catch (e) {
    return NextResponse.json({ error: getSafeErrorMessage(e) }, { status: 500 });
  }
}
