import { Commitment, Connection, Finality, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

import { confirmSignatureViaRpc, getConnection as getConnectionRpc, getServerCommitment, withRetry } from "./rpc";
import { privySignSolanaTransaction } from "./privy";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function buildCloseTokenAccountIx(input: { tokenAccount: PublicKey; destination: PublicKey; owner: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: input.tokenAccount, isSigner: false, isWritable: true },
      { pubkey: input.destination, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

export async function getTokenProgramIdForMint(input: { connection: Connection; mint: PublicKey }): Promise<PublicKey> {
  const info = await withRetry(() => input.connection.getAccountInfo(input.mint, getServerCommitment()));
  const owner = info?.owner;
  if (!owner) throw new Error("Mint not found");
  return owner;
}

export function getAssociatedTokenAddress(input: { owner: PublicKey; mint: PublicKey; tokenProgram?: PublicKey }): PublicKey {
  const tokenProgram = input.tokenProgram ?? TOKEN_PROGRAM_ID;
  const [pda] = PublicKey.findProgramAddressSync(
    [input.owner.toBuffer(), tokenProgram.toBuffer(), input.mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return pda;
}

export function buildCreateAssociatedTokenAccountIdempotentInstruction(input: {
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  tokenProgram?: PublicKey;
}): { ix: TransactionInstruction; ata: PublicKey } {
  const tokenProgram = input.tokenProgram ?? TOKEN_PROGRAM_ID;
  const ata = getAssociatedTokenAddress({ owner: input.owner, mint: input.mint, tokenProgram });
  const ix = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
  return { ix, ata };
}

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

export function buildSplTokenTransferInstruction(input: {
  sourceAta: PublicKey;
  destinationAta: PublicKey;
  owner: PublicKey;
  amountRaw: bigint;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  const tokenProgram = input.tokenProgram ?? TOKEN_PROGRAM_ID;
  const amountRaw = BigInt(input.amountRaw);
  if (amountRaw <= 0n) throw new Error("amountRaw must be > 0");
  const data = Buffer.concat([Buffer.from([3]), u64le(amountRaw)]);
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: input.sourceAta, isSigner: false, isWritable: true },
      { pubkey: input.destinationAta, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export async function transferSplTokensFromKeypair(opts: {
  connection: Connection;
  mint: PublicKey;
  from: Keypair;
  toOwner: PublicKey;
  amountRaw: bigint;
  tokenProgram?: PublicKey;
}): Promise<{ signature: string; amountRaw: bigint }> {
  const { connection, mint, from, toOwner } = opts;
  const amountRaw = BigInt(opts.amountRaw);
  if (amountRaw <= 0n) throw new Error("amountRaw must be > 0");

  const tokenProgram = opts.tokenProgram ?? (await getTokenProgramIdForMint({ connection, mint }));
  const feePayer = await getFeePayerKeypair();
  const payer = feePayer ? feePayer.publicKey : from.publicKey;

  const sourceAta = getAssociatedTokenAddress({ owner: from.publicKey, mint, tokenProgram });
  const { ix: createIx, ata: destinationAta } = buildCreateAssociatedTokenAccountIdempotentInstruction({ payer, owner: toOwner, mint, tokenProgram });
  const transferIx = buildSplTokenTransferInstruction({ sourceAta, destinationAta, owner: from.publicKey, amountRaw, tokenProgram });

  const signature = await sendSignedTransactionViaRpcWithRetries({
    connection,
    build: (latest) => {
      const tx = new Transaction();
      tx.recentBlockhash = latest.blockhash;
      tx.lastValidBlockHeight = latest.lastValidBlockHeight;
      tx.feePayer = payer;
      tx.add(createIx);
      tx.add(transferIx);
      const signers = feePayer ? [feePayer, from] : [from];
      return { tx, signers };
    },
  });

  return { signature, amountRaw };
}

export async function transferSplTokensFromPrivyWallet(opts: {
  connection: Connection;
  mint: PublicKey;
  walletId: string;
  fromOwner: PublicKey;
  toOwner: PublicKey;
  amountRaw: bigint;
  tokenProgram?: PublicKey;
}): Promise<{ signature: string; amountRaw: bigint }> {
  const { connection, mint, fromOwner, toOwner } = opts;
  const amountRaw = BigInt(opts.amountRaw);
  if (amountRaw <= 0n) throw new Error("amountRaw must be > 0");

  const tokenProgram = opts.tokenProgram ?? (await getTokenProgramIdForMint({ connection, mint }));
  const feePayer = await getFeePayerKeypair();
  const payer = feePayer ? feePayer.publicKey : fromOwner;

  const sourceAta = getAssociatedTokenAddress({ owner: fromOwner, mint, tokenProgram });
  const { ix: createIx, ata: destinationAta } = buildCreateAssociatedTokenAccountIdempotentInstruction({ payer, owner: toOwner, mint, tokenProgram });
  const transferIx = buildSplTokenTransferInstruction({ sourceAta, destinationAta, owner: fromOwner, amountRaw, tokenProgram });

  const tx = new Transaction();
  tx.feePayer = payer;
  tx.add(createIx);
  tx.add(transferIx);

  const signature = await privySignAndSendViaRpc({
    connection,
    walletId: String(opts.walletId),
    tx,
    feePayer,
  });

  return { signature, amountRaw };
}

export function getConnection(): Connection {
  return getConnectionRpc();
}

export function parsePubkey(value: string): PublicKey {
  return new PublicKey(value);
}

export function keypairFromBase58Secret(secret: string): Keypair {
  const bytes = bs58.decode(secret);
  return Keypair.fromSecretKey(bytes);
}

export async function getBalanceLamports(connection: Connection, pubkey: PublicKey): Promise<number> {
  const c = getServerCommitment();
  return await withRetry(() => connection.getBalance(pubkey, c));
}

/**
 * Current unix time according to the chain, falling back to the server clock.
 * getBlockTime on the very latest slot often fails ("Block not available"); that must never take a page or API
 * route down, and a few seconds of skew is irrelevant for the day-scale windows this is used for.
 */
export async function getChainUnixTime(connection: Connection): Promise<number> {
  try {
    const c = getServerCommitment();
    const slot = await connection.getSlot(c);
    // Ask for a slightly older slot: it is far more likely to have a block time available.
    const t = await connection.getBlockTime(Math.max(0, slot - 8));
    if (typeof t === "number" && Number.isFinite(t) && t > 0) {
      // Prefer the chain time, but never let it drift far from the server clock.
      const server = Math.floor(Date.now() / 1000);
      return Math.abs(t - server) <= 120 ? t : server;
    }
  } catch {
    // fall through to the server clock
  }
  return Math.floor(Date.now() / 1000);
}

export async function hasAnyTokenBalanceForMint(input: {
  connection: Connection;
  owner: PublicKey;
  mint: PublicKey;
}): Promise<boolean> {
  const { connection, owner, mint } = input;
  const c = getServerCommitment();
  const res = await withRetry(() => connection.getParsedTokenAccountsByOwner(owner, { mint }, c));
  for (const a of res.value) {
    const parsed: any = a.account?.data?.parsed;
    const amountRaw = parsed?.info?.tokenAmount?.amount;
    if (typeof amountRaw === "string") {
      const n = Number(amountRaw);
      if (Number.isFinite(n) && n > 0) return true;
    }
  }
  return false;
}

export async function getTokenBalanceForMint(input: {
  connection: Connection;
  owner: PublicKey;
  mint: PublicKey;
}): Promise<{ amountRaw: bigint; decimals: number; uiAmount: number }> {
  const { connection, owner, mint } = input;
  const c = getServerCommitment();
  const res = await withRetry(() => connection.getParsedTokenAccountsByOwner(owner, { mint }, c));

  let total = 0n;
  let decimals = 0;

  for (const a of res.value) {
    const parsed: any = a.account?.data?.parsed;
    const tokenAmount = parsed?.info?.tokenAmount;
    const amountRaw = tokenAmount?.amount;
    const dec = tokenAmount?.decimals;
    if (typeof dec === "number" && Number.isFinite(dec)) decimals = dec;
    if (typeof amountRaw === "string" && amountRaw.length) {
      try {
        total += BigInt(amountRaw);
      } catch {
        // ignore
      }
    }
  }

  if (total <= 0n) return { amountRaw: 0n, decimals, uiAmount: 0 };

  const d = BigInt(Math.max(0, Math.min(18, decimals)));
  const divisor = 10n ** d;
  const whole = total / divisor;
  const frac = total % divisor;
  const fracStr = frac.toString().padStart(Number(d), "0").slice(0, 9);

  const wholeNum = Number(whole);
  const fracNum = fracStr.length ? Number(`0.${fracStr}`) : 0;
  const uiAmount = (Number.isFinite(wholeNum) ? wholeNum : 0) + (Number.isFinite(fracNum) ? fracNum : 0);

  return { amountRaw: total, decimals, uiAmount };
}

export async function getTokenSupplyForMint(input: {
  connection: Connection;
  mint: PublicKey;
}): Promise<{ amountRaw: bigint; decimals: number; uiAmount: number }> {
  const { connection, mint } = input;
  const c = getServerCommitment();
  const res = await withRetry(() => connection.getTokenSupply(mint, c));

  const amountRawStr = res?.value?.amount;
  const decimals = typeof res?.value?.decimals === "number" && Number.isFinite(res.value.decimals) ? res.value.decimals : 0;

  let total = 0n;
  if (typeof amountRawStr === "string" && amountRawStr.length) {
    try {
      total = BigInt(amountRawStr);
    } catch {
    }
  }

  if (total <= 0n) return { amountRaw: 0n, decimals, uiAmount: 0 };

  const d = BigInt(Math.max(0, Math.min(18, decimals)));
  const divisor = 10n ** d;
  const whole = total / divisor;
  const frac = total % divisor;
  const fracStr = frac.toString().padStart(Number(d), "0").slice(0, 9);

  const wholeNum = Number(whole);
  const fracNum = fracStr.length ? Number(`0.${fracStr}`) : 0;
  const uiAmount = (Number.isFinite(wholeNum) ? wholeNum : 0) + (Number.isFinite(fracNum) ? fracNum : 0);

  return { amountRaw: total, decimals, uiAmount };
}

export async function verifyTokenExistsOnChain(input: { connection: Connection; mint: PublicKey }): Promise<{
  exists: boolean;
  isMintAccount: boolean;
  supply?: string;
  decimals?: number;
}> {
  const { connection, mint } = input;
  const c = getServerCommitment();
  
  try {
    const info = await withRetry(() => connection.getParsedAccountInfo(mint, c));
    const value: any = info.value;
    
    if (!value) {
      return { exists: false, isMintAccount: false };
    }
    
    const parsed = value?.data?.parsed;
    const type = parsed?.type;
    
    // Check if it's a valid mint account (SPL Token or Token-2022)
    if (type !== "mint") {
      return { exists: true, isMintAccount: false };
    }
    
    const supply = parsed?.info?.supply;
    const decimals = parsed?.info?.decimals;
    
    return {
      exists: true,
      isMintAccount: true,
      supply: typeof supply === "string" ? supply : undefined,
      decimals: typeof decimals === "number" ? decimals : undefined,
    };
  } catch {
    return { exists: false, isMintAccount: false };
  }
}

export async function getMintAuthorityBase58(input: { connection: Connection; mint: PublicKey }): Promise<string | null> {
  const { connection, mint } = input;
  const c = getServerCommitment();
  const info = await withRetry(() => connection.getParsedAccountInfo(mint, c));
  const value: any = info.value;
  const parsed = value?.data?.parsed;
  const mintAuthority = parsed?.info?.mintAuthority;
  if (typeof mintAuthority === "string" && mintAuthority.length) return mintAuthority;
  return null;
}

async function privySignAndSendViaRpc(input: {
  connection: Connection;
  walletId: string;
  tx: Transaction;
  feePayer?: Keypair | null;
  maxAttempts?: number;
}): Promise<string> {
  const maxAttempts = Math.max(1, Math.min(6, Number(input.maxAttempts ?? 4) || 4));
  const processed = "processed" as Commitment;
  const finality = getServerCommitment();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const latest = await withRetry(() => input.connection.getLatestBlockhash(processed));
      input.tx.recentBlockhash = latest.blockhash;
      input.tx.lastValidBlockHeight = latest.lastValidBlockHeight;

      if (input.feePayer) {
        input.tx.partialSign(input.feePayer);
      }

      const txBytes = input.tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const txBase64 = Buffer.from(Uint8Array.from(txBytes)).toString("base64");
      const signed = await privySignSolanaTransaction({ walletId: String(input.walletId), transactionBase64: txBase64 });
      const raw = Buffer.from(signed.signedTransactionBase64, "base64");

      let candidateSig = "";
      try {
        const parsed = Transaction.from(raw);
        const sigBytes = parsed.signatures?.[0]?.signature;
        if (sigBytes) candidateSig = bs58.encode(Uint8Array.from(sigBytes));
      } catch {
        // ignore
      }

      try {
        const sentSig = await withRetry(() =>
          input.connection.sendRawTransaction(raw, {
            skipPreflight: false,
            preflightCommitment: processed,
            maxRetries: 3,
          })
        );

        await confirmSignatureViaRpc(input.connection, sentSig, finality);
        return sentSig;
      } catch (e) {
        const msg = String((e as any)?.message ?? e ?? "");
        const lower = msg.toLowerCase();

        if (lower.includes("405") || lower.includes("method not allowed")) {
          throw new Error("RPC endpoint rejected request (HTTP 405). Check SOLANA_RPC_URL.");
        }

        const retryable =
          (lower.includes("blockhash") && (lower.includes("expired") || lower.includes("not found"))) ||
          lower.includes("block height exceeded") ||
          lower.includes("blockheight exceeded") ||
          lower.includes("timed out") ||
          lower.includes("timeout") ||
          lower.includes("node is behind");

        if (candidateSig) {
          try {
            await confirmSignatureViaRpc(input.connection, candidateSig, finality);
            return candidateSig;
          } catch {
            // ignore
          }
        }

        if (!retryable || attempt === maxAttempts - 1) throw e;
        await new Promise((r) => setTimeout(r, 350 + attempt * 500));
      }
    } catch (e) {
      if (attempt === maxAttempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 250 + attempt * 400));
    }
  }

  throw new Error("Failed to send Privy transaction");
}

async function sendSignedTransactionViaRpcWithRetries(input: {
  connection: Connection;
  build: (latest: { blockhash: string; lastValidBlockHeight: number }) => { tx: Transaction; signers: Keypair[] };
  maxAttempts?: number;
}): Promise<string> {
  const maxAttempts = Math.max(1, Math.min(6, Number(input.maxAttempts ?? 4) || 4));
  const processed = "processed" as Commitment;
  const finality = getServerCommitment();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const latest = await withRetry(() => input.connection.getLatestBlockhash(processed));
      const { tx, signers } = input.build(latest);

      tx.sign(...signers);

      let candidateSig = "";
      try {
        const sigBytes = tx.signatures?.[0]?.signature;
        if (sigBytes) candidateSig = bs58.encode(Uint8Array.from(sigBytes));
      } catch {
        // ignore
      }

      const raw = tx.serialize();

      try {
        const sentSig = await withRetry(() =>
          input.connection.sendRawTransaction(raw, {
            skipPreflight: false,
            preflightCommitment: processed,
            maxRetries: 3,
          })
        );

        await confirmSignatureViaRpc(input.connection, sentSig, finality);
        return sentSig;
      } catch (e) {
        const msg = String((e as any)?.message ?? e ?? "");
        const lower = msg.toLowerCase();

        if (lower.includes("405") || lower.includes("method not allowed")) {
          throw new Error("RPC endpoint rejected request (HTTP 405). Check SOLANA_RPC_URL.");
        }

        const retryable =
          (lower.includes("blockhash") && (lower.includes("expired") || lower.includes("not found"))) ||
          lower.includes("block height exceeded") ||
          lower.includes("blockheight exceeded") ||
          lower.includes("timed out") ||
          lower.includes("timeout") ||
          lower.includes("node is behind");

        if (candidateSig) {
          try {
            await confirmSignatureViaRpc(input.connection, candidateSig, finality);
            return candidateSig;
          } catch {
            // ignore
          }
        }

        if (!retryable || attempt === maxAttempts - 1) throw e;
        await new Promise((r) => setTimeout(r, 350 + attempt * 500));
      }
    } catch (e) {
      if (attempt === maxAttempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 250 + attempt * 400));
    }
  }

  throw new Error("Failed to send transaction");
}

export async function findSystemTransferSignature(input: {
  connection: Connection;
  fromPubkey: PublicKey;
  toPubkey: PublicKey;
  lamports: number;
  minBlockTimeUnix?: number;
  maxTransactionsToInspect?: number;
}): Promise<string | null> {
  const { connection, fromPubkey, toPubkey } = input;
  const lamports = Number(input.lamports);
  if (!Number.isFinite(lamports) || lamports <= 0) return null;

  const maxTransactionsToInspect = Math.max(1, Math.min(500, Number(input.maxTransactionsToInspect ?? 200) || 200));
  const minBlockTimeUnix = input.minBlockTimeUnix != null ? Number(input.minBlockTimeUnix) : null;

  const c = getServerCommitment();
  const finality: Finality = c === "finalized" ? "finalized" : "confirmed";

  let inspected = 0;
  let before: string | undefined;

  while (inspected < maxTransactionsToInspect) {
    const page = await withRetry(() => connection.getSignaturesForAddress(fromPubkey, { limit: 50, before }, finality));
    if (!page.length) break;

    for (const s of page) {
      const sig = String(s.signature ?? "").trim();
      if (!sig) continue;

      const bt = s.blockTime != null ? Number(s.blockTime) : null;
      if (minBlockTimeUnix != null && bt != null && bt < minBlockTimeUnix) return null;
      if (s.err) continue;

      inspected++;

      const tx = await withRetry(() =>
        connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: finality })
      );
      const ixs: any[] = (tx as any)?.transaction?.message?.instructions ?? [];
      for (const ix of ixs) {
        const program = String(ix?.program ?? "").toLowerCase();
        const parsed = ix?.parsed;
        const info = parsed?.info;
        if (program !== "system") continue;
        if (String(parsed?.type ?? "") !== "transfer") continue;

        const src = String(info?.source ?? "");
        const dst = String(info?.destination ?? "");
        const amt = Number(info?.lamports);
        if (src === fromPubkey.toBase58() && dst === toPubkey.toBase58() && amt === lamports) {
          return sig;
        }
      }

      if (inspected >= maxTransactionsToInspect) return null;
    }

    before = String(page[page.length - 1]?.signature ?? "").trim() || undefined;
    if (!before) break;
  }

  return null;
}

