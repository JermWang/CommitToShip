import crypto from "crypto";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

import { getSafeErrorMessage } from "./safeError";

function canonicalizeJson(value: any): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t !== "object") return "null";

  if (Array.isArray(value)) {
    const parts = value.map((v) => (v === undefined ? "null" : canonicalizeJson(v)));
    return `[${parts.join(",")}]`;
  }

  const obj = value as Record<string, any>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`);
  }
  return `{${parts.join(",")}}`;
}

function getPrivyAuthorizationPrivateKeys(): string[] {
  const raw =
    String(process.env.PRIVY_AUTHORIZATION_PRIVATE_KEYS ?? "").trim() ||
    String(process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY ?? "").trim() ||
    String(process.env.PRIVY_AUTHORIZATION_KEY ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function privateKeyToKeyObject(raw: string): crypto.KeyObject {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new Error("Missing authorization private key");

  if (trimmed.includes("BEGIN PRIVATE KEY")) {
    return crypto.createPrivateKey({ key: trimmed, format: "pem" });
  }

  const base64 = trimmed.startsWith("wallet-auth:") ? trimmed.slice("wallet-auth:".length) : trimmed;
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
  return crypto.createPrivateKey({ key: pem, format: "pem" });
}

function signPrivyRequest(input: {
  method: "GET" | "POST" | "PATCH";
  url: string;
  appId: string;
  body?: any;
  idempotencyKey?: string;
}): string {
  // Privy's authorization-signature payload covers ONLY the privy-specific headers (privy-app-id and, when present,
  // privy-idempotency-key) - exactly what the official SDK signs. Adding content-type makes every signature invalid.
  const payloadHeaders: Record<string, string> = {
    "privy-app-id": input.appId,
  };
  if (input.idempotencyKey) payloadHeaders["privy-idempotency-key"] = input.idempotencyKey;

  const payload = {
    version: 1,
    method: input.method,
    url: input.url,
    body: input.body == null ? {} : input.body,
    headers: payloadHeaders,
  };

  const serializedPayload = canonicalizeJson(payload);
  const buf = Buffer.from(serializedPayload);

  const keys = getPrivyAuthorizationPrivateKeys();
  if (keys.length === 0) return "";

  const sigs: string[] = [];
  for (const k of keys) {
    const keyObj = privateKeyToKeyObject(k);
    const data = new Uint8Array(buf);
    const signatureBuffer = crypto.sign("sha256", data, keyObj);
    sigs.push(signatureBuffer.toString("base64"));
  }
  return sigs.join(",");
}

function mustGetPrivyCreds(): { appId: string; appSecret: string } {
  const appId = String(process.env.PRIVY_APP_ID ?? "").trim();
  const appSecret = String(process.env.PRIVY_APP_SECRET ?? "").trim();
  if (!appId || !appSecret) {
    throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET are required");
  }
  return { appId, appSecret };
}

function basicAuthHeader(appId: string, appSecret: string): string {
  const raw = `${appId}:${appSecret}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

/**
 * Idempotency keys are derived from the operation itself (wallet + exact payload), so a retried request - e.g. after a
 * timeout where Privy did act - is answered with the original result instead of being executed a second time.
 */
function idempotencyKey(prefix: string, ...parts: string[]): string {
  const digest = crypto.createHash("sha256").update(parts.map((p) => String(p ?? "")).join("|")).digest("hex").slice(0, 48);
  return `${prefix}:${digest}`;
}

async function privyFetchJson(input: {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: any;
  idempotencyKey?: string;
}): Promise<any> {
  const { appId, appSecret } = mustGetPrivyCreds();

  const url = `https://api.privy.io${input.path}`;

  const headers: Record<string, string> = {
    authorization: basicAuthHeader(appId, appSecret),
    "content-type": "application/json",
    "privy-app-id": appId,
  };

  if (input.idempotencyKey) {
    headers["privy-idempotency-key"] = input.idempotencyKey;
    headers["idempotency-key"] = input.idempotencyKey;
  }

  if (input.method !== "GET") {
    const sig = signPrivyRequest({
      method: input.method,
      url,
      appId,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    });
    if (sig) headers["privy-authorization-signature"] = sig;
  }

  const res = await fetch(url, {
    method: input.method,
    headers,
    body: input.body == null ? undefined : JSON.stringify(input.body),
    cache: "no-store",
  });

  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const msg = typeof json?.error === "string" && json.error.length ? json.error : `Privy request failed (${res.status})`;
    throw new Error(getSafeErrorMessage(msg));
  }

  return json;
}

