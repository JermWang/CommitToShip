import { getPool, hasDatabase } from "./db";

type CacheRow = {
  mint: string;
  priceUsd: number;
  updatedAtUnix: number;
};

const mem = {
  prices: new Map<string, CacheRow>(),
};

let ensuredSchema: Promise<void> | null = null;

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function ttlSeconds(): number {
  const raw = Number(process.env.JUPITER_PRICE_CACHE_TTL_SECONDS ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 60;
}

function staleTtlSeconds(): number {
  const raw = Number(process.env.JUPITER_PRICE_STALE_TTL_SECONDS ?? "");
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 15 * 60;
}

async function ensureSchema(): Promise<void> {
  if (!hasDatabase()) return;
  if (ensuredSchema) return ensuredSchema;

  ensuredSchema = (async () => {
    const pool = getPool();
    await pool.query(`
      create table if not exists token_price_cache (
        mint text primary key,
        price_usd double precision not null,
        updated_at_unix bigint not null
      );
    `);
  })().catch((e) => {
    ensuredSchema = null;
    throw e;
  });

  return ensuredSchema;
}

export async function getCachedJupiterPriceUsd(mint: string): Promise<number | null> {
  await ensureSchema();

  const t = nowUnix();
  const ttl = ttlSeconds();

  if (!hasDatabase()) {
    const row = mem.prices.get(mint);
    if (!row) return null;
    if (t - row.updatedAtUnix > ttl) return null;
    return row.priceUsd;
  }

  const pool = getPool();
  const res = await pool.query("select price_usd, updated_at_unix from token_price_cache where mint=$1", [mint]);
  const row = res.rows[0];
  if (!row) return null;
  const updatedAtUnix = Number(row.updated_at_unix);
  const priceUsd = Number(row.price_usd);
  if (!Number.isFinite(updatedAtUnix) || !Number.isFinite(priceUsd)) return null;
  if (t - updatedAtUnix > ttl) return null;
  return priceUsd;
}

export async function getCachedJupiterPriceUsdAllowStale(mint: string): Promise<number | null> {
  await ensureSchema();

  const t = nowUnix();
  const maxAge = staleTtlSeconds();

  if (!hasDatabase()) {
    const row = mem.prices.get(mint);
    if (!row) return null;
    if (t - row.updatedAtUnix > maxAge) return null;
    return row.priceUsd;
  }

  const pool = getPool();
  const res = await pool.query("select price_usd, updated_at_unix from token_price_cache where mint=$1", [mint]);
  const row = res.rows[0];
  if (!row) return null;
  const updatedAtUnix = Number(row.updated_at_unix);
  const priceUsd = Number(row.price_usd);
  if (!Number.isFinite(updatedAtUnix) || !Number.isFinite(priceUsd)) return null;
  if (t - updatedAtUnix > maxAge) return null;
  return priceUsd;
}

export async function setCachedJupiterPriceUsd(mint: string, priceUsd: number): Promise<void> {
  await ensureSchema();

  const updatedAtUnix = nowUnix();

  if (!hasDatabase()) {
    mem.prices.set(mint, { mint, priceUsd, updatedAtUnix });
    return;
  }

  const pool = getPool();
  await pool.query(
    `insert into token_price_cache (mint, price_usd, updated_at_unix)
     values ($1,$2,$3)
     on conflict (mint) do update set price_usd=excluded.price_usd, updated_at_unix=excluded.updated_at_unix`,
    [mint, priceUsd, String(updatedAtUnix)]
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// One price resolver for holder voting (no token-count fallback).
// ---------------------------------------------------------------------------------------------------------------------

const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

export type TokenUsdPrice = {
  priceUsd: number;
  source: "cache" | "jupiter" | "dexscreener" | "pump_curve" | "stale_cache";
};

/**
 * On-chain price for a token still on its pump.fun bonding curve: (virtual SOL / virtual tokens) x SOL/USD.
 * This is the price the curve itself quotes (any buy/sell executes against it), so it is the sensible on-chain
 * alternative for brand-new tokens that Jupiter and DexScreener do not price yet. Migrated (complete) curves are
 * ignored - their reserves are frozen and no longer reflect the market.
 */
export async function getPumpCurvePriceUsd(mint: string): Promise<number | null> {
  try {
    const [{ PublicKey }, { getConnection }, { getServerCommitment, withRetry }, { jupiterUsdPrice }] = await Promise.all([
      import("@solana/web3.js"),
      import("./solana"),
      import("./rpc"),
      import("./jupiter"),
    ]);
    const mintPk = new PublicKey(mint);
    const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mintPk.toBuffer()], new PublicKey(PUMP_PROGRAM_ID));
    const connection = getConnection();
    const info = await withRetry(() => connection.getAccountInfo(curve, getServerCommitment()));
    if (!info || info.owner.toBase58() !== PUMP_PROGRAM_ID || info.data.length < 49) return null;
    const data = Buffer.from(info.data);
    const virtualTokenReserves = data.readBigUInt64LE(8);
    const virtualSolReserves = data.readBigUInt64LE(16);
    const complete = data[48] === 1;
    if (complete || virtualTokenReserves <= 0n || virtualSolReserves <= 0n) return null;

    const mintInfo = await withRetry(() => connection.getAccountInfo(mintPk, getServerCommitment()));
    if (!mintInfo || mintInfo.data.length < 45) return null;
    const decimals = Buffer.from(mintInfo.data)[44];
    const solUsd = await jupiterUsdPrice(WSOL_MINT);
    if (solUsd == null || !Number.isFinite(solUsd) || solUsd <= 0) return null;

    const solPerToken = (Number(virtualSolReserves) / 1e9) / (Number(virtualTokenReserves) / 10 ** decimals);
    const price = solPerToken * solUsd;
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * USD price for a project token, in order: fresh cache -> Jupiter -> DexScreener (>= $1k liquidity) -> pump.fun
 * bonding curve (on-chain) -> stale cache (<= JUPITER_PRICE_STALE_TTL_SECONDS). null when none is available - callers
 * must then treat the holder as ineligible (there is deliberately no "N tokens" fallback).
 */
export async function resolveTokenUsdPrice(mint: string): Promise<TokenUsdPrice | null> {
  const m = String(mint ?? "").trim();
  if (!m) return null;

  const cached = await getCachedJupiterPriceUsd(m);
  if (cached != null && cached > 0) return { priceUsd: cached, source: "cache" };

  const remember = async (priceUsd: number, source: TokenUsdPrice["source"]): Promise<TokenUsdPrice> => {
    try {
      await setCachedJupiterPriceUsd(m, priceUsd);
    } catch {
      // cache is best-effort
    }
    return { priceUsd, source };
  };

  const { jupiterUsdPrice } = await import("./jupiter");
  const jup = await jupiterUsdPrice(m);
  if (jup != null && jup > 0) return remember(jup, "jupiter");

  try {
    const { fetchDexScreenerPairsByTokenMint, pickBestDexScreenerPair } = await import("./dexScreener");
    const { pairs } = await fetchDexScreenerPairsByTokenMint({ tokenMint: m, timeoutMs: 4000 });
    const best = pickBestDexScreenerPair({ pairs, chainId: "solana", minLiquidityUsd: 1000 });
    const price = Number(best?.priceUsd);
    if (Number.isFinite(price) && price > 0) return remember(price, "dexscreener");
  } catch {
    // fall through
  }

  const curve = await getPumpCurvePriceUsd(m);
  if (curve != null) return remember(curve, "pump_curve");

  const stale = await getCachedJupiterPriceUsdAllowStale(m);
  if (stale != null && stale > 0) return { priceUsd: stale, source: "stale_cache" };

  return null;
}