export async function closeNativeWsolTokenAccounts(input: {
  connection: Connection;
  owner: PublicKey;
  destination: PublicKey;
  signer: { kind: "privy"; walletId: string } | { kind: "keypair"; keypair: Keypair };
  maxAccountsToClose?: number;
}): Promise<{ closed: number; signatures: string[] }> {
  const { connection, owner, destination, signer } = input;
  const maxAccountsToClose = Math.max(1, Math.min(30, Number(input.maxAccountsToClose ?? 12) || 12));

  const c = getServerCommitment();
  const finality: Finality = c === "finalized" ? "finalized" : "confirmed";
  const res = await withRetry(() => connection.getParsedTokenAccountsByOwner(owner, { mint: WSOL_MINT }, finality));
  const tokenAccountsToClose: PublicKey[] = [];
  for (const a of res.value) {
    const parsed: any = a.account?.data?.parsed;
    const info = parsed?.info;
    const isNative = info?.isNative;
    const amountStr = info?.tokenAmount?.amount;
    const amount = typeof amountStr === "string" ? Number(amountStr) : 0;
    if (!isNative) continue;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    tokenAccountsToClose.push(a.pubkey);
    if (tokenAccountsToClose.length >= maxAccountsToClose) break;
  }

  if (!tokenAccountsToClose.length) return { closed: 0, signatures: [] };

  const feePayer = await getFeePayerKeypair();
  const processed = "processed" as const;

  let closed = 0;
  const signatures: string[] = [];

  for (let i = 0; i < tokenAccountsToClose.length; i += 3) {
    const batch = tokenAccountsToClose.slice(i, i + 3);
    if (!batch.length) break;

    const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash(processed));
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = feePayer ? feePayer.publicKey : owner;
    for (const ta of batch) {
      tx.add(buildCloseTokenAccountIx({ tokenAccount: ta, destination, owner }));
    }

    if (feePayer) tx.partialSign(feePayer);

    if (signer.kind === "keypair") {
      const signers = feePayer ? [feePayer, signer.keypair] : [signer.keypair];
      const signature = await withRetry(() => connection.sendTransaction(tx, signers, { skipPreflight: false, preflightCommitment: processed }));
      await confirmSignatureViaRpc(connection, signature, c);
      signatures.push(signature);
    } else {
      const signature = await privySignAndSendViaRpc({
        connection,
        walletId: String(signer.walletId),
        tx,
        feePayer,
      });
      signatures.push(signature);
    }

    closed += batch.length;
  }

  return { closed, signatures };
}