/**
 * Creates a Privy server wallet. Pass `operationKey` (e.g. "launch-treasury:<payer>") so a retry of the same logical
 * operation returns the wallet Privy already created instead of minting an orphan; without one every call is unique.
 */
export async function privyCreateSolanaWallet(input?: { operationKey?: string }): Promise<{ walletId: string; address: string }> {
  const operationKey = String(input?.operationKey ?? "").trim() || `adhoc:${crypto.randomUUID()}`;
  const json = await privyFetchJson({
    method: "POST",
    path: "/v1/wallets",
    body: { chain_type: "solana" },
    idempotencyKey: idempotencyKey("cts:createWallet", operationKey),
  });

  const walletId = String(json?.id ?? "").trim();
  const address = String(json?.address ?? "").trim();

  if (!walletId || !address) {
    throw new Error("Privy returned an invalid wallet response");
  }

  return { walletId, address };
}

export async function privyFindSolanaWalletIdByAddress(input: {
  address: string;
  maxPages?: number;
}): Promise<string | null> {
  const address = String(input.address ?? "").trim();
  if (!address) return null;

  const maxPages = Math.max(1, Math.min(50, Number(input.maxPages ?? 10)));

  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams();
    q.set("chain_type", "solana");
    q.set("limit", "100");
    if (cursor) q.set("cursor", cursor);

    const json = await privyFetchJson({
      method: "GET",
      path: `/v1/wallets?${q.toString()}`,
    });

    const data = Array.isArray(json?.data) ? json.data : [];
    for (const w of data) {
      const a = String(w?.address ?? "").trim();
      if (a === address) {
        const id = String(w?.id ?? "").trim();
        return id || null;
      }
    }

    const next = String(json?.next_cursor ?? "").trim();
    if (!next) return null;
    cursor = next;
  }

  return null;
}

export async function privySignAndSendSolanaTransaction(input: {
  walletId: string;
  caip2: string;
  transactionBase64: string;
}): Promise<{ signature: string; transactionId?: string }> {
  const walletId = String(input.walletId ?? "").trim();
  const caip2 = String(input.caip2 ?? "").trim();
  const tx = String(input.transactionBase64 ?? "").trim();

  if (!walletId) throw new Error("walletId required");
  if (!caip2) throw new Error("caip2 required");
  if (!tx) throw new Error("transactionBase64 required");

  const json = await privyFetchJson({
    method: "POST",
    path: `/v1/wallets/${encodeURIComponent(walletId)}/rpc`,
    body: {
      method: "signAndSendTransaction",
      caip2,
      sponsor: false,
      params: {
        transaction: tx,
        encoding: "base64",
      },
    },
    idempotencyKey: idempotencyKey("cts:signAndSendSolana", walletId, caip2, tx),
  });

  const signature = String(json?.data?.hash ?? "").trim();
  const transactionId = json?.data?.transaction_id != null ? String(json.data.transaction_id) : undefined;

  if (!signature) {
    throw new Error("Privy did not return a transaction hash");
  }

  return { signature, transactionId };
}

export async function privySignSolanaTransaction(input: {
  walletId: string;
  transactionBase64: string;
}): Promise<{ signedTransactionBase64: string }> {
  const walletId = String(input.walletId ?? "").trim();
  const tx = String(input.transactionBase64 ?? "").trim();

  if (!walletId) throw new Error("walletId required");
  if (!tx) throw new Error("transactionBase64 required");

  const json = await privyFetchJson({
    method: "POST",
    path: `/v1/wallets/${encodeURIComponent(walletId)}/rpc`,
    body: {
      method: "signTransaction",
      params: {
        transaction: tx,
        encoding: "base64",
      },
    },
    idempotencyKey: idempotencyKey("cts:signSolana", walletId, tx),
  });

  const signed =
    String(json?.data?.signed_transaction ?? "").trim() ||
    String(json?.data?.signedTransaction ?? "").trim() ||
    String(json?.data?.transaction ?? "").trim();

  if (!signed) {
    throw new Error("Privy did not return a signed transaction");
  }

  return { signedTransactionBase64: signed };
}

/**
 * Privy-signs a legacy transaction and sends it through the durable path (rpc.ts sendAndConfirmDurable): the same
 * signed bytes are rebroadcast until they confirm, and a fresh blockhash is only used once the previous transaction
 * is provably expired - so a timeout can never turn one refund into two.
 */
