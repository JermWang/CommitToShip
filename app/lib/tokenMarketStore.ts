import { getPool, hasDatabase } from "./db";

export type CanonicalPairRecord = {
  tokenMint: string;
  chainId: string;
  pairAddress: string;
  dexId: string;
  url?: string | null;
  selectedAtUnix: number;
  updatedAtUnix: number;
};

export type TokenMarketSnapshot = {
  tokenMint: string;
  chainId: string;
  pairAddress: string;
  dexId: string;
  fetchedAtUnix: number;
  priceUsd: number;
  liquidityUsd: number;
  volumeH1Usd: number;
  volumeH24Usd: number;
  fdvUsd?: number | null;
  marketCapUsd?: number | null;
};

const mem = {
  canonicalPairs: new Map<string, CanonicalPairRecord>(),
  snapshotsByKey: new Map<string, TokenMarketSnapshot[]>(),
};

let ensuredSchema: Promise<void> | null = null;

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function key(input: { tokenMint: string; chainId: string }): string {
  return `${input.chainId}:${input.tokenMint}`;
}

async function ensureSchema(): Promise<void> {
  if (!hasDatabase()) return;
  if (ensuredSchema) return ensuredSchema;

  ensuredSchema = (async () => {
    const pool = getPool();

    await pool.query(`
      create table if not exists token_canonical_pairs (
        token_mint text not null,
        chain_id text not null,
        pair_address text not null,
        dex_id text not null,
        url text null,
        selected_at_unix bigint not null,
        updated_at_unix bigint not null,
        primary key (token_mint, chain_id)
      );
      create index if not exists token_canonical_pairs_updated_idx on token_canonical_pairs(updated_at_unix);
    `);

    await pool.query(`
      create table if not exists token_market_snapshots (
        id bigserial primary key,
        token_mint text not null,
        chain_id text not null,
        pair_address text not null,
        dex_id text not null,
        fetched_at_unix bigint not null,
        price_usd double precision not null,
        liquidity_usd double precision not null,
        volume_h1_usd double precision not null,
        volume_h24_usd double precision not null,
        fdv_usd double precision null,
        market_cap_usd double precision null
      );
      create index if not exists token_market_snapshots_token_idx on token_market_snapshots(token_mint, chain_id, fetched_at_unix);
      create index if not exists token_market_snapshots_pair_idx on token_market_snapshots(pair_address, fetched_at_unix);
    `);
  })().catch((e) => {
    ensuredSchema = null;
    throw e;
  });

  return ensuredSchema;
}