const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export async function getTokenMetadataUpdateAuthorityBase58(input: { connection: Connection; mint: PublicKey }): Promise<string | null> {
  const { connection, mint } = input;
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID
  );

  const c = getServerCommitment();
  const acct = await withRetry(() => connection.getAccountInfo(pda, c));
  if (!acct?.data || acct.data.length < 33) return null;

  const updateAuthorityBytes = acct.data.subarray(1, 33);
  return new PublicKey(updateAuthorityBytes).toBase58();
}

export function getSolanaCaip2(): string {
  const explicit = String(process.env.SOLANA_CAIP2 ?? "").trim();
  if (explicit) return explicit;

  const cluster = String(process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? process.env.SOLANA_CLUSTER ?? "mainnet-beta").trim();
  if (cluster === "devnet") return "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  if (cluster === "testnet") return "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";
  return "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
}

/**
 * Waits for a transaction to reach the configured commitment.
 * Throws code "TX_EXPIRED" once the blockhash is provably expired without the tx landing (safe to retry),
 * or code "TX_UNCERTAIN" if we simply ran out of patience (the tx may still land - do NOT blindly resend).
 */
export async function confirmTransactionSignature(input: {
  connection: Connection;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
}): Promise<void> {
  const sig = String(input.signature ?? "").trim();
  if (!sig) throw new Error("Missing signature");

  const desired = getServerCommitment();
  const satisfied = (status: string | null | undefined) => {
    const c = String(status ?? "");
    if (desired === "processed") return c === "processed" || c === "confirmed" || c === "finalized";
    if (desired === "finalized") return c === "finalized";
    return c === "confirmed" || c === "finalized";
  };

  const check = async (): Promise<boolean> => {
    const st = await withRetry(() => input.connection.getSignatureStatuses([sig], { searchTransactionHistory: true }));
    const s = st?.value?.[0] as any;
    if (s?.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
    return Boolean(s?.confirmationStatus) && satisfied(s.confirmationStatus);
  };

  const start = Date.now();
  const timeoutMs = 90_000;
  const lastValid = Number(input.lastValidBlockHeight ?? 0);

  while (Date.now() - start < timeoutMs) {
    if (await check()) return;

    if (lastValid > 0) {
      const height = await withRetry(() => input.connection.getBlockHeight("confirmed"));
      if (height > lastValid) {
        if (await check()) return;
        throw Object.assign(new Error("Transaction expired before it was confirmed"), { code: "TX_EXPIRED" });
      }
    }

    await new Promise((r) => setTimeout(r, 1200));
  }

  throw Object.assign(new Error("Transaction confirmation timeout"), { code: "TX_UNCERTAIN" });
}

/** Waits (bounded) for a signature to be confirmed. Returns false if it never showed up in time. */
export async function waitForSignatureConfirmed(input: { connection: Connection; signature: string; timeoutMs?: number }): Promise<boolean> {
  const sig = String(input.signature ?? "").trim();
  if (!sig) return false;
  const timeoutMs = Math.max(1000, input.timeoutMs ?? 25_000);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await withRetry(() => input.connection.getSignatureStatuses([sig], { searchTransactionHistory: true }));
    const s = st?.value?.[0] as any;
    if (s?.err) return false;
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export async function transferLamportsFromPrivyWallet(opts: {
  connection: Connection;
  walletId: string;
  fromPubkey: PublicKey;
  to: PublicKey;
  lamports: number;
}): Promise<{ signature: string; amountLamports: number }> {
  const { connection, fromPubkey, to } = opts;
  const lamports = Number(opts.lamports);
  if (!Number.isFinite(lamports) || lamports <= 0) throw new Error("Invalid lamports");

  const feePayer = await getFeePayerKeypair();
  const c = getServerCommitment();
  const processed = "processed" as const;
  const balance = await withRetry(() => connection.getBalance(fromPubkey, c));
  if (balance < lamports) throw new Error("Insufficient balance");
  const tx = new Transaction();
  const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash(processed));
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = feePayer ? feePayer.publicKey : fromPubkey;
  tx.add(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey: to,
      lamports,
    })
  );

  if (!feePayer) {
    const msg = tx.compileMessage();
    const fee = await withRetry(() => connection.getFeeForMessage(msg, c));
    const feeLamports = fee.value ?? 5000;
    if (balance < lamports + feeLamports) throw new Error("Insufficient balance to cover amount + fees");
  } else {
    const feePayerBalance = await withRetry(() => connection.getBalance(feePayer.publicKey, c));
    const msg = tx.compileMessage();
    const fee = await withRetry(() => connection.getFeeForMessage(msg, c));
    const feeLamports = fee.value ?? 5000;
    if (feePayerBalance < feeLamports) throw new Error("Insufficient fee payer balance");
  }

  const signature = await privySignAndSendViaRpc({ connection, walletId: String(opts.walletId), tx, feePayer });
  return { signature, amountLamports: lamports };
}

