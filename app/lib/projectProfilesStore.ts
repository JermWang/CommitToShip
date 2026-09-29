import { hasDatabase, getPool } from "./db";
import { relativizeOwnAssetUrl } from "./assetStorage";

export type ProjectProfileRecord = {
  tokenMint: string;
  name?: string | null;
  symbol?: string | null;
  description?: string | null;
  websiteUrl?: string | null;
  xUrl?: string | null;
  telegramUrl?: string | null;
  discordUrl?: string | null;
  imageUrl?: string | null;
  bannerUrl?: string | null;
  metadataUri?: string | null;
  createdByWallet?: string | null;
  createdAtUnix: number;
  updatedAtUnix: number;
};

const mem = {
  projects: new Map<string, ProjectProfileRecord>(),
};

let ensuredSchema: Promise<void> | null = null;

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

async function ensureSchema(): Promise<void> {
  if (!hasDatabase()) return;
  if (ensuredSchema) return ensuredSchema;

  ensuredSchema = (async () => {
    const pool = getPool();
    await pool.query(`
      create table if not exists project_profiles (
        token_mint text primary key,
        name text null,
        symbol text null,
        description text null,
        website_url text null,
        x_url text null,
        telegram_url text null,
        discord_url text null,
        image_url text null,
        banner_url text null,
        metadata_uri text null,
        created_by_wallet text null,
        created_at_unix bigint not null,
        updated_at_unix bigint not null
      );
      create index if not exists project_profiles_updated_idx on project_profiles(updated_at_unix);
    `);

    await pool.query("alter table if exists project_profiles add column if not exists banner_url text null");
  })().catch((e) => {
    ensuredSchema = null;
    throw e;
  });

  return ensuredSchema;
}

function rowToProject(row: any): ProjectProfileRecord {
  return {
    tokenMint: String(row.token_mint),
    name: row.name ?? null,
    symbol: row.symbol ?? null,
    description: row.description ?? null,
    websiteUrl: row.website_url ?? null,
    xUrl: row.x_url ?? null,
    telegramUrl: row.telegram_url ?? null,
    discordUrl: row.discord_url ?? null,
    imageUrl: relativizeOwnAssetUrl(row.image_url ?? null),
    bannerUrl: relativizeOwnAssetUrl(row.banner_url ?? null),
    metadataUri: row.metadata_uri ?? null,
    createdByWallet: row.created_by_wallet ?? null,
    createdAtUnix: Number(row.created_at_unix),
    updatedAtUnix: Number(row.updated_at_unix),
  };
}

export async function getProjectProfile(tokenMint: string): Promise<ProjectProfileRecord | null> {
  await ensureSchema();

  const key = String(tokenMint).trim();
  if (!key) return null;

  if (!hasDatabase()) {
    return mem.projects.get(key) ?? null;
  }

  const pool = getPool();
  const res = await pool.query("select * from project_profiles where token_mint=$1", [key]);
  const row = res.rows[0];
  return row ? rowToProject(row) : null;
}

export async function upsertProjectProfile(input: {
  tokenMint: string;
  name?: string | null;
  symbol?: string | null;
  description?: string | null;
  websiteUrl?: string | null;
  xUrl?: string | null;
  telegramUrl?: string | null;
  discordUrl?: string | null;
  imageUrl?: string | null;
  bannerUrl?: string | null;
  metadataUri?: string | null;
  createdByWallet?: string | null;
}): Promise<ProjectProfileRecord> {
  await ensureSchema();

  const tokenMint = String(input.tokenMint).trim();
  if (!tokenMint) throw new Error("tokenMint is required");

  const name = input.name == null ? null : String(input.name).trim();
  const symbol = input.symbol == null ? null : String(input.symbol).trim();
  const description = input.description == null ? null : String(input.description);
  const websiteUrl = input.websiteUrl == null ? null : String(input.websiteUrl).trim();
  const xUrl = input.xUrl == null ? null : String(input.xUrl).trim();
  const telegramUrl = input.telegramUrl == null ? null : String(input.telegramUrl).trim();
  const discordUrl = input.discordUrl == null ? null : String(input.discordUrl).trim();
  const imageUrl = input.imageUrl == null ? null : String(input.imageUrl).trim();
  const bannerUrl = input.bannerUrl == null ? null : String(input.bannerUrl).trim();
  const metadataUri = input.metadataUri == null ? null : String(input.metadataUri).trim();
  const createdByWallet = input.createdByWallet == null ? null : String(input.createdByWallet).trim();

  const ts = nowUnix();

  if (!hasDatabase()) {
    const prev = mem.projects.get(tokenMint);
    const next: ProjectProfileRecord = {
      tokenMint,
      name,
      symbol,
      description,
      websiteUrl,
      xUrl,
      telegramUrl,
      discordUrl,
      imageUrl,
      bannerUrl,
      metadataUri,
      createdByWallet: createdByWallet ?? prev?.createdByWallet ?? null,
      createdAtUnix: prev?.createdAtUnix ?? ts,
      updatedAtUnix: ts,
    };
    mem.projects.set(tokenMint, next);
    return next;
  }

  const pool = getPool();
  const res = await pool.query(
    `insert into project_profiles (
      token_mint, name, symbol, description, website_url, x_url, telegram_url, discord_url, image_url, banner_url, metadata_uri, created_by_wallet,
      created_at_unix, updated_at_unix
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
    on conflict (token_mint) do update set
      name=excluded.name,
      symbol=excluded.symbol,
      description=excluded.description,
      website_url=excluded.website_url,
      x_url=excluded.x_url,
      telegram_url=excluded.telegram_url,
      discord_url=excluded.discord_url,
      image_url=excluded.image_url,
      banner_url=excluded.banner_url,
      metadata_uri=excluded.metadata_uri,
      created_by_wallet=coalesce(project_profiles.created_by_wallet, excluded.created_by_wallet),
      updated_at_unix=excluded.updated_at_unix
    returning *`,
    [
      tokenMint,
      name,
      symbol,
      description,
      websiteUrl,
      xUrl,
      telegramUrl,
      discordUrl,
      imageUrl,
      bannerUrl,
      metadataUri,
      createdByWallet,
      String(ts),
    ]
  );

  const row = res.rows[0];
  if (!row) throw new Error("Failed to upsert project profile");
  return rowToProject(row);
}

export async function getProjectProfilesByTokenMints(tokenMints: string[]): Promise<ProjectProfileRecord[]> {
  await ensureSchema();

  const cleaned = Array.from(
    new Set(
      (Array.isArray(tokenMints) ? tokenMints : [])
        .map((s) => String(s ?? "").trim())
        .filter((s) => s.length > 0)
    )
  );

  if (cleaned.length === 0) return [];

  if (!hasDatabase()) {
    return cleaned.map((k) => mem.projects.get(k)).filter(Boolean) as ProjectProfileRecord[];
  }

  const pool = getPool();
  const res = await pool.query("select * from project_profiles where token_mint = any($1)", [cleaned]);
  return res.rows.map(rowToProject);
}
