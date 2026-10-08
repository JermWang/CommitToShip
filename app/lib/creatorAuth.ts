import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

import { auditLog } from "./auditLog";
import { getAdminSessionWallet, getAllowedAdminWallets } from "./adminSession";

export type CreatorAuthPayload = {
  walletPubkey: string;
  timestampUnix: number;
  signatureB58: string;
};

/** Public launches are on by default. Set CTS_PUBLIC_LAUNCHES=false to restrict launches to the allowlist. */
export function isPublicLaunchEnabled(): boolean {
  const raw = String(process.env.CTS_PUBLIC_LAUNCHES ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

/** Emergency kill switch: set CTS_LAUNCHES_PAUSED=1 to reject all new launches immediately. */
export function isLaunchPaused(): boolean {
  const raw = String(process.env.CTS_LAUNCHES_PAUSED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export type LaunchAccessDenied = { status: number; error: string; hint?: string };

/**
 * What the payer's execute signature commits to: where the creator fees go (payout wallet), what token is created and
 * how much of the launch wallet is spent on the dev buy. A launch_access signature (shared by upload/prepare/dev-buy)
 * can't be replayed to launch something else or to redirect the payout.
 */
export type LaunchExecuteBinding = { payoutWallet: string; name: string; symbol: string; devBuyLamports: number };

function bodyStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Same normalization as validateLaunchInput / the execute route, without throwing (auth runs before validation). */
export function launchExecuteBindingFromBody(body: any): LaunchExecuteBinding {
  const devBuySolParsed = Number(body?.devBuySol ?? 0);
  const devBuySol = Number.isFinite(devBuySolParsed) && devBuySolParsed >= 0 ? Math.min(devBuySolParsed, 100) : 0;
  return {
    payoutWallet: bodyStr(body?.payoutWallet),
    name: bodyStr(body?.name),
    symbol: bodyStr(body?.symbol).replace(/^\$+/, "").trim(),
    devBuyLamports: Math.floor(devBuySol * 1_000_000_000),
  };
}

/** The exact text the payer signs for POST /api/launch/execute (the client builds the same string). */
export function expectedLaunchExecuteMessage(input: LaunchExecuteBinding & { walletPubkey: string; timestampUnix: number }): string {
  return [
    "Ship & Commit",
    "Creator Auth",
    "Action: launch_execute",
    `Wallet: ${input.walletPubkey}`,
    `Payout wallet: ${input.payoutWallet}`,
    `Token name: ${JSON.stringify(input.name)}`,
    `Token symbol: ${JSON.stringify(input.symbol)}`,
    `Dev buy lamports: ${Math.floor(Number(input.devBuyLamports) || 0)}`,
    `Timestamp: ${input.timestampUnix}`,
  ].join("\n");
}

/**
 * Gate for every launch-related endpoint. The payer wallet must always prove control of its key
 * (signed creatorAuth), so nobody can act on behalf of somebody else's launch treasury.
 * Admins with a valid session may bypass the signature. In closed mode the allowlist is enforced too.
 * Returns null when access is granted.
 */
export async function authorizeLaunchAccess(
  req: Request,
  input: { body: any; payerWallet: string; auditEvent: string; executeBinding?: LaunchExecuteBinding }
): Promise<LaunchAccessDenied | null> {
  if (isLaunchPaused()) {
    return { status: 503, error: "Launches are temporarily paused. Please check back soon." };
  }

  const payer = new PublicKey(input.payerWallet).toBase58();

  try {
    const adminWallet = await getAdminSessionWallet(req);
    if (adminWallet && getAllowedAdminWallets().has(String(adminWallet))) return null;
  } catch {
    // no admin session - fall through to wallet signature
  }

  // The signature is always verified BEFORE the allowlist is consulted, so unauthenticated callers can't probe which
  // wallets are approved in closed-launch mode.
  try {
    verifyCreatorAuthOrThrow({
      payload: input.body?.creatorAuth,
      action: input.executeBinding ? "launch_execute" : "launch_access",
      expectedWalletPubkey: payer,
      maxSkewSeconds: 5 * 60,
      executeBinding: input.executeBinding,
    });
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    await auditLog(input.auditEvent, { payerWallet: payer, error: msg }).catch(() => null);
    return { status: 401, error: msg, hint: "Approve the wallet signature request and try again." };
  }

  if (!isPublicLaunchEnabled() && !getAllowedCreatorWallets().has(payer)) {
    await auditLog(input.auditEvent, { payerWallet: payer, error: "wallet not on allowlist" }).catch(() => null);
    return {
      status: 403,
      error: "Wallet is not approved for launching yet",
      hint: "Launches are currently limited to approved wallets.",
    };
  }

  return null;
}

export function getAllowedCreatorWallets(): Set<string> {
  const raw = String(process.env.CTS_CREATOR_WALLET_PUBKEYS ?? "").trim();
  const rawAdmin = String(process.env.ADMIN_WALLET_PUBKEYS ?? "").trim();

  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (v) out.add(v);
  }
  for (const part of rawAdmin.split(",")) {
    const v = part.trim();
    if (v) out.add(v);
  }
  return out;
}

export function expectedCreatorAuthMessage(input: {
  action: string;
  walletPubkey: string;
  timestampUnix: number;
}): string {
  return `Ship & Commit\nCreator Auth\nAction: ${input.action}\nWallet: ${input.walletPubkey}\nTimestamp: ${input.timestampUnix}`;
}

export function verifyCreatorAuthOrThrow(input: {
  payload: any;
  action: string;
  expectedWalletPubkey: string;
  maxSkewSeconds: number;
  /** Required for action "launch_execute": the signed message must commit to these values. */
  executeBinding?: LaunchExecuteBinding;
}): string {
  const payload = input.payload as any;
  const walletRaw = typeof payload?.walletPubkey === "string" ? payload.walletPubkey.trim() : "";
  const signatureB58 = typeof payload?.signatureB58 === "string" ? payload.signatureB58.trim() : "";
  const timestampUnix = Number(payload?.timestampUnix);

  if (!walletRaw || !signatureB58 || !Number.isFinite(timestampUnix) || timestampUnix <= 0) {
    throw new Error("creatorAuth (walletPubkey, signatureB58, timestampUnix) is required");
  }

  const walletPubkey = new PublicKey(walletRaw).toBase58();
  const expectedWallet = new PublicKey(input.expectedWalletPubkey).toBase58();

  if (walletPubkey !== expectedWallet) {
    throw new Error("creatorAuth wallet mismatch");
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  if (Math.abs(nowUnix - Math.floor(timestampUnix)) > Math.max(30, input.maxSkewSeconds)) {
    throw new Error("creatorAuth timestamp expired");
  }

  if (input.action === "launch_execute" && !input.executeBinding) throw new Error("creatorAuth launch details are missing");
  const msg =
    input.action === "launch_execute" && input.executeBinding
      ? expectedLaunchExecuteMessage({ ...input.executeBinding, walletPubkey, timestampUnix: Math.floor(timestampUnix) })
      : expectedCreatorAuthMessage({
          action: String(input.action),
          walletPubkey,
          timestampUnix: Math.floor(timestampUnix),
        });

  let signature: Uint8Array;
  try {
    signature = bs58.decode(signatureB58);
  } catch {
    throw new Error("Invalid creatorAuth signature encoding");
  }
  if (signature.length !== 64) throw new Error("Invalid creatorAuth signature");

  const ok = nacl.sign.detached.verify(new TextEncoder().encode(msg), signature, new PublicKey(walletPubkey).toBytes());
  if (!ok) {
    throw new Error("Invalid creatorAuth signature");
  }

  return walletPubkey;
}