async function privySignAndSendRawViaRpc(input: {
  connection: Connection;
  walletId: string;
  transaction: Transaction;
}): Promise<{ signature: string; blockhash: string; lastValidBlockHeight: number }> {
  const walletId = String(input.walletId ?? "").trim();
  if (!walletId) throw new Error("walletId required");

  const { sendAndConfirmDurable } = await import("./rpc");
  const tx = input.transaction;

  try {
    const res = await sendAndConfirmDurable({
      connection: input.connection,
      maxRebuilds: 1,
      sign: async (latest) => {
        tx.recentBlockhash = latest.blockhash;
        tx.lastValidBlockHeight = latest.lastValidBlockHeight;
        const signed = await privySignSolanaTransaction({
          walletId,
          transactionBase64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
        });
        return Buffer.from(signed.signedTransactionBase64, "base64");
      },
    });
    return { signature: res.signature, blockhash: res.blockhash, lastValidBlockHeight: res.lastValidBlockHeight };
  } catch (e) {
    const cause = (e as any)?.cause;
    const rawLogs = (e as any)?.logs ?? cause?.logs;
    if (Array.isArray(rawLogs) && rawLogs.length && !(e as any).logs) {
      try {
        (e as any).logs = rawLogs.map((l: any) => String(l));
      } catch {
        // ignore
      }
    }
    throw e;
  }
}

export async function privyTransferLamportsFromWallet(input: {
  walletId: string;
  fromPubkey: PublicKey;
  toPubkey: PublicKey;
  lamports: number;
  caip2: string;
}): Promise<{ ok: true; signature: string } | { ok: false; error: string; logs?: string[] }> {
  const walletId = String(input.walletId ?? "").trim();
  const caip2 = String(input.caip2 ?? "").trim();
  const lamports = Math.floor(Number(input.lamports ?? 0));

  if (!walletId) return { ok: false, error: "walletId required" };
  if (!caip2) return { ok: false, error: "caip2 required" };
  if (!Number.isFinite(lamports) || lamports <= 0) return { ok: false, error: "lamports must be > 0" };

  try {
    const { getConnection } = await import("./solana");

    const connection = getConnection();
    const tx = new Transaction();
    tx.feePayer = input.fromPubkey;
    tx.add(
      SystemProgram.transfer({
        fromPubkey: input.fromPubkey,
        toPubkey: input.toPubkey,
        lamports,
      })
    );

    const sent = await privySignAndSendRawViaRpc({ connection, walletId, transaction: tx });
    return { ok: true, signature: sent.signature };
  } catch (e) {
    const logs = Array.isArray((e as any)?.logs) ? ((e as any).logs as any[]).map((l) => String(l)) : undefined;
    return { ok: false, error: getSafeErrorMessage(e), logs };
  }
}

export async function privyFundWalletFromFeePayer(input: {
  toPubkey: PublicKey;
  lamports: number;
}): Promise<{ ok: true; signature: string } | { ok: false; error: string }> {
  const { toPubkey, lamports } = input;
  
  const feePayerSecret = String(process.env.ESCROW_FEE_PAYER_SECRET_KEY ?? "").trim();
  if (!feePayerSecret) {
    return { ok: false, error: "ESCROW_FEE_PAYER_SECRET_KEY is required for automated launches" };
  }

  try {
    // Dynamic import to avoid circular dependency
    const { keypairFromBase58Secret, getConnection } = await import("./solana");
    const { confirmSignatureViaRpc, withRetry } = await import("./rpc");
    
    const feePayer = keypairFromBase58Secret(feePayerSecret);
    const connection = getConnection();
    
    const balance = await withRetry(() => connection.getBalance(feePayer.publicKey, "confirmed"));
    const neededLamports = lamports + 5000;
    if (balance < neededLamports) {
      const balanceSol = (balance / 1_000_000_000).toFixed(2);
      const needSol = (neededLamports / 1_000_000_000).toFixed(2);
      return {
        ok: false,
        error: `Fee payer ${feePayer.publicKey.toBase58()} has insufficient balance (${balance} lamports ~${balanceSol} SOL, need ${neededLamports} lamports ~${needSol} SOL). Fund the ESCROW_FEE_PAYER_SECRET_KEY address.`,
      };
    }

    let { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash("confirmed"));
    
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = feePayer.publicKey;
    tx.add(
      SystemProgram.transfer({
        fromPubkey: feePayer.publicKey,
        toPubkey,
        lamports,
      })
    );

    tx.sign(feePayer);
    
    const signature = await withRetry(() => 
      connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
    );

    await confirmSignatureViaRpc(connection, signature, "confirmed");

    return { ok: true, signature };
  } catch (e) {
    return { ok: false, error: getSafeErrorMessage(e) };
  }
}

