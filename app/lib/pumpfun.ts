import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { sendAndConfirm } from "./rpc";
import { keypairFromBase58Secret } from "./solana";

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const MAYHEM_PROGRAM_ID = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
const FEE_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

const CREATE_V2_DISCRIMINATOR = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]);
const BUY_EXACT_SOL_IN_DISCRIMINATOR = Buffer.from([56, 252, 116, 8, 158, 223, 205, 95]);

const ATA_CREATE_IDEMPOTENT = Buffer.from([1]);

const MINT_AUTHORITY_SEED = Buffer.from("mint-authority");
const GLOBAL_SEED = Buffer.from("global");
const BONDING_CURVE_SEED = Buffer.from("bonding-curve");
const GLOBAL_VOLUME_ACCUMULATOR_SEED = Buffer.from("global_volume_accumulator");
const USER_VOLUME_ACCUMULATOR_SEED = Buffer.from("user_volume_accumulator");

const MAYHEM_GLOBAL_PARAMS_SEED = Buffer.from("global-params");
const MAYHEM_SOL_VAULT_SEED = Buffer.from("sol-vault");
const MAYHEM_STATE_SEED = Buffer.from("mayhem-state");

const FEE_CONFIG_SEED = Buffer.from("fee_config");
const FEE_CONFIG_ID_SEED = Buffer.from([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

const COLLECT_CREATOR_FEE_DISCRIMINATOR = Buffer.from([20, 22, 86, 123, 198, 28, 219, 132]);
const CREATOR_VAULT_SEED = Buffer.from("creator-vault");
const EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");

function getFeePayerKeypair(): Keypair {
  const secret = process.env.ESCROW_FEE_PAYER_SECRET_KEY;
  if (!secret) {
    throw new Error("ESCROW_FEE_PAYER_SECRET_KEY is required for Pump.fun claims");
  }
  return keypairFromBase58Secret(secret);
}

export function getPumpProgramId(): PublicKey {
  return PUMP_PROGRAM_ID;
}

export function getPumpEventAuthorityPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], PUMP_PROGRAM_ID);
  return pda;
}

export function getBondingCurveV2Pda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve-v2"), mint.toBuffer()], PUMP_PROGRAM_ID);
  return pda;
}

export function getPumpGlobalPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([GLOBAL_SEED], PUMP_PROGRAM_ID);
  return pda;
}

export function getPumpMintAuthorityPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([MINT_AUTHORITY_SEED], PUMP_PROGRAM_ID);
  return pda;
}

export function getBondingCurvePda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([BONDING_CURVE_SEED, mint.toBuffer()], PUMP_PROGRAM_ID);
  return pda;
}

export function getGlobalVolumeAccumulatorPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([GLOBAL_VOLUME_ACCUMULATOR_SEED], PUMP_PROGRAM_ID);
  return pda;
}

export function getUserVolumeAccumulatorPda(user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([USER_VOLUME_ACCUMULATOR_SEED, user.toBuffer()], PUMP_PROGRAM_ID);
  return pda;
}

export function getMayhemGlobalParamsPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([MAYHEM_GLOBAL_PARAMS_SEED], MAYHEM_PROGRAM_ID);
  return pda;
}

export function getMayhemSolVaultPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([MAYHEM_SOL_VAULT_SEED], MAYHEM_PROGRAM_ID);
  return pda;
}

export function getMayhemStatePda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([MAYHEM_STATE_SEED, mint.toBuffer()], MAYHEM_PROGRAM_ID);
  return pda;
}

export function getFeeConfigPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([FEE_CONFIG_SEED, FEE_CONFIG_ID_SEED], FEE_PROGRAM_ID);
  return pda;
}