export async function getCanonicalPair(input: { tokenMint: string; chainId: string }): Promise<CanonicalPairRecord | null> {
  await ensureSchema();

  const tokenMint = String(input.tokenMint ?? "").trim();
  const chainId = String(input.chainId ?? "").trim().toLowerCase();
  if (!tokenMint || !chainId) return null;

  if (!hasDatabase()) {
    return mem.canonicalPairs.get(key({ tokenMint, chainId })) ?? null;
  }

  const pool = getPool();
  const res = await pool.query(
    "select token_mint, chain_id, pair_address, dex_id, url, selected_at_unix, updated_at_unix from token_canonical_pairs where token_mint=$1 and chain_id=$2",
    [tokenMint, chainId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    tokenMint: String(row.token_mint),
    chainId: String(row.chain_id),
    pairAddress: String(row.pair_address),
    dexId: String(row.dex_id),
    url: row.url ?? null,
    selectedAtUnix: Number(row.selected_at_unix),
    updatedAtUnix: Number(row.updated_at_unix),
  };
}

export async function upsertCanonicalPair(input: {
  tokenMint: string;
  chainId: string;
  pairAddress: string;
  dexId: string;
  url?: string | null;
  selectedAtUnix?: number;
}): Promise<CanonicalPairRecord> {
  await ensureSchema();

  const tokenMint = String(input.tokenMint ?? "").trim();
  const chainId = String(input.chainId ?? "").trim().toLowerCase();
  const pairAddress = String(input.pairAddress ?? "").trim();
  const dexId = String(input.dexId ?? "").trim();
  const url = input.url == null ? null : String(input.url);

  if (!tokenMint) throw new Error("tokenMint is required");
  if (!chainId) throw new Error("chainId is required");
  if (!pairAddress) throw new Error("pairAddress is required");
  if (!dexId) throw new Error("dexId is required");

  const ts = nowUnix();
  const selectedAtUnix = Number.isFinite(Number(input.selectedAtUnix)) && Number(input.selectedAtUnix) > 0 ? Math.floor(Number(input.selectedAtUnix)) : ts;

  const rec: CanonicalPairRecord = {
    tokenMint,
    chainId,
    pairAddress,
    dexId,
    url,
    selectedAtUnix,
    updatedAtUnix: ts,
  };

  if (!hasDatabase()) {
    const k = key({ tokenMint, chainId });
    const prev = mem.canonicalPairs.get(k);
    mem.canonicalPairs.set(k, {
      ...rec,
      pairAddress: prev?.pairAddress ?? rec.pairAddress,
      dexId: prev?.dexId ?? rec.dexId,
      selectedAtUnix: prev?.selectedAtUnix ?? selectedAtUnix,
    });
    return mem.canonicalPairs.get(k)!;
  }

  const pool = getPool();
  const res = await pool.query(
    `insert into token_canonical_pairs (token_mint, chain_id, pair_address, dex_id, url, selected_at_unix, updated_at_unix)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (token_mint, chain_id) do update set
       url=excluded.url,
       updated_at_unix=excluded.updated_at_unix
     returning token_mint, chain_id, pair_address, dex_id, url, selected_at_unix, updated_at_unix`,
    [tokenMint, chainId, pairAddress, dexId, url, String(selectedAtUnix), String(ts)]
  );

  const row = res.rows[0];
  if (!row) throw new Error("Failed to upsert canonical pair");

  return {
    tokenMint: String(row.token_mint),
    chainId: String(row.chain_id),
    pairAddress: String(row.pair_address),
    dexId: String(row.dex_id),
    url: row.url ?? null,
    selectedAtUnix: Number(row.selected_at_unix),
    updatedAtUnix: Number(row.updated_at_unix),
  };
}

export async function insertTokenMarketSnapshot(input: TokenMarketSnapshot): Promise<void> {
  await ensureSchema();

  const tokenMint = String(input.tokenMint ?? "").trim();
  const chainId = String(input.chainId ?? "").trim().toLowerCase();
  const pairAddress = String(input.pairAddress ?? "").trim();
  const dexId = String(input.dexId ?? "").trim();

  if (!tokenMint || !chainId || !pairAddress || !dexId) throw new Error("Invalid snapshot key fields");

  const fetchedAtUnix = Math.floor(Number(input.fetchedAtUnix ?? 0));
  const priceUsd = Number(input.priceUsd ?? 0);
  const liquidityUsd = Number(input.liquidityUsd ?? 0);
  const volumeH1Usd = Number(input.volumeH1Usd ?? 0);
  const volumeH24Usd = Number(input.volumeH24Usd ?? 0);

  if (!Number.isFinite(fetchedAtUnix) || fetchedAtUnix <= 0) throw new Error("Invalid fetchedAtUnix");
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error("Invalid priceUsd");
  if (!Number.isFinite(liquidityUsd) || liquidityUsd < 0) throw new Error("Invalid liquidityUsd");
  if (!Number.isFinite(volumeH1Usd) || volumeH1Usd < 0) throw new Error("Invalid volumeH1Usd");
  if (!Number.isFinite(volumeH24Usd) || volumeH24Usd < 0) throw new Error("Invalid volumeH24Usd");

  const fdvUsd = input.fdvUsd == null ? null : Number(input.fdvUsd);
  const marketCapUsd = input.marketCapUsd == null ? null : Number(input.marketCapUsd);

  if (!hasDatabase()) {
    const k = `${chainId}:${tokenMint}:${pairAddress}`;
    const prev = mem.snapshotsByKey.get(k) ?? [];
    const next = prev.concat([{ ...input, tokenMint, chainId, pairAddress, dexId, fetchedAtUnix, priceUsd, liquidityUsd, volumeH1Usd, volumeH24Usd, fdvUsd, marketCapUsd }]);
    mem.snapshotsByKey.set(k, next.slice(-500));
    return;
  }

  const pool = getPool();
  await pool.query(
    `insert into token_market_snapshots (
      token_mint, chain_id, pair_address, dex_id, fetched_at_unix,
      price_usd, liquidity_usd, volume_h1_usd, volume_h24_usd, fdv_usd, market_cap_usd
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      tokenMint,
      chainId,
      pairAddress,
      dexId,
      String(fetchedAtUnix),
      priceUsd,
      liquidityUsd,
      volumeH1Usd,
      volumeH24Usd,
      fdvUsd,
      marketCapUsd,
    ]
  );
}

export async function listTokenMarketSnapshots(input: {
  tokenMint: string;
  chainId: string;
  pairAddress: string;
  sinceUnix: number;
}): Promise<TokenMarketSnapshot[]> {
  await ensureSchema();

  const tokenMint = String(input.tokenMint ?? "").trim();
  const chainId = String(input.chainId ?? "").trim().toLowerCase();
  const pairAddress = String(input.pairAddress ?? "").trim();
  const sinceUnix = Math.floor(Number(input.sinceUnix ?? 0));

  if (!tokenMint || !chainId || !pairAddress) return [];

  if (!Number.isFinite(sinceUnix) || sinceUnix <= 0) return [];

  if (!hasDatabase()) {
    const k = `${chainId}:${tokenMint}:${pairAddress}`;
    const all = mem.snapshotsByKey.get(k) ?? [];
    return all.filter((s) => Number(s.fetchedAtUnix) >= sinceUnix);
  }

  const pool = getPool();
  const res = await pool.query(
    `select token_mint, chain_id, pair_address, dex_id, fetched_at_unix, price_usd, liquidity_usd, volume_h1_usd, volume_h24_usd, fdv_usd, market_cap_usd
     from token_market_snapshots
     where token_mint=$1 and chain_id=$2 and pair_address=$3 and fetched_at_unix >= $4
     order by fetched_at_unix asc
     limit 2000`,
    [tokenMint, chainId, pairAddress, String(sinceUnix)]
  );

  return (res.rows ?? []).map((row: any) => ({
    tokenMint: String(row.token_mint),
    chainId: String(row.chain_id),
    pairAddress: String(row.pair_address),
    dexId: String(row.dex_id),
    fetchedAtUnix: Number(row.fetched_at_unix),
    priceUsd: Number(row.price_usd),
    liquidityUsd: Number(row.liquidity_usd),
    volumeH1Usd: Number(row.volume_h1_usd),
    volumeH24Usd: Number(row.volume_h24_usd),
    fdvUsd: row.fdv_usd == null ? null : Number(row.fdv_usd),
    marketCapUsd: row.market_cap_usd == null ? null : Number(row.market_cap_usd),
  }));
}

export async function findFirstTokenMarketSnapshotAbovePrice(input: {
  tokenMint: string;
  chainId: string;
  pairAddress: string;
  sinceUnix: number;
  minPriceUsd: number;
  minLiquidityUsd?: number;
  minVolumeH1Usd?: number;
}): Promise<TokenMarketSnapshot | null> {
  await ensureSchema();

  const tokenMint = String(input.tokenMint ?? "").trim();
  const chainId = String(input.chainId ?? "").trim().toLowerCase();
  const pairAddress = String(input.pairAddress ?? "").trim();
  const sinceUnix = Math.floor(Number(input.sinceUnix ?? 0));
  const minPriceUsd = Number(input.minPriceUsd ?? 0);

  const minLiquidityUsd = Number(input.minLiquidityUsd ?? 0);
  const minVolumeH1Usd = Number(input.minVolumeH1Usd ?? 0);

  if (!tokenMint || !chainId || !pairAddress) return null;
  if (!Number.isFinite(sinceUnix) || sinceUnix <= 0) return null;
  if (!Number.isFinite(minPriceUsd) || minPriceUsd <= 0) return null;

  const safeMinLiq = Number.isFinite(minLiquidityUsd) && minLiquidityUsd > 0 ? minLiquidityUsd : 0;
  const safeMinVol = Number.isFinite(minVolumeH1Usd) && minVolumeH1Usd > 0 ? minVolumeH1Usd : 0;

  if (!hasDatabase()) {
    const k = `${chainId}:${tokenMint}:${pairAddress}`;
    const all = mem.snapshotsByKey.get(k) ?? [];
    const found = all
      .filter((s) => Number(s.fetchedAtUnix) >= sinceUnix)
      .filter((s) => Number(s.priceUsd) >= minPriceUsd)
      .filter((s) => Number(s.liquidityUsd ?? 0) >= safeMinLiq)
      .filter((s) => Number(s.volumeH1Usd ?? 0) >= safeMinVol)
      .sort((a, b) => Number(a.fetchedAtUnix) - Number(b.fetchedAtUnix));
    return found[0] ?? null;
  }

  const pool = getPool();
  const res = await pool.query(
    `select token_mint, chain_id, pair_address, dex_id, fetched_at_unix, price_usd, liquidity_usd, volume_h1_usd, volume_h24_usd, fdv_usd, market_cap_usd
     from token_market_snapshots
     where token_mint=$1
       and chain_id=$2
       and pair_address=$3
       and fetched_at_unix >= $4
       and price_usd >= $5
       and liquidity_usd >= $6
       and volume_h1_usd >= $7
     order by fetched_at_unix asc
     limit 1`,
    [tokenMint, chainId, pairAddress, String(sinceUnix), minPriceUsd, safeMinLiq, safeMinVol]
  );

  const row = res.rows?.[0];
  if (!row) return null;
  return {
    tokenMint: String(row.token_mint),
    chainId: String(row.chain_id),
    pairAddress: String(row.pair_address),
    dexId: String(row.dex_id),
    fetchedAtUnix: Number(row.fetched_at_unix),
    priceUsd: Number(row.price_usd),
    liquidityUsd: Number(row.liquidity_usd),
    volumeH1Usd: Number(row.volume_h1_usd),
    volumeH24Usd: Number(row.volume_h24_usd),
    fdvUsd: row.fdv_usd == null ? null : Number(row.fdv_usd),
    marketCapUsd: row.market_cap_usd == null ? null : Number(row.market_cap_usd),
  };
}
