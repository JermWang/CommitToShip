import { Connection, Finality, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

import {
  TxSendError,
  buildPriorityFeeInstructions,
  getConnection as getConnectionRpc,
  getServerCommitment,
  getSignatureOutcome,
  isComputeBudgetInstruction,
  sendAndConfirmDurable,
  withRetry,
} from "./rpc";
import type { DurablePreparedInfo } from "./rpc";
import { privySignSolanaTransaction } from "./privy";

export {
  TxSendError,
  getSignatureOutcome,
  isTxDefinitelyNotLanded,
  isTxSendError,
  sendAndConfirmDurable,
  buildPriorityFeeInstructions,
  getPriorityFeeMicroLamports,
  signatureFromRawTransaction,
} from "./rpc";
export type { DurablePreparedInfo, SignatureOutcome, TxSendErrorCode } from "./rpc";

/** Hook every payout helper accepts: called with the signature BEFORE broadcast; return false to abort unsent. */
export type OnPreparedHook = (info: DurablePreparedInfo) => Promise<boolean | void> | boolean | void;

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Rent-exempt minimum of a 0-byte system account (wallet). Used as a fallback when the RPC can't be asked. */
export const SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS = 890_880;

/** Compute units reserved for a plain SOL transfer (+ the two compute-budget instructions ≈ 450 CU). */
const SYSTEM_TRANSFER_COMPUTE_UNITS = 2_000;

function httpError(status: number, message: string, body?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { status, ...(body ? { body } : {}) });
}