export function getAssociatedTokenAddress(input: { owner: PublicKey; mint: PublicKey; tokenProgram?: PublicKey }): PublicKey {
  const tokenProgram = input.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const [pda] = PublicKey.findProgramAddressSync(
    [input.owner.toBuffer(), tokenProgram.toBuffer(), input.mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return pda;
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

function toU8(part: Uint8Array | Buffer): Uint8Array {
  // Avoid TS incompatibilities between Buffer's ArrayBufferLike and Uint8Array's ArrayBuffer.
  // Copying is fine here since instruction data sizes are small.
  return Uint8Array.from(part);
}

function concatBytes(parts: readonly Uint8Array[]): Buffer {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = Buffer.alloc(total);

  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }

  return out;
}

function borshString(s: string): Buffer {
  const bytes = Buffer.from(String(s ?? ""), "utf8");
  return concatBytes([toU8(u32le(bytes.length)), toU8(bytes)]);
}

function borshOptionBool(v: boolean): Buffer {
  return Buffer.from([1, v ? 1 : 0]);
}

export function buildCreateV2Instruction(input: {
  mint: PublicKey;
  user: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  creator: PublicKey;
  isMayhemMode?: boolean;
}): {
  ix: TransactionInstruction;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
} {
  const mintAuthority = getPumpMintAuthorityPda();
  const bondingCurve = getBondingCurvePda(input.mint);
  const associatedBondingCurve = getAssociatedTokenAddress({ owner: bondingCurve, mint: input.mint, tokenProgram: TOKEN_2022_PROGRAM_ID });
  const global = getPumpGlobalPda();
  const globalParams = getMayhemGlobalParamsPda();
  const solVault = getMayhemSolVaultPda();
  const mayhemState = getMayhemStatePda(input.mint);
  const mayhemTokenVault = getAssociatedTokenAddress({ owner: solVault, mint: input.mint, tokenProgram: TOKEN_2022_PROGRAM_ID });
  const eventAuthority = getPumpEventAuthorityPda();

  const data = concatBytes(
    [
      CREATE_V2_DISCRIMINATOR,
      borshString(input.name),
      borshString(input.symbol),
      borshString(input.uri),
      input.creator.toBuffer(),
      Buffer.from([input.isMayhemMode ? 1 : 0]),
    ].map(toU8)
  );

  const ix = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: input.mint, isSigner: true, isWritable: true },
      { pubkey: mintAuthority, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: input.user, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAYHEM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: globalParams, isSigner: false, isWritable: false },
      { pubkey: solVault, isSigner: false, isWritable: true },
      { pubkey: mayhemState, isSigner: false, isWritable: true },
      { pubkey: mayhemTokenVault, isSigner: false, isWritable: true },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  return { ix, bondingCurve, associatedBondingCurve };
}

export function buildCreateAssociatedTokenAccountIdempotentInstruction(input: {
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  tokenProgram?: PublicKey;
}): { ix: TransactionInstruction; ata: PublicKey } {
  const tokenProgram = input.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
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
    data: ATA_CREATE_IDEMPOTENT,
  });
  return { ix, ata };
}

// Byte offsets inside the pump.fun `Global` account (8-byte Anchor discriminator first). See pump.fun's public IDL.
const GLOBAL_FEE_RECIPIENT_OFFSET = 8 + 1 + 32;
// `reserved_fee_recipient` (after `whitelist_pda`): the protocol fee recipient pump.fun requires for MAYHEM-mode coins.
const GLOBAL_RESERVED_FEE_RECIPIENT_OFFSET = 483;
const GLOBAL_BUYBACK_FEE_RECIPIENTS_OFFSET = 741; // after is_cashback_enabled
const GLOBAL_BUYBACK_FEE_RECIPIENTS_COUNT = 8;

// Byte offsets inside a `BondingCurve` account: 5 x u64 reserves/supply, `complete`, then `creator`, `is_mayhem_mode`.
const BONDING_CURVE_COMPLETE_OFFSET = 8 + 5 * 8;
const BONDING_CURVE_CREATOR_OFFSET = BONDING_CURVE_COMPLETE_OFFSET + 1; // 49
const BONDING_CURVE_MAYHEM_OFFSET = BONDING_CURVE_CREATOR_OFFSET + 32; // 81
// then is_cashback_coin (82) and quote_mint (83): default/WSOL = SOL-quoted; anything else (e.g. USDC) can't use buy_exact_sol_in.
const BONDING_CURVE_QUOTE_MINT_OFFSET = BONDING_CURVE_MAYHEM_OFFSET + 2; // 83
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