export async function findRecentSystemTransferSignature(input: {
  connection: Connection;
  fromPubkey: PublicKey;
  toPubkey: PublicKey;
  lamports: number;
  limit?: number;
}): Promise<string | null> {
  const { connection, fromPubkey, toPubkey } = input;
  const lamports = Number(input.lamports);
  if (!Number.isFinite(lamports) || lamports <= 0) return null;

  const limit = Math.max(1, Math.min(50, Number(input.limit ?? 20) || 20));
  const c = getServerCommitment();
  const finality: Finality = c === "finalized" ? "finalized" : "confirmed";

  const sigs = await withRetry(() => connection.getSignaturesForAddress(fromPubkey, { limit }, finality));
  for (const s of sigs) {
    const sig = String(s.signature ?? "").trim();
    if (!sig) continue;

    const tx = await withRetry(() => connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: finality }));
    const ixs: any[] = (tx as any)?.transaction?.message?.instructions ?? [];
    for (const ix of ixs) {
      const program = String(ix?.program ?? "").toLowerCase();
      const parsed = ix?.parsed;
      const info = parsed?.info;
      if (program !== "system") continue;
      if (String(parsed?.type ?? "") !== "transfer") continue;

      const src = String(info?.source ?? "");
      const dst = String(info?.destination ?? "");
      const amt = Number(info?.lamports);
      if (src === fromPubkey.toBase58() && dst === toPubkey.toBase58() && amt === lamports) {
        return sig;
      }
    }
  }

  return null;
}