function buildCloseTokenAccountIx(input: { tokenAccount: PublicKey; destination: PublicKey; owner: PublicKey; tokenProgram?: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: input.tokenProgram ?? TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: input.tokenAccount, isSigner: false, isWritable: true },
      { pubkey: input.destination, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

export function buildCloseTokenAccountInstruction(input: { tokenAccount: PublicKey; destination: PublicKey; owner: PublicKey; tokenProgram?: PublicKey }): TransactionInstruction {
  return buildCloseTokenAccountIx(input);
}

export async function getTokenProgramIdForMint(input: { connection: Connection; mint: PublicKey }): Promise<PublicKey> {
  const info = await withRetry(() => input.connection.getAccountInfo(input.mint, getServerCommitment()));
  const owner = info?.owner;
  if (!owner) throw new Error("Mint not found");
  return owner;
}

/** Decimals of an SPL / Token-2022 mint (byte 44 of the mint layout, identical for both programs). */
export async function getMintDecimals(input: { connection: Connection; mint: PublicKey }): Promise<number> {
  const info = await withRetry(() => input.connection.getAccountInfo(input.mint, getServerCommitment()));
  if (!info?.data || info.data.length < 45) throw new Error("Mint not found");
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("Account is not a token mint");
  return info.data[44];
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

/**
 * SPL token transfer. When `mint` and `decimals` are given this is TransferChecked (required by Token-2022 mints
 * with extensions, and what wallets/explorers expect); otherwise the legacy Transfer instruction.
 */
export function buildSplTokenTransferInstruction(input: {
  sourceAta: PublicKey;
  destinationAta: PublicKey;
  owner: PublicKey;
  amountRaw: bigint;
  tokenProgram?: PublicKey;
  mint?: PublicKey;
  decimals?: number;
}): TransactionInstruction {
  const tokenProgram = input.tokenProgram ?? TOKEN_PROGRAM_ID;
  const amountRaw = BigInt(input.amountRaw);
  if (amountRaw <= 0n) throw new Error("amountRaw must be > 0");

  if (input.mint && input.decimals != null) {
    const decimals = Math.floor(Number(input.decimals));
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 255) throw new Error("Invalid decimals");
    return new TransactionInstruction({
      programId: tokenProgram,
      keys: [
        { pubkey: input.sourceAta, isSigner: false, isWritable: true },
        { pubkey: input.mint, isSigner: false, isWritable: false },
        { pubkey: input.destinationAta, isSigner: false, isWritable: true },
        { pubkey: input.owner, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([12]), u64le(amountRaw), Buffer.from([decimals])]),
    });
  }

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

// ---------------------------------------------------------------------------------------------------------------------
// Fee payer, rent floor
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The platform fee payer. In production it is mandatory: escrows must never pay their own fees (that leaks escrow
 * funds and breaks "transfer everything" math). Outside production a missing key falls back to the escrow paying.
 */
async function getFeePayerKeypair(): Promise<Keypair | null> {
  const s = String(process.env.ESCROW_FEE_PAYER_SECRET_KEY ?? "").trim();
  if (!s) {
    if (process.env.NODE_ENV === "production") {
      throw httpError(503, "ESCROW_FEE_PAYER_SECRET_KEY is required in production for payouts");
    }
    return null;
  }
  return keypairFromBase58Secret(s);
}

/** Public accessor for the platform fee payer (null outside production when unset). */
export async function getEscrowFeePayerKeypair(): Promise<Keypair | null> {
  return getFeePayerKeypair();
}

const rentCache = new Map<number, number>();

export async function getRentExemptMinLamports(connection: Connection, dataLength = 0): Promise<number> {
  const len = Math.max(0, Math.floor(dataLength));
  const cached = rentCache.get(len);
  if (cached != null) return cached;
  try {
    const v = await withRetry(() => connection.getMinimumBalanceForRentExemption(len));
    if (Number.isFinite(v) && v > 0) {
      rentCache.set(len, v);
      return v;
    }
  } catch {
    // fall through
  }
  if (len === 0) return SYSTEM_ACCOUNT_RENT_EXEMPT_LAMPORTS;
  if (len === 165) return 2_039_280;
  throw new Error("Could not determine rent-exempt minimum");
}

/**
 * Lamports an escrow can pay out while staying valid on-chain: balance − reserved − rent-exempt minimum.
 * (A system account may end at exactly 0, but never between 0 and the rent-exempt minimum.)
 */
export async function getSpendableLamports(input: { connection: Connection; balanceLamports: number; reservedLamports?: number }): Promise<number> {
  const rentMin = await getRentExemptMinLamports(input.connection, 0);
  return Math.max(0, Math.floor(Number(input.balanceLamports) - Number(input.reservedLamports ?? 0) - rentMin));
}

// ---------------------------------------------------------------------------------------------------------------------
// Signing helpers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Has Privy sign `tx` (already carrying any local partial signatures) and checks that what came back is the SAME
 * message with every required signature present and valid. Returns the wire bytes.
 */
export async function privySignTransactionVerified(input: { walletId: string; tx: Transaction }): Promise<Buffer> {
  const expectedMessage = Buffer.from(input.tx.serializeMessage());
  const txBase64 = input.tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const signed = await privySignSolanaTransaction({ walletId: String(input.walletId), transactionBase64: txBase64 });
  const raw = Buffer.from(String(signed.signedTransactionBase64 ?? ""), "base64");
  const parsed = Transaction.from(raw);
  if (!Buffer.from(parsed.serializeMessage()).equals(expectedMessage)) {
    throw new Error("Privy returned a different transaction than the one it was asked to sign");
  }
  if (!parsed.verifySignatures(true)) {
    throw new Error("Signed transaction is missing a required signature");
  }
  return raw;
}

export type PayoutSigner = { kind: "privy"; walletId: string; pubkey: PublicKey } | { kind: "keypair"; keypair: Keypair };

function signerPubkey(s: PayoutSigner): PublicKey {
  return s.kind === "privy" ? s.pubkey : s.keypair.publicKey;
}

/**
 * Builds a legacy transaction from `instructions` (plus priority-fee instructions) paid by the platform fee payer
 * (or `signer` when there is none), signs it with the fee payer + `signer` (Privy or keypair) and sends it through
 * the durable state machine. `onPrepared` receives the signature before the first broadcast.
 */
export async function signAndSendInstructions(input: {
  connection: Connection;
  signer: PayoutSigner;
  instructions: TransactionInstruction[];
  feePayer?: Keypair | null;
  computeUnits?: number;
  onPrepared?: OnPreparedHook;
  maxRebuilds?: number;
}): Promise<{ signature: string; lastValidBlockHeight: number; priorityFeeLamports: number }> {
  const { connection, signer } = input;
  const feePayer = input.feePayer === undefined ? await getFeePayerKeypair() : input.feePayer;
  const payer = feePayer ? feePayer.publicKey : signerPubkey(signer);
  const core = input.instructions.filter((ix) => !isComputeBudgetInstruction(ix));
  const pf = await buildPriorityFeeInstructions({
    connection,
    payer,
    instructions: core,
    fallbackUnits: input.computeUnits ?? 200_000,
    // A fixed budget skips the simulation; otherwise the limit is sized from simulated usage × 1.2.
    simulate: input.computeUnits == null,
  });
  const cbIxs = pf.instructions;

  const res = await sendAndConfirmDurable({
    connection,
    onPrepared: input.onPrepared,
    maxRebuilds: input.maxRebuilds,
    sign: async (latest) => {
      const tx = new Transaction({ feePayer: payer, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight });
      tx.add(...cbIxs, ...core);
      if (signer.kind === "keypair") {
        const signers = feePayer && !feePayer.publicKey.equals(signer.keypair.publicKey) ? [feePayer, signer.keypair] : [signer.keypair];
        tx.sign(...signers);
        return tx.serialize();
      }
      if (feePayer) tx.partialSign(feePayer);
      return await privySignTransactionVerified({ walletId: signer.walletId, tx });
    },
  });
  return { signature: res.signature, lastValidBlockHeight: res.lastValidBlockHeight, priorityFeeLamports: pf.priorityFeeLamports };
}

/**
 * Validates a transaction a USER signed against the exact instructions the server expects (H4):
 *  - every non-compute-budget instruction must equal `expectedInstructions`, in order (no extras, so no
 *    AdvanceNonceAccount / durable nonce, no extra transfers);
 *  - compute-budget instructions are allowed only as one SetComputeUnitLimit and one SetComputeUnitPrice (wallets add
 *    them; the user pays the fee);
 *  - the message bytes must equal a server-rebuilt message (same fee payer, blockhash, header, account list).
 */
export function verifyExactUserTransaction(input: {
  tx: Transaction;
  feePayer: PublicKey;
  expectedInstructions: TransactionInstruction[];
}): { ok: true } | { ok: false; reason: string } {
  const { tx } = input;
  if (!tx.recentBlockhash) return { ok: false, reason: "Transaction has no recent blockhash" };
  if (!tx.feePayer || !tx.feePayer.equals(input.feePayer)) return { ok: false, reason: "Transaction fee payer does not match wallet" };
  if ((tx as any).nonceInfo) return { ok: false, reason: "Durable-nonce transactions are not accepted" };

  const nonCb = tx.instructions.filter((ix) => !isComputeBudgetInstruction(ix));
  const cb = tx.instructions.filter((ix) => isComputeBudgetInstruction(ix));

  if (nonCb.length !== input.expectedInstructions.length) {
    const systemNonce = nonCb.some((ix) => ix.programId.equals(SystemProgram.programId) && ix.data?.[0] === 4);
    return { ok: false, reason: systemNonce ? "Durable-nonce (AdvanceNonceAccount) instructions are not accepted" : "Transaction contains unexpected instructions" };
  }
  for (let i = 0; i < nonCb.length; i++) {
    if (!instructionsEqual(nonCb[i], input.expectedInstructions[i])) return { ok: false, reason: "Transaction instructions do not match the prepared claim" };
  }

  let limits = 0;
  let prices = 0;
  for (const ix of cb) {
    if (ix.keys.length !== 0) return { ok: false, reason: "Invalid compute budget instruction" };
    const kind = ix.data?.[0];
    if (kind === 2 && ix.data.length === 5) limits++;
    else if (kind === 3 && ix.data.length === 9) prices++;
    else return { ok: false, reason: "Unsupported compute budget instruction" };
  }
  if (limits > 1 || prices > 1) return { ok: false, reason: "Duplicate compute budget instructions" };

  // Rebuild with the server's own instruction objects in the user's order and compare the message bytes.
  const rebuilt = new Transaction({ feePayer: input.feePayer, blockhash: tx.recentBlockhash, lastValidBlockHeight: 0 });
  let e = 0;
  for (const ix of tx.instructions) {
    rebuilt.add(isComputeBudgetInstruction(ix) ? ix : input.expectedInstructions[e++]);
  }
  const a = Buffer.from(tx.serializeMessage());
  const b = Buffer.from(rebuilt.serializeMessage());
  if (!a.equals(b)) return { ok: false, reason: "Signed transaction does not match expected claim" };
  return { ok: true };
}

/**
 * Same program, data and account order. Signer/writable flags are NOT compared here: after deserialization they are
 * account-level (a key that is the fee payer is signer+writable in every instruction); the message-bytes comparison
 * against the server-rebuilt message is what pins the header and flags.
 */
function instructionsEqual(a: TransactionInstruction, b: TransactionInstruction): boolean {
  if (!a.programId.equals(b.programId)) return false;
  if (!Buffer.from(a.data).equals(Buffer.from(b.data))) return false;
  if (a.keys.length !== b.keys.length) return false;
  for (let i = 0; i < a.keys.length; i++) {
    if (!a.keys[i].pubkey.equals(b.keys[i].pubkey)) return false;
  }
  return true;
}

/**
 * Upper bound for the lastValidBlockHeight of a blockhash that is valid right now: a blockhash expires 150 blocks
 * after its own block, and its block is at or below the current processed height. Returns null when it is not valid.
 */
export async function getBlockhashExpiryBound(connection: Connection, blockhash: string): Promise<number | null> {
  const valid = await withRetry(() => connection.isBlockhashValid(blockhash, { commitment: "processed" }));
  if (!valid?.value) return null;
  const height = await withRetry(() => connection.getBlockHeight("processed"));
  return height + 151;
}

// ---------------------------------------------------------------------------------------------------------------------
// SPL transfers
// ---------------------------------------------------------------------------------------------------------------------

async function transferSplTokensCore(opts: {
  connection: Connection;
  mint: PublicKey;
  signer: PayoutSigner;
  toOwner: PublicKey;
  amountRaw: bigint;
  tokenProgram?: PublicKey;
  onPrepared?: OnPreparedHook;
}): Promise<{ signature: string; amountRaw: bigint }> {
  const { connection, mint, toOwner } = opts;
  const amountRaw = BigInt(opts.amountRaw);
  if (amountRaw <= 0n) throw new Error("amountRaw must be > 0");

  const tokenProgram = opts.tokenProgram ?? (await getTokenProgramIdForMint({ connection, mint }));
  const decimals = await getMintDecimals({ connection, mint });
  const feePayer = await getFeePayerKeypair();
  const fromOwner = signerPubkey(opts.signer);
  const payer = feePayer ? feePayer.publicKey : fromOwner;

  const sourceAta = getAssociatedTokenAddress({ owner: fromOwner, mint, tokenProgram });
  const { ix: createIx, ata: destinationAta } = buildCreateAssociatedTokenAccountIdempotentInstruction({ payer, owner: toOwner, mint, tokenProgram });
  const transferIx = buildSplTokenTransferInstruction({ sourceAta, destinationAta, owner: fromOwner, amountRaw, tokenProgram, mint, decimals });

  const { signature } = await signAndSendInstructions({
    connection,
    signer: opts.signer,
    feePayer,
    instructions: [createIx, transferIx],
    onPrepared: opts.onPrepared,
  });
  return { signature, amountRaw };
}

export async function transferSplTokensFromKeypair(opts: {
  connection: Connection;
  mint: PublicKey;
  from: Keypair;
  toOwner: PublicKey;
  amountRaw: bigint;
  tokenProgram?: PublicKey;
  onPrepared?: OnPreparedHook;
}): Promise<{ signature: string; amountRaw: bigint }> {
  return transferSplTokensCore({ ...opts, signer: { kind: "keypair", keypair: opts.from } });
}

export async function transferSplTokensFromPrivyWallet(opts: {
  connection: Connection;
  mint: PublicKey;
  walletId: string;
  fromOwner: PublicKey;
  toOwner: PublicKey;
  amountRaw: bigint;
  tokenProgram?: PublicKey;
  onPrepared?: OnPreparedHook;
}): Promise<{ signature: string; amountRaw: bigint }> {
  return transferSplTokensCore({ ...opts, signer: { kind: "privy", walletId: String(opts.walletId), pubkey: opts.fromOwner } });
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


type TransferMatchOptions = {
  /** Signatures that are already accounted for (e.g. paid claims) and must never be returned again. */
  excludeSignatures?: string[];
  /** When several transactions match, return null instead of the newest one (no guessing). Default "first". */
  onAmbiguous?: "first" | "null";
};

function matchesSystemTransfer(tx: any, from: string, to: string, lamports: number): boolean {
  const ixs: any[] = tx?.transaction?.message?.instructions ?? [];
  for (const ix of ixs) {
    const program = String(ix?.program ?? "").toLowerCase();
    const parsed = ix?.parsed;
    const info = parsed?.info;
    if (program !== "system") continue;
    if (String(parsed?.type ?? "") !== "transfer") continue;
    if (String(info?.source ?? "") === from && String(info?.destination ?? "") === to && Number(info?.lamports) === lamports) return true;
  }
  return false;
}

/**
 * Heuristic lookup of a past SOL transfer by (from, to, lamports). Only for legacy records that never stored a
 * signature: amounts can repeat, so callers should pass `excludeSignatures` and `onAmbiguous: "null"`.
 */
export async function findSystemTransferSignature(input: {
  connection: Connection;
  fromPubkey: PublicKey;
  toPubkey: PublicKey;
  lamports: number;
  minBlockTimeUnix?: number;
  maxTransactionsToInspect?: number;
} & TransferMatchOptions): Promise<string | null> {
  const { connection, fromPubkey, toPubkey } = input;
  const lamports = Number(input.lamports);
  if (!Number.isFinite(lamports) || lamports <= 0) return null;

  const maxTransactionsToInspect = Math.max(1, Math.min(500, Number(input.maxTransactionsToInspect ?? 200) || 200));
  const minBlockTimeUnix = input.minBlockTimeUnix != null ? Number(input.minBlockTimeUnix) : null;
  const exclude = new Set((input.excludeSignatures ?? []).map((s) => String(s).trim()).filter(Boolean));
  const ambiguousNull = input.onAmbiguous === "null";

  const c = getServerCommitment();
  const finality: Finality = c === "finalized" ? "finalized" : "confirmed";

  let inspected = 0;
  let before: string | undefined;
  const matches: string[] = [];

  outer: while (inspected < maxTransactionsToInspect) {
    const page = await withRetry(() => connection.getSignaturesForAddress(fromPubkey, { limit: 50, before }, finality));
    if (!page.length) break;

    for (const s of page) {
      const sig = String(s.signature ?? "").trim();
      if (!sig) continue;

      const bt = s.blockTime != null ? Number(s.blockTime) : null;
      if (minBlockTimeUnix != null && bt != null && bt < minBlockTimeUnix) break outer;
      if (s.err) continue;
      if (exclude.has(sig)) continue;

      inspected++;

      const tx = await withRetry(() => connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: finality }));
      if (matchesSystemTransfer(tx, fromPubkey.toBase58(), toPubkey.toBase58(), lamports)) {
        if (!ambiguousNull) return sig;
        matches.push(sig);
        if (matches.length > 1) return null;
      }

      if (inspected >= maxTransactionsToInspect) break outer;
    }

    before = String(page[page.length - 1]?.signature ?? "").trim() || undefined;
    if (!before) break;
  }

  return matches.length === 1 ? matches[0] : null;
}

export async function closeNativeWsolTokenAccounts(input: {
  connection: Connection;
  owner: PublicKey;
  destination: PublicKey;
  signer: { kind: "privy"; walletId: string } | { kind: "keypair"; keypair: Keypair };
  maxAccountsToClose?: number;
  onPrepared?: OnPreparedHook;
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
  const payoutSigner: PayoutSigner =
    signer.kind === "keypair" ? { kind: "keypair", keypair: signer.keypair } : { kind: "privy", walletId: String(signer.walletId), pubkey: owner };

  let closed = 0;
  const signatures: string[] = [];

  for (let i = 0; i < tokenAccountsToClose.length; i += 3) {
    const batch = tokenAccountsToClose.slice(i, i + 3);
    if (!batch.length) break;

    // Closing is naturally idempotent (a closed account can't be closed twice), so a rebuild can't double-move funds.
    const { signature } = await signAndSendInstructions({
      connection,
      signer: payoutSigner,
      feePayer,
      instructions: batch.map((ta) => buildCloseTokenAccountIx({ tokenAccount: ta, destination, owner })),
      computeUnits: 20_000,
      onPrepared: input.onPrepared,
    });
    signatures.push(signature);
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
 * Throws code "TX_FAILED" when it landed with an error, "TX_EXPIRED" once the blockhash is provably expired without
 * the tx landing (safe to retry), or "TX_UNCERTAIN" if we simply ran out of patience (it may still land - do NOT
 * blindly resend). With lastValidBlockHeight 0 expiry can't be proven, so the only outcomes are confirmed/failed/uncertain.
 */
export async function confirmTransactionSignature(input: {
  connection: Connection;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  timeoutMs?: number;
}): Promise<void> {
  const sig = String(input.signature ?? "").trim();
  if (!sig) throw new Error("Missing signature");

  const start = Date.now();
  const timeoutMs = Math.max(5_000, Number(input.timeoutMs ?? 100_000));
  const lastValid = Number(input.lastValidBlockHeight ?? 0);

  while (Date.now() - start < timeoutMs) {
    let state: Awaited<ReturnType<typeof getSignatureOutcome>>;
    try {
      state = await getSignatureOutcome(input.connection, sig, lastValid > 0 ? lastValid : null);
    } catch {
      state = { outcome: "pending" };
    }
    if (state.outcome === "confirmed") return;
    if (state.outcome === "failed") {
      throw new TxSendError("TX_FAILED", `Transaction failed: ${JSON.stringify(state.err)}`, { signature: sig, lastValidBlockHeight: lastValid || null, noEffect: true, chainError: state.err });
    }
    if (state.outcome === "expired") {
      throw new TxSendError("TX_EXPIRED", "Transaction expired before it was confirmed", { signature: sig, lastValidBlockHeight: lastValid, noEffect: true });
    }
    await new Promise((r) => setTimeout(r, 1200));
  }

  throw new TxSendError("TX_UNCERTAIN", "Transaction confirmation timeout", { signature: sig, lastValidBlockHeight: lastValid || null, noEffect: false });
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

/**
 * One SOL payout from an escrow (Privy wallet or local keypair) through the durable send path.
 *  - `lamports: "all"` empties the account (fees come out of it only when there is no platform fee payer);
 *  - otherwise the escrow must end at 0 or ≥ the rent-exempt minimum (else the runtime rejects the transfer);
 *  - a brand-new recipient must receive at least the rent-exempt minimum.
 */
async function transferLamportsCore(opts: {
  connection: Connection;
  signer: PayoutSigner;
  to: PublicKey;
  lamports: number | "all";
  onPrepared?: OnPreparedHook;
}): Promise<{ signature: string; amountLamports: number }> {
  const { connection, to } = opts;
  const from = signerPubkey(opts.signer);
  if (from.equals(to)) throw httpError(400, "Source and destination are the same account");

  const feePayer = await getFeePayerKeypair();
  const c = getServerCommitment();
  const [balance, rentMin] = await Promise.all([
    withRetry(() => connection.getBalance(from, c)),
    getRentExemptMinLamports(connection, 0),
  ]);

  const payer = feePayer ? feePayer.publicKey : from;
  const placeholder = SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: 1 });
  const pf = await buildPriorityFeeInstructions({ connection, payer, instructions: [placeholder], fallbackUnits: SYSTEM_TRANSFER_COMPUTE_UNITS, simulate: false });
  const signatureCount = feePayer && !feePayer.publicKey.equals(from) ? 2 : 1;
  let feeLamports = 5_000 * signatureCount + pf.priorityFeeLamports;
  try {
    const msg = new Transaction({ feePayer: payer, blockhash: bs58.encode(new Uint8Array(32)), lastValidBlockHeight: 0 }).add(...pf.instructions, placeholder).compileMessage();
    const rpcFee = await withRetry(() => connection.getFeeForMessage(msg, c));
    if (rpcFee?.value != null && Number(rpcFee.value) > feeLamports) feeLamports = Number(rpcFee.value);
  } catch {
    // the local estimate already includes base + priority fee
  }

  const escrowPaysFees = !feePayer;
  let lamportsToSend: number;
  if (opts.lamports === "all") {
    lamportsToSend = balance - (escrowPaysFees ? feeLamports : 0);
    if (balance <= 0) throw httpError(409, "No lamports to transfer");
    if (lamportsToSend <= 0) throw httpError(409, "Insufficient balance to cover fees");
  } else {
    lamportsToSend = Math.floor(Number(opts.lamports));
    if (!Number.isFinite(lamportsToSend) || lamportsToSend <= 0) throw httpError(400, "Invalid lamports");
    const remaining = balance - lamportsToSend - (escrowPaysFees ? feeLamports : 0);
    if (remaining < 0) {
      throw httpError(409, escrowPaysFees ? "Insufficient balance to cover amount + fees" : "Insufficient balance", { balanceLamports: balance, requiredLamports: lamportsToSend });
    }
    if (remaining > 0 && remaining < rentMin) {
      throw httpError(409, "Payout would leave the escrow below the rent-exempt minimum", { balanceLamports: balance, requiredLamports: lamportsToSend, rentExemptMinLamports: rentMin });
    }
  }

  if (lamportsToSend < rentMin) {
    const toBalance = await withRetry(() => connection.getBalance(to, c));
    if (toBalance <= 0) {
      throw httpError(409, "Payout is below the rent-exempt minimum for a new (empty) recipient account", { amountLamports: lamportsToSend, rentExemptMinLamports: rentMin });
    }
  }

  if (feePayer) {
    const feePayerBalance = await withRetry(() => connection.getBalance(feePayer.publicKey, c));
    if (feePayerBalance - feeLamports < rentMin) throw httpError(503, "Insufficient fee payer balance");
  }

  const transferIx = SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: lamportsToSend });
  const { signature } = await signAndSendInstructions({
    connection,
    signer: opts.signer,
    feePayer,
    instructions: [transferIx],
    computeUnits: SYSTEM_TRANSFER_COMPUTE_UNITS,
    onPrepared: opts.onPrepared,
  });
  return { signature, amountLamports: lamportsToSend };
}

export async function transferLamportsFromPrivyWallet(opts: {
  connection: Connection;
  walletId: string;
  fromPubkey: PublicKey;
  to: PublicKey;
  lamports: number;
  onPrepared?: OnPreparedHook;
}): Promise<{ signature: string; amountLamports: number }> {
  return transferLamportsCore({
    connection: opts.connection,
    signer: { kind: "privy", walletId: String(opts.walletId), pubkey: opts.fromPubkey },
    to: opts.to,
    lamports: Number(opts.lamports),
    onPrepared: opts.onPrepared,
  });
}

export async function findRecentSystemTransferSignature(input: {
  connection: Connection;
  fromPubkey: PublicKey;
  toPubkey: PublicKey;
  lamports: number;
  limit?: number;
} & TransferMatchOptions): Promise<string | null> {
  const { connection, fromPubkey, toPubkey } = input;
  const lamports = Number(input.lamports);
  if (!Number.isFinite(lamports) || lamports <= 0) return null;

  const limit = Math.max(1, Math.min(50, Number(input.limit ?? 20) || 20));
  const c = getServerCommitment();
  const finality: Finality = c === "finalized" ? "finalized" : "confirmed";
  const exclude = new Set((input.excludeSignatures ?? []).map((s) => String(s).trim()).filter(Boolean));
  const ambiguousNull = input.onAmbiguous === "null";
  const matches: string[] = [];

  const sigs = await withRetry(() => connection.getSignaturesForAddress(fromPubkey, { limit }, finality));
  for (const s of sigs) {
    const sig = String(s.signature ?? "").trim();
    if (!sig || s.err || exclude.has(sig)) continue;

    const tx = await withRetry(() => connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: finality }));
    if (matchesSystemTransfer(tx, fromPubkey.toBase58(), toPubkey.toBase58(), lamports)) {
      if (!ambiguousNull) return sig;
      matches.push(sig);
      if (matches.length > 1) return null;
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

export async function transferAllLamportsFromPrivyWallet(opts: {
  connection: Connection;
  walletId: string;
  fromPubkey: PublicKey;
  to: PublicKey;
  onPrepared?: OnPreparedHook;
}): Promise<{ signature: string; amountLamports: number }> {
  return transferLamportsCore({
    connection: opts.connection,
    signer: { kind: "privy", walletId: String(opts.walletId), pubkey: opts.fromPubkey },
    to: opts.to,
    lamports: "all",
    onPrepared: opts.onPrepared,
  });
}

export async function transferLamports(opts: {
  connection: Connection;
  from: Keypair;
  to: PublicKey;
  lamports: number;
  onPrepared?: OnPreparedHook;
}): Promise<{ signature: string; amountLamports: number }> {
  return transferLamportsCore({
    connection: opts.connection,
    signer: { kind: "keypair", keypair: opts.from },
    to: opts.to,
    lamports: Number(opts.lamports),
    onPrepared: opts.onPrepared,
  });
}

export async function transferAllLamports(opts: {
  connection: Connection;
  from: Keypair;
  to: PublicKey;
  onPrepared?: OnPreparedHook;
}): Promise<{ signature: string; amountLamports: number }> {
  return transferLamportsCore({
    connection: opts.connection,
    signer: { kind: "keypair", keypair: opts.from },
    to: opts.to,
    lamports: "all",
    onPrepared: opts.onPrepared,
  });
}

/** Builds a PayoutSigner for a commitment escrow from its signer reference. */
export function payoutSignerFromEscrowRef(input: { escrowPubkey: PublicKey; ref: { kind: "privy"; walletId: string } | { kind: "local"; escrowSecretKeyB58: string } }): PayoutSigner {
  if (input.ref.kind === "privy") return { kind: "privy", walletId: input.ref.walletId, pubkey: input.escrowPubkey };
  const kp = keypairFromBase58Secret(input.ref.escrowSecretKeyB58);
  if (!kp.publicKey.equals(input.escrowPubkey)) throw new Error("Escrow secret key does not match escrow pubkey");
  return { kind: "keypair", keypair: kp };
}

/** Generic SOL payout for a PayoutSigner (route helpers use this so Privy and local escrows share one path). */
export async function transferLamportsFromSigner(opts: {
  connection: Connection;
  signer: PayoutSigner;
  to: PublicKey;
  lamports: number | "all";
  onPrepared?: OnPreparedHook;
}): Promise<{ signature: string; amountLamports: number }> {
  return transferLamportsCore(opts);
}