type GlobalPumpConfig = { feeRecipient: PublicKey; reservedFeeRecipient: PublicKey | null; buybackFeeRecipient: PublicKey | null };

/**
 * Reads what a buy needs from pump.fun's Global state:
 *  - the protocol fee recipient (and the reserved one used for mayhem-mode coins)
 *  - a buyback fee recipient. pump.fun's program now REQUIRES one (error BuybackFeeRecipientMissing / 6062 otherwise)
 *    as an extra writable account on buy instructions; any non-default entry of `buyback_fee_recipients` is valid.
 */
async function getGlobalPumpConfig(input: { connection: Connection }): Promise<GlobalPumpConfig> {
  const global = getPumpGlobalPda();
  const acct = await input.connection.getAccountInfo(global, "confirmed");
  if (!acct?.data || acct.data.length < GLOBAL_FEE_RECIPIENT_OFFSET + 32) {
    throw new Error("Failed to read pump.fun global state");
  }
  const feeRecipient = new PublicKey(acct.data.subarray(GLOBAL_FEE_RECIPIENT_OFFSET, GLOBAL_FEE_RECIPIENT_OFFSET + 32));

  let reservedFeeRecipient: PublicKey | null = null;
  if (acct.data.length >= GLOBAL_RESERVED_FEE_RECIPIENT_OFFSET + 32) {
    const pk = new PublicKey(acct.data.subarray(GLOBAL_RESERVED_FEE_RECIPIENT_OFFSET, GLOBAL_RESERVED_FEE_RECIPIENT_OFFSET + 32));
    if (!pk.equals(SystemProgram.programId)) reservedFeeRecipient = pk;
  }

  let buybackFeeRecipient: PublicKey | null = null;
  const end = GLOBAL_BUYBACK_FEE_RECIPIENTS_OFFSET + GLOBAL_BUYBACK_FEE_RECIPIENTS_COUNT * 32;
  if (acct.data.length >= end) {
    const candidates: PublicKey[] = [];
    for (let i = 0; i < GLOBAL_BUYBACK_FEE_RECIPIENTS_COUNT; i++) {
      const start = GLOBAL_BUYBACK_FEE_RECIPIENTS_OFFSET + i * 32;
      const pk = new PublicKey(acct.data.subarray(start, start + 32));
      if (!pk.equals(SystemProgram.programId)) candidates.push(pk);
    }
    if (candidates.length) buybackFeeRecipient = candidates[Math.floor(Math.random() * candidates.length)];
  }

  return { feeRecipient, reservedFeeRecipient, buybackFeeRecipient };
}

/** Mayhem-mode coins pay protocol fees to Global.reserved_fee_recipient; everything else to Global.fee_recipient. */
function pickFeeRecipient(cfg: GlobalPumpConfig, isMayhemMode: boolean): PublicKey {
  if (!isMayhemMode) return cfg.feeRecipient;
  if (!cfg.reservedFeeRecipient) {
    throw Object.assign(new Error("pump.fun mayhem mode is not available right now (no reserved fee recipient). Launch without mayhem mode."), { status: 400 });
  }
  return cfg.reservedFeeRecipient;
}

/**
 * Conservative minimum tokens out for a buy of `spendableSol` lamports against the given virtual reserves
 * (constant-product curve, ~2% fees assumed, `slippageBps` tolerance). Protects the buyer from a bad fill.
 */