export async function transferAllLamportsFromPrivyWallet(opts: {
  connection: Connection;
  walletId: string;
  fromPubkey: PublicKey;
  to: PublicKey;
}): Promise<{ signature: string; amountLamports: number }> {
  const { connection, fromPubkey, to } = opts;

  const feePayer = await getFeePayerKeypair();
  const c = getServerCommitment();
  const processed = "processed" as const;
  const balance = await withRetry(() => connection.getBalance(fromPubkey, c));
  if (balance <= 0) throw new Error("No lamports to transfer");
  const tx = new Transaction();
  const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash(processed));
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = feePayer ? feePayer.publicKey : fromPubkey;

  let lamportsToSend = balance;
  tx.add(SystemProgram.transfer({ fromPubkey, toPubkey: to, lamports: lamportsToSend }));

  if (!feePayer) {
    const msg = tx.compileMessage();
    const fee = await withRetry(() => connection.getFeeForMessage(msg, c));
    const feeLamports = fee.value ?? 5000;
    lamportsToSend = balance - feeLamports;
    if (lamportsToSend <= 0) throw new Error("Insufficient balance to cover fees");

    tx.instructions[0] = SystemProgram.transfer({ fromPubkey, toPubkey: to, lamports: lamportsToSend });
  } else {
    const feePayerBalance = await withRetry(() => connection.getBalance(feePayer.publicKey, c));
    const msg = tx.compileMessage();
    const fee = await withRetry(() => connection.getFeeForMessage(msg, c));
    const feeLamports = fee.value ?? 5000;
    if (feePayerBalance < feeLamports) throw new Error("Insufficient fee payer balance");
  }

  const signature = await privySignAndSendViaRpc({ connection, walletId: String(opts.walletId), tx, feePayer });
  return { signature, amountLamports: lamportsToSend };
}