export async function privyRefundWalletToDestination(input: {
  walletId: string;
  fromPubkey: PublicKey;
  toPubkey: PublicKey;
  caip2: string;
  keepLamports?: number;
}): Promise<
  | { ok: true; signature: string; refundedLamports: number }
  | { ok: false; error: string; logs?: string[] }
> {
  const walletId = String(input.walletId ?? "").trim();
  const caip2 = String(input.caip2 ?? "").trim();
  const requestedKeepLamports = Math.max(5_000, Number(input.keepLamports ?? 10_000));

  if (!walletId) return { ok: false, error: "walletId required" };
  if (!caip2) return { ok: false, error: "caip2 required" };

  try {
    const { getConnection } = await import("./solana");
    const { withRetry } = await import("./rpc");

    const connection = getConnection();

    let rentExemptMin = 0;
    try {
      const info = await withRetry(() => connection.getAccountInfo(input.fromPubkey, "confirmed"));
      if (info) {
        rentExemptMin = await withRetry(() => connection.getMinimumBalanceForRentExemption(info.data.length));
      }
    } catch {
      // ignore
    }

    const keepLamports = Math.max(requestedKeepLamports, rentExemptMin + 50_000);

    const balance = await withRetry(() => connection.getBalance(input.fromPubkey, "confirmed"));
    const refundableLamports = Math.max(0, balance - keepLamports);
    if (refundableLamports <= 0) {
      return { ok: false, error: `No refundable balance (balance=${balance}, keepLamports=${keepLamports})` };
    }

    const tx = new Transaction();
    tx.feePayer = input.fromPubkey;
    tx.add(
      SystemProgram.transfer({
        fromPubkey: input.fromPubkey,
        toPubkey: input.toPubkey,
        lamports: refundableLamports,
      })
    );

    const sent = await privySignAndSendRawViaRpc({ connection, walletId, transaction: tx });
    return { ok: true, signature: sent.signature, refundedLamports: refundableLamports };
  } catch (e) {
    const logs = Array.isArray((e as any)?.logs) ? ((e as any).logs as any[]).map((l) => String(l)) : undefined;
    return { ok: false, error: getSafeErrorMessage(e), logs };
  }
}

export async function privyRefundWalletToFeePayer(input: {
  walletId: string;
  fromPubkey: PublicKey;
  caip2: string;
  keepLamports?: number;
}): Promise<
  | { ok: true; signature: string; refundedLamports: number }
  | { ok: false; error: string; logs?: string[] }
> {
  const walletId = String(input.walletId ?? "").trim();
  const caip2 = String(input.caip2 ?? "").trim();
  const requestedKeepLamports = Math.max(5_000, Number(input.keepLamports ?? 10_000));

  if (!walletId) return { ok: false, error: "walletId required" };
  if (!caip2) return { ok: false, error: "caip2 required" };

  const feePayerSecret = String(process.env.ESCROW_FEE_PAYER_SECRET_KEY ?? "").trim();
  if (!feePayerSecret) {
    return { ok: false, error: "ESCROW_FEE_PAYER_SECRET_KEY is required for refunds" };
  }

  try {
    const { keypairFromBase58Secret, getConnection } = await import("./solana");
    const { withRetry } = await import("./rpc");

    const feePayer = keypairFromBase58Secret(feePayerSecret);
    const connection = getConnection();

    let rentExemptMin = 0;
    try {
      const info = await withRetry(() => connection.getAccountInfo(input.fromPubkey, "confirmed"));
      if (info) {
        rentExemptMin = await withRetry(() => connection.getMinimumBalanceForRentExemption(info.data.length));
      }
    } catch {
      // ignore
    }

    const keepLamports = Math.max(requestedKeepLamports, rentExemptMin + 50_000);

    const balance = await withRetry(() => connection.getBalance(input.fromPubkey, "confirmed"));
    const refundableLamports = Math.max(0, balance - keepLamports);
    if (refundableLamports <= 0) {
      return { ok: false, error: `No refundable balance (balance=${balance}, keepLamports=${keepLamports})` };
    }

    const tx = new Transaction();
    tx.feePayer = input.fromPubkey;
    tx.add(
      SystemProgram.transfer({
        fromPubkey: input.fromPubkey,
        toPubkey: feePayer.publicKey,
        lamports: refundableLamports,
      })
    );

    const sent = await privySignAndSendRawViaRpc({ connection, walletId, transaction: tx });
    return { ok: true, signature: sent.signature, refundedLamports: refundableLamports };
  } catch (e) {
    const logs = Array.isArray((e as any)?.logs) ? ((e as any).logs as any[]).map((l) => String(l)) : undefined;
    return { ok: false, error: getSafeErrorMessage(e), logs };
  }
}