export function estimateMinTokensOut(input: { spendableSolInLamports: bigint; virtualTokenReserves: bigint; virtualSolReserves: bigint; slippageBps?: number }): bigint {
  const spend = BigInt(input.spendableSolInLamports);
  const vt = BigInt(input.virtualTokenReserves);
  const vs = BigInt(input.virtualSolReserves);
  if (spend <= 0n || vt <= 0n || vs <= 0n) return 1n;
  const net = (spend * 98n) / 100n;
  const expected = (net * vt) / (vs + net);
  const slippage = BigInt(Math.max(0, Math.min(9_000, Math.floor(input.slippageBps ?? 1_000))));
  const min = (expected * (10_000n - slippage)) / 10_000n;
  return min > 0n ? min : 1n;
}

export type BondingCurveState = {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  complete: boolean;
  /** The coin's creator as recorded on-chain (decides the creator vault a buy must pay into). */
  creator: PublicKey;
  isMayhemMode: boolean;
  /** True when the curve trades against SOL (the only quote buy_exact_sol_in supports). */
  solQuoted: boolean;
};

/** Reads a mint's pump.fun bonding curve. Returns null when it doesn't exist (yet) or isn't a pump.fun curve. */
export async function readBondingCurveState(connection: Connection, mint: PublicKey): Promise<BondingCurveState | null> {
  const acct = await connection.getAccountInfo(getBondingCurvePda(mint), "confirmed");
  if (!acct?.data || !acct.owner.equals(PUMP_PROGRAM_ID) || acct.data.length < BONDING_CURVE_CREATOR_OFFSET + 32) return null;
  const d = acct.data;
  return {
    virtualTokenReserves: d.readBigUInt64LE(8),
    virtualSolReserves: d.readBigUInt64LE(16),
    complete: d[BONDING_CURVE_COMPLETE_OFFSET] === 1,
    creator: new PublicKey(d.subarray(BONDING_CURVE_CREATOR_OFFSET, BONDING_CURVE_CREATOR_OFFSET + 32)),
    isMayhemMode: d.length > BONDING_CURVE_MAYHEM_OFFSET ? d[BONDING_CURVE_MAYHEM_OFFSET] === 1 : false,
    solQuoted: (() => {
      if (d.length < BONDING_CURVE_QUOTE_MINT_OFFSET + 32) return true;
      const quote = new PublicKey(d.subarray(BONDING_CURVE_QUOTE_MINT_OFFSET, BONDING_CURVE_QUOTE_MINT_OFFSET + 32));
      return quote.equals(SystemProgram.programId) || quote.equals(WSOL_MINT);
    })(),
  };
}

export function buildBuyExactSolInInstruction(input: {
  user: PublicKey;
  mint: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  associatedUser: PublicKey;
  feeRecipient: PublicKey;
  buybackFeeRecipient?: PublicKey | null;
  creator: PublicKey;
  spendableSolInLamports: bigint;
  minTokensOut: bigint;
  trackVolume?: boolean;
}): TransactionInstruction {
  const global = getPumpGlobalPda();
  const eventAuthority = getPumpEventAuthorityPda();
  const creatorVault = getCreatorVaultPda(input.creator);
  const globalVolumeAccumulator = getGlobalVolumeAccumulatorPda();
  const userVolumeAccumulator = getUserVolumeAccumulatorPda(input.user);
  const feeConfig = getFeeConfigPda();

  const data = concatBytes(
    [
      BUY_EXACT_SOL_IN_DISCRIMINATOR,
      u64le(BigInt(input.spendableSolInLamports)),
      // pump.fun rejects a zero minimum (BuyZeroAmount); 1 is the smallest valid "no protection" value.
      u64le(BigInt(input.minTokensOut) > 0n ? BigInt(input.minTokensOut) : 1n),
      // OptionBool is a single-byte struct in pump's IDL.
      Buffer.from([input.trackVolume === false ? 0 : 1]),
    ].map(toU8)
  );

  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: input.feeRecipient, isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: input.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: input.associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: input.associatedUser, isSigner: false, isWritable: true },
      { pubkey: input.user, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: false },
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
      { pubkey: feeConfig, isSigner: false, isWritable: false },
      { pubkey: FEE_PROGRAM_ID, isSigner: false, isWritable: false },
      // pump.fun's current program expects two trailing accounts on buys: the mint's bonding-curve-v2 PDA (read-only,
      // as in the official SDK), then a buyback fee recipient (verified against live mainnet buy transactions).
      { pubkey: getBondingCurveV2Pda(input.mint), isSigner: false, isWritable: false },
      ...(input.buybackFeeRecipient ? [{ pubkey: input.buybackFeeRecipient, isSigner: false, isWritable: true }] : []),
    ],
    data,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Address lookup table
