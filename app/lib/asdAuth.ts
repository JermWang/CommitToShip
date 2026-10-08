import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { isAdminRequestAsync } from "./adminAuth";
import { verifyAdminOrigin } from "./adminSession";
import { recordAsdRequest } from "./asdStore";
import { getAllowedCreatorWallets } from "./creatorAuth";

/** A signed ASD request is accepted for this long (either direction) around the server clock. */
export const ASD_SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

function isPublicLaunchEnabled(): boolean {
  const raw = String(process.env.CTS_PUBLIC_LAUNCHES ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

export type AsdAuthResult =
  | { ok: true; isAdmin: boolean; requestId: string; timestampUnix: number | null }
  | { ok: false; response: NextResponse };

/**
 * Authorizes a configure/activate/pause/resume request BEFORE anything is written:
 *  - admin session (with Origin check), or
 *  - the creator's signature over `buildMessage(timestampUnix)`, which binds the commitment, the request id, the
 *    action's parameters and a timestamp (+-5 min);
 * and in both cases records the request id as used (replay -> 409). The request id + time are stored (asd_requests,
 * and last_request_* on the config row).
 */
export async function authorizeAsdRequest(input: {
  req: Request;
  body: any;
  commitmentId: string;
  creatorPubkey: string;
  action: "configure" | "activate" | "pause" | "resume";
  buildMessage: (timestampUnix: number) => string;
  extraOnMissingSignature?: Record<string, unknown>;
}): Promise<AsdAuthResult> {
  const { req, body } = input;

  const isAdmin = await isAdminRequestAsync(req);
  if (isAdmin) verifyAdminOrigin(req);

  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  if (!requestId) return { ok: false, response: NextResponse.json({ error: "requestId is required" }, { status: 400 }) };
  if (requestId.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(requestId)) {
    return { ok: false, response: NextResponse.json({ error: "requestId must be 1-80 characters of [A-Za-z0-9._:-]" }, { status: 400 }) };
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  let timestampUnix: number | null = null;

  if (!isAdmin) {
    if (!isPublicLaunchEnabled() && !getAllowedCreatorWallets().has(input.creatorPubkey)) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "This wallet is not approved to launch yet", hint: "Launches are currently limited to approved wallets." },
          { status: 403 }
        ),
      };
    }

    const signatureB58 =
      typeof body?.signatureB58 === "string" ? body.signatureB58.trim() : typeof body?.signature === "string" ? body.signature.trim() : "";
    const ts = Math.floor(Number(body?.timestampUnix));

    if (!signatureB58 || !Number.isFinite(ts) || ts <= 0) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: "signature required",
            hint: "Sign `message` with the creator wallet and send it back with the same timestampUnix.",
            message: input.buildMessage(nowUnix),
            timestampUnix: nowUnix,
            creatorPubkey: input.creatorPubkey,
            ...(input.extraOnMissingSignature ?? {}),
          },
          { status: 400 }
        ),
      };
    }
    if (Math.abs(nowUnix - ts) > ASD_SIGNATURE_MAX_AGE_SECONDS) {
      return { ok: false, response: NextResponse.json({ error: "Signature timestamp expired, sign again", nowUnix }, { status: 400 }) };
    }

    const expected = input.buildMessage(ts);
    const providedMessage = typeof body?.message === "string" ? body.message : expected;
    if (providedMessage !== expected) {
      return { ok: false, response: NextResponse.json({ error: "Invalid message", message: expected }, { status: 400 }) };
    }

    let signature: Uint8Array;
    try {
      signature = bs58.decode(signatureB58);
    } catch {
      signature = new Uint8Array(0);
    }
    if (signature.length !== nacl.sign.signatureLength) {
      return { ok: false, response: NextResponse.json({ error: "Invalid signature encoding" }, { status: 400 }) };
    }
    const ok = nacl.sign.detached.verify(new TextEncoder().encode(expected), signature, new PublicKey(input.creatorPubkey).toBytes());
    if (!ok) return { ok: false, response: NextResponse.json({ error: "Invalid signature" }, { status: 401 }) };
    timestampUnix = ts;
  }

  const fresh = await recordAsdRequest({
    commitmentId: input.commitmentId,
    requestId,
    action: input.action,
    signerPubkey: isAdmin ? null : input.creatorPubkey,
    signedAtUnix: timestampUnix,
  });
  if (!fresh) {
    return { ok: false, response: NextResponse.json({ error: "requestId was already used; generate a new one" }, { status: 409 }) };
  }

  return { ok: true, isAdmin, requestId, timestampUnix };
}