async function getFeePayerKeypair(): Promise<Keypair | null> {
  const s = process.env.ESCROW_FEE_PAYER_SECRET_KEY;
  if (!s) return null;
  return keypairFromBase58Secret(s);
}

export async function transferLamports(opts: {
  connection: Connection;
  from: Keypair;
  to: PublicKey;
  lamports: number;
}): Promise<{ signature: string; amountLamports: number }> {
  const { connection, from, to } = opts;
  const lamports = Number(opts.lamports);
  if (!Number.isFinite(lamports) || lamports <= 0) throw new Error("Invalid lamports");

  const feePayer = await getFeePayerKeypair();
  const c = getServerCommitment();
  const processed = "processed" as const;
  const balance = await withRetry(() => connection.getBalance(from.publicKey, c));

  const tx = new Transaction();

  if (!feePayer) {
    const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash(processed));
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = from.publicKey;

    tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));

    const msg = tx.compileMessage();
    const fee = await withRetry(() => connection.getFeeForMessage(msg, c));
    const feeLamports = fee.value ?? 5000;
    if (balance < lamports + feeLamports) throw new Error("Insufficient balance to cover amount + fees");

    const signature = await sendSignedTransactionViaRpcWithRetries({
      connection,
      build: (latest) => {
        const t = new Transaction();
        t.recentBlockhash = latest.blockhash;
        t.lastValidBlockHeight = latest.lastValidBlockHeight;
        t.feePayer = from.publicKey;
        t.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
        return { tx: t, signers: [from] };
      },
    });
    return { signature, amountLamports: lamports };
  }

  if (balance < lamports) throw new Error("Insufficient balance");

  const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash(processed));
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = feePayer.publicKey;

  tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));

  const signature = await sendSignedTransactionViaRpcWithRetries({
    connection,
    build: (latest) => {
      const t = new Transaction();
      t.recentBlockhash = latest.blockhash;
      t.lastValidBlockHeight = latest.lastValidBlockHeight;
      t.feePayer = feePayer.publicKey;
      t.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
      return { tx: t, signers: [feePayer, from] };
    },
  });
  return { signature, amountLamports: lamports };
}