//
// create_v2 + ATA + buy references ~26 accounts: as a legacy transaction that is 1245-1285 bytes, over Solana's
// 1232-byte packet limit. pump.fun's own launches compress the shared accounts (programs, Global, fee config, fee
// recipients, mayhem accounts, ...) through a public lookup table; we reuse it. Tables are append-only, so an index
// that resolves today resolves forever; if the table is ever deactivated/closed (or can't be loaded), the launch
// falls back to two transactions (create, then a separate dev buy).
// ---------------------------------------------------------------------------------------------------------------------

/** pump.fun's public lookup table (used by most live create_v2 launches); override with env PUMP_LOOKUP_TABLE. */
export const DEFAULT_PUMP_LOOKUP_TABLE = "Hyif6eWb8x88RVrvjPfabsgRYnwkVnyByEXTVTXbUcyP";

const LUT_CACHE_MS = 60_000;
let lutCache: { key: string; table: AddressLookupTableAccount | null; fetchedAt: number } | null = null;

/** The configured lookup table address, or null when disabled (PUMP_LOOKUP_TABLE=off). */
export function getPumpLookupTableAddress(): PublicKey | null {
  const raw = String(process.env.PUMP_LOOKUP_TABLE ?? "").trim();
  if (/^(off|none|false|0)$/i.test(raw)) return null;
  try {
    return new PublicKey(raw || DEFAULT_PUMP_LOOKUP_TABLE);
  } catch {
    console.warn("[pumpfun] PUMP_LOOKUP_TABLE is not a valid address; using the default table");
    return new PublicKey(DEFAULT_PUMP_LOOKUP_TABLE);
  }
}

/** Loads the (active) lookup table, or null if it is disabled, missing, deactivated or the RPC call fails. */
export async function loadPumpLookupTable(connection: Connection): Promise<AddressLookupTableAccount | null> {
  const address = getPumpLookupTableAddress();
  if (!address) return null;
  const key = address.toBase58();
  if (lutCache && lutCache.key === key && Date.now() - lutCache.fetchedAt < LUT_CACHE_MS) return lutCache.table;
  let table: AddressLookupTableAccount | null = null;
  try {
    const res = await connection.getAddressLookupTable(address, { commitment: "confirmed" });
    table = res.value && res.value.isActive() ? res.value : null;
  } catch (e) {
    console.warn("[pumpfun] could not load the lookup table", key, e instanceof Error ? e.message : String(e));
    return null; // don't cache transient RPC failures
  }
  lutCache = { key, table, fetchedAt: Date.now() };
  return table;
}

function compileV0(input: {
  payer: PublicKey;
  blockhash: string;
  instructions: TransactionInstruction[];
  lookupTable: AddressLookupTableAccount | null;
}): { tx: VersionedTransaction; sizeBytes: number } | null {
  try {
    const message = new TransactionMessage({
      payerKey: input.payer,
      recentBlockhash: input.blockhash,
      instructions: input.instructions,
    }).compileToV0Message(input.lookupTable ? [input.lookupTable] : []);
    const tx = new VersionedTransaction(message);
    // An unsigned VersionedTransaction carries zeroed signature slots, so this is the exact on-wire size.
    const sizeBytes = tx.serialize().length;
    return { tx, sizeBytes };
  } catch {
    return null;
  }
}

