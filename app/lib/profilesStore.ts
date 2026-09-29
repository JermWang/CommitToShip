import { hasDatabase, getPool } from "./db";
import { relativizeOwnAssetUrl } from "./assetStorage";

export type ProfileRecord = {
  walletPubkey: string;
  displayName?: string | null;
  bio?: string | null;
  avatarPath?: string | null;
  avatarUrl?: string | null;
  createdAtUnix: number;
  updatedAtUnix: number;
};

const mem = {
  profiles: new Map<string, ProfileRecord>(),
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
      create table if not exists profiles (
        wallet_pubkey text primary key,
        display_name text null,
        bio text null,
        avatar_path text null,
        avatar_url text null,
        created_at_unix bigint not null,
        updated_at_unix bigint not null
      );
      create index if not exists profiles_updated_idx on profiles(updated_at_unix);
    `);
  })().catch((e) => {
    ensuredSchema = null;
    throw e;
  });

  return ensuredSchema;
}

function rowToProfile(row: any): ProfileRecord {
  return {
    walletPubkey: String(row.wallet_pubkey),
    displayName: row.display_name ?? null,
    bio: row.bio ?? null,
    avatarPath: row.avatar_path ?? null,
    avatarUrl: relativizeOwnAssetUrl(row.avatar_url ?? null),
    createdAtUnix: Number(row.created_at_unix),
    updatedAtUnix: Number(row.updated_at_unix),
  };
}

export async function getProfile(walletPubkey: string): Promise<ProfileRecord | null> {
  await ensureSchema();

  const key = String(walletPubkey).trim();
  if (!key) return null;

  if (!hasDatabase()) {
    return mem.profiles.get(key) ?? null;
  }

  const pool = getPool();
  const res = await pool.query("select * from profiles where wallet_pubkey=$1", [key]);
  const row = res.rows[0];
  return row ? rowToProfile(row) : null;
}

export async function upsertProfile(input: {
  walletPubkey: string;
  displayName?: string | null;
  bio?: string | null;
  avatarPath?: string | null;
  avatarUrl?: string | null;
}): Promise<ProfileRecord> {
  await ensureSchema();

  const walletPubkey = String(input.walletPubkey).trim();
  if (!walletPubkey) throw new Error("walletPubkey is required");

  const displayName = input.displayName == null ? null : String(input.displayName).trim();
  const bio = input.bio == null ? null : String(input.bio);
  const avatarPath = input.avatarPath == null ? null : String(input.avatarPath).trim();
  const avatarUrl = input.avatarUrl == null ? null : String(input.avatarUrl).trim();

  const ts = nowUnix();

  if (!hasDatabase()) {
    const prev = mem.profiles.get(walletPubkey);
    const next: ProfileRecord = {
      walletPubkey,
      displayName,
      bio,
      avatarPath,
      avatarUrl,
      createdAtUnix: prev?.createdAtUnix ?? ts,
      updatedAtUnix: ts,
    };
    mem.profiles.set(walletPubkey, next);
    return next;
  }

  const pool = getPool();
  const res = await pool.query(
    `insert into profiles (wallet_pubkey, display_name, bio, avatar_path, avatar_url, created_at_unix, updated_at_unix)
     values ($1,$2,$3,$4,$5,$6,$6)
     on conflict (wallet_pubkey) do update set
       display_name=excluded.display_name,
       bio=excluded.bio,
       avatar_path=excluded.avatar_path,
       avatar_url=excluded.avatar_url,
       updated_at_unix=excluded.updated_at_unix
     returning *`,
    [walletPubkey, displayName, bio, avatarPath, avatarUrl, String(ts)]
  );

  const row = res.rows[0];
  if (!row) throw new Error("Failed to upsert profile");
  return rowToProfile(row);
}

export async function getProfilesByWalletPubkeys(walletPubkeys: string[]): Promise<ProfileRecord[]> {
  await ensureSchema();

  const cleaned = Array.from(
    new Set(
      (Array.isArray(walletPubkeys) ? walletPubkeys : [])
        .map((s) => String(s ?? "").trim())
        .filter((s) => s.length > 0)
    )
  );

  if (cleaned.length === 0) return [];

  if (!hasDatabase()) {
    return cleaned.map((k) => mem.profiles.get(k)).filter(Boolean) as ProfileRecord[];
  }

  const pool = getPool();
  const res = await pool.query("select * from profiles where wallet_pubkey = any($1)", [cleaned]);
  return res.rows.map(rowToProfile);
}