export async function transferAllLamports(opts: {
  connection: Connection;
  from: Keypair;
  to: PublicKey;
}): Promise<{ signature: string; amountLamports: number }> {
  const { connection, from, to } = opts;

  const feePayer = await getFeePayerKeypair();
  const c = getServerCommitment();
  const processed = "processed" as const;
  const balance = await withRetry(() => connection.getBalance(from.publicKey, c));
  if (balance <= 0) throw new Error("No lamports to transfer");

  const tx = new Transaction();

  let lamportsToSend = balance;
  if (!feePayer) {
    const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash(processed));
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = from.publicKey;

    tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: balance }));

    const msg = tx.compileMessage();
    const fee = await withRetry(() => connection.getFeeForMessage(msg, c));
    const feeLamports = fee.value ?? 5000;
    lamportsToSend = balance - feeLamports;
    if (lamportsToSend <= 0) throw new Error("Insufficient balance to cover fees");

    const signature = await sendSignedTransactionViaRpcWithRetries({
      connection,
      build: (latest) => {
        const t = new Transaction();
        t.recentBlockhash = latest.blockhash;
        t.lastValidBlockHeight = latest.lastValidBlockHeight;
        t.feePayer = from.publicKey;
        t.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: lamportsToSend }));
        return { tx: t, signers: [from] };
      },
    });
    return { signature, amountLamports: lamportsToSend };
  }

  const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash(processed));
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = feePayer.publicKey;

  tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: lamportsToSend }));

  const signature = await sendSignedTransactionViaRpcWithRetries({
    connection,
    build: (latest) => {
      const t = new Transaction();
      t.recentBlockhash = latest.blockhash;
      t.lastValidBlockHeight = latest.lastValidBlockHeight;
      t.feePayer = feePayer.publicKey;
      t.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: lamportsToSend }));
      return { tx: t, signers: [feePayer, from] };
    },
  });
  return { signature, amountLamports: lamportsToSend };
}