function computeBudgetIxs(input: { computeUnitLimit?: number; computeUnitPriceMicroLamports?: number }): TransactionInstruction[] {
  const cuLimit = Math.max(50_000, Math.min(1_400_000, Math.floor(Number(input.computeUnitLimit ?? 199_613)) || 199_613));
  const cuPrice = Math.max(0, Math.min(50_000_000, Math.floor(Number(input.computeUnitPriceMicroLamports ?? 936_761)) || 0));
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice })];
}

export type PumpfunCreatePlan = {
  /** Unsigned v0 transaction: the mint keypair and `user` (fee payer) must sign it. */
  tx: VersionedTransaction;
  /**
   * True when the dev buy is inside `tx`. False when a dev buy was requested but did not fit (or no lookup table was
   * available): the caller must send `buildUnsignedPumpfunBuyTx` for the same mint after `tx` confirms.
   */
  devBuyIncluded: boolean;
  devBuyRequested: boolean;
  lookupTable: string | null;
  sizeBytes: number;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  associatedUser: PublicKey;
  feeRecipient: PublicKey;
  blockhash: string;
  lastValidBlockHeight: number;
};

export async function buildUnsignedPumpfunCreateV2Tx(input: {
  connection: Connection;
  user: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  creator: PublicKey;
  isMayhemMode?: boolean;
  spendableSolInLamports: bigint;
  minTokensOut?: bigint;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
  /** Use this blockhash instead of fetching one (durable send rebuilds pass theirs). */
  latestBlockhash?: { blockhash: string; lastValidBlockHeight: number };
  /** undefined = load the configured table; null = build without a table. */
  lookupTable?: AddressLookupTableAccount | null;
}): Promise<PumpfunCreatePlan> {
  const isMayhemMode = Boolean(input.isMayhemMode);
  const cfg = await getGlobalPumpConfig({ connection: input.connection });
  const feeRecipient = pickFeeRecipient(cfg, isMayhemMode);

  const { ix: createIx, bondingCurve, associatedBondingCurve } = buildCreateV2Instruction({
    mint: input.mint,
    user: input.user,
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
    creator: input.creator,
    isMayhemMode,
  });

  const { ix: createAtaIx, ata: associatedUser } = buildCreateAssociatedTokenAccountIdempotentInstruction({
    payer: input.user,
    owner: input.user,
    mint: input.mint,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });

  const spendable = BigInt(input.spendableSolInLamports);
  const budget = computeBudgetIxs(input);
  const latest = input.latestBlockhash ?? (await input.connection.getLatestBlockhash("confirmed"));
  const lookupTable = input.lookupTable === undefined ? await loadPumpLookupTable(input.connection) : input.lookupTable;

  const base = {
    bondingCurve,
    associatedBondingCurve,
    associatedUser,
    feeRecipient,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    devBuyRequested: spendable > 0n,
  };

  if (spendable > 0n) {
    const buyIx = buildBuyExactSolInInstruction({
      user: input.user,
      mint: input.mint,
      bondingCurve,
      associatedBondingCurve,
      associatedUser,
      feeRecipient,
      buybackFeeRecipient: cfg.buybackFeeRecipient,
      creator: input.creator,
      spendableSolInLamports: spendable,
      // Same transaction as the create: nobody can trade in between, so the fill is deterministic.
      minTokensOut: BigInt(input.minTokensOut ?? 0n),
      trackVolume: true,
    });
    if (lookupTable) {
      const combined = compileV0({ payer: input.user, blockhash: latest.blockhash, instructions: [...budget, createIx, createAtaIx, buyIx], lookupTable });
      if (combined && combined.sizeBytes <= PACKET_DATA_SIZE) {
        return { ...base, tx: combined.tx, sizeBytes: combined.sizeBytes, devBuyIncluded: true, lookupTable: lookupTable.key.toBase58() };
      }
    }
  }

  // Create only (no dev buy requested, or it did not fit): always well under the limit, with or without the table.
  const createOnly =
    (lookupTable && compileV0({ payer: input.user, blockhash: latest.blockhash, instructions: [...budget, createIx], lookupTable })) ||
    compileV0({ payer: input.user, blockhash: latest.blockhash, instructions: [...budget, createIx], lookupTable: null });
  if (!createOnly || createOnly.sizeBytes > PACKET_DATA_SIZE) {
    throw new Error(`pump.fun create transaction is too large (${createOnly?.sizeBytes ?? "?"} bytes); shorten the name/symbol/metadata URI`);
  }
  const usedTable = createOnly.tx.message.addressTableLookups.length > 0 && lookupTable ? lookupTable.key.toBase58() : null;
  return { ...base, tx: createOnly.tx, sizeBytes: createOnly.sizeBytes, devBuyIncluded: false, lookupTable: usedTable };
}

