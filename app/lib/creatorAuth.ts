import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

export type CreatorAuthPayload = {
  walletPubkey: string;
  timestampUnix: number;
  signatureB58: string;
};

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
  return `Commit To Ship\nCreator Auth\nAction: ${input.action}\nWallet: ${input.walletPubkey}\nTimestamp: ${input.timestampUnix}`;
}

export function verifyCreatorAuthOrThrow(input: {
  payload: any;
  action: string;
  expectedWalletPubkey: string;
  maxSkewSeconds: number;
}): string {
  const allowed = getAllowedCreatorWallets();

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

  if (!allowed.has(walletPubkey)) {
    throw new Error("Wallet is not approved for closed beta");
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  if (Math.abs(nowUnix - Math.floor(timestampUnix)) > Math.max(30, input.maxSkewSeconds)) {
    throw new Error("creatorAuth timestamp expired");
  }

  const msg = expectedCreatorAuthMessage({
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

  const ok = nacl.sign.detached.verify(new TextEncoder().encode(msg), signature, new PublicKey(walletPubkey).toBytes());
  if (!ok) {
    throw new Error("Invalid creatorAuth signature");
  }

  return walletPubkey;
}