/**
 * A buy on an existing pump.fun coin (legacy transaction, comfortably under the size limit). The creator vault and the
 * mayhem fee recipient are taken from the on-chain bonding curve, never from the caller.
 */
export async function buildUnsignedPumpfunBuyTx(input: {
  connection: Connection;
  user: PublicKey;
  mint: PublicKey;
  /** Optional cross-check: rejected when it differs from the creator recorded on the bonding curve. */
  creator?: PublicKey;
  spendableSolInLamports: bigint;
  minTokensOut?: bigint;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
  latestBlockhash?: { blockhash: string; lastValidBlockHeight: number };
}): Promise<{ tx: Transaction; bondingCurve: PublicKey; associatedBondingCurve: PublicKey; associatedUser: PublicKey; feeRecipient: PublicKey; creator: PublicKey }> {
  const curve = await readBondingCurveState(input.connection, input.mint);
  if (!curve) throw Object.assign(new Error("This token has no pump.fun bonding curve (yet)"), { status: 404 });
  if (curve.complete) throw Object.assign(new Error("This token has graduated from the bonding curve; buy it on PumpSwap instead"), { status: 409 });
  if (!curve.solQuoted) throw Object.assign(new Error("This token's bonding curve is not SOL-quoted"), { status: 400 });
  if (input.creator && !input.creator.equals(curve.creator)) {
    throw Object.assign(new Error("Creator does not match the token's bonding curve"), { status: 400 });
  }
  const creator = curve.creator;

  const cfg = await getGlobalPumpConfig({ connection: input.connection });
  const feeRecipient = pickFeeRecipient(cfg, curve.isMayhemMode);
  const bondingCurve = getBondingCurvePda(input.mint);
  const associatedBondingCurve = getAssociatedTokenAddress({ owner: bondingCurve, mint: input.mint, tokenProgram: TOKEN_2022_PROGRAM_ID });
  const associatedUser = getAssociatedTokenAddress({ owner: input.user, mint: input.mint, tokenProgram: TOKEN_2022_PROGRAM_ID });

  const { ix: createAtaIx } = buildCreateAssociatedTokenAccountIdempotentInstruction({
    payer: input.user,
    owner: input.user,
    mint: input.mint,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });

  let minTokensOut = BigInt(input.minTokensOut ?? 0n);
  if (minTokensOut <= 0n) {
    minTokensOut = estimateMinTokensOut({
      spendableSolInLamports: BigInt(input.spendableSolInLamports),
      virtualTokenReserves: curve.virtualTokenReserves,
      virtualSolReserves: curve.virtualSolReserves,
    });
  }

  const buyIx = buildBuyExactSolInInstruction({
    user: input.user,
    mint: input.mint,
    bondingCurve,
    associatedBondingCurve,
    associatedUser,
    feeRecipient,
    buybackFeeRecipient: cfg.buybackFeeRecipient,
    creator,
    spendableSolInLamports: BigInt(input.spendableSolInLamports),
    minTokensOut,
    trackVolume: true,
  });

  const tx = new Transaction();
  tx.feePayer = input.user;
  tx.add(...computeBudgetIxs(input), createAtaIx, buyIx);

  const { blockhash, lastValidBlockHeight } = input.latestBlockhash ?? (await input.connection.getLatestBlockhash("confirmed"));
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  return { tx, bondingCurve, associatedBondingCurve, associatedUser, feeRecipient, creator };
}

/**
 * Privy must hand back exactly the message we built (same accounts, amounts, blockhash), with every signature filled.
 * Works for legacy and v0 wire formats.
 */
export function assertSignedAsBuilt(raw: Uint8Array, expectedMessage: Uint8Array): void {
  let signed: VersionedTransaction;
  try {
    signed = VersionedTransaction.deserialize(raw);
  } catch {
    throw new Error("Privy returned an unreadable signed transaction");
  }
  if (!Buffer.from(signed.message.serialize()).equals(Buffer.from(expectedMessage))) {
    throw new Error("Privy returned a different transaction than the one submitted for signing");
  }
  if (signed.signatures.some((s) => s.every((b) => b === 0))) {
    throw new Error("Signed launch transaction is missing a signature");
  }
}

export function getCreatorVaultPda(creator: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([CREATOR_VAULT_SEED, creator.toBuffer()], PUMP_PROGRAM_ID);
  return pda;
}

export async function getClaimableCreatorFeeLamports(input: {
  connection: Connection;
  creator: PublicKey;
}): Promise<{ creatorVault: PublicKey; vaultBalanceLamports: number; rentExemptMinLamports: number; claimableLamports: number }> {
  const { connection, creator } = input;
  const creatorVault = getCreatorVaultPda(creator);

  const [vaultBalanceLamports, rentExemptMinLamports] = await Promise.all([
    connection.getBalance(creatorVault),
    connection.getMinimumBalanceForRentExemption(0),
  ]);

  const claimableLamports = Math.max(0, vaultBalanceLamports - rentExemptMinLamports);

  return { creatorVault, vaultBalanceLamports, rentExemptMinLamports, claimableLamports };
}

export function buildCollectCreatorFeeInstruction(input: { creator: PublicKey }): { ix: TransactionInstruction; creatorVault: PublicKey } {
  const creatorVault = getCreatorVaultPda(input.creator);
  const eventAuthority = getPumpEventAuthorityPda();

  const ix = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: input.creator, isSigner: false, isWritable: true },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: COLLECT_CREATOR_FEE_DISCRIMINATOR,
  });

  return { ix, creatorVault };
}

export async function buildUnsignedClaimCreatorFeesTx(input: {
  connection: Connection;
  creator: PublicKey;
}): Promise<{ tx: Transaction; creatorVault: PublicKey; claimableLamports: number; rentExemptMinLamports: number; vaultBalanceLamports: number }> {
  const { connection, creator } = input;

  const claimable = await getClaimableCreatorFeeLamports({ connection, creator });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("processed");
  const { ix, creatorVault } = buildCollectCreatorFeeInstruction({ creator });

  const tx = new Transaction();
  tx.feePayer = creator;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.add(ix);

  return {
    tx,
    creatorVault,
    claimableLamports: claimable.claimableLamports,
    rentExemptMinLamports: claimable.rentExemptMinLamports,
    vaultBalanceLamports: claimable.vaultBalanceLamports,
  };
}

export async function claimCreatorFees(input: {
  connection: Connection;
  creator: PublicKey;
}): Promise<{ signature: string; claimableLamports: number; creatorVault: PublicKey }> {
  const { connection, creator } = input;

  const { creatorVault, claimableLamports } = await getClaimableCreatorFeeLamports({ connection, creator });
  if (claimableLamports <= 0) {
    throw new Error("No claimable creator fees");
  }

  const feePayer = getFeePayerKeypair();
  const eventAuthority = getPumpEventAuthorityPda();

  const ix = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: false, isWritable: true },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: COLLECT_CREATOR_FEE_DISCRIMINATOR,
  });

  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.add(ix);

  const signature = await sendAndConfirm({ connection, tx, signers: [feePayer] });
  return { signature, claimableLamports, creatorVault };
}
