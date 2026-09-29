import crypto from "crypto";

import { hasDatabase, getPool } from "./db";

export type DeclaredWalletStatus = "active" | "deprecated";

export type ProjectDeclaredWalletRecord = {
  id: string;
  tokenMint: string;
  walletPubkey: string;
  label?: string | null;
  status: DeclaredWalletStatus;
  addedAtUnix: number;
  deprecatedAtUnix?: number | null;
  verificationMethod: "message_signature";
  message: string;
  signature: string;
  verifiedAtUnix: number;
  verifiedBy: "wallet_owner";
  notes?: string | null;
};

export type ProjectSupplySnapshotRecord = {
  id: string;
  tokenMint: string;
  snapshotAtUnix: number;
  totalSupplyRaw: string;
  decimals: number;
  totalSupplyUi: number;
  declaredControlRaw: string;
  declaredControlUi: number;
  declaredControlPct: number;
  source: "scheduled_daily" | "on_demand_cached";
  inputsHash: string;
};

export type ProjectWalletBalanceSnapshotRecord = {
  id: string;
  tokenMint: string;
  snapshotAtUnix: number;
  walletPubkey: string;
  balanceRaw: string;
  balanceUi: number;
  balanceSource: string;
};

type DeclaredWalletNonceRecord = {
  tokenMint: string;
  walletPubkey: string;
  nonce: string;
  createdAtUnix: number;
};

const mem = {
  nonces: new Map<string, DeclaredWalletNonceRecord>(),
  declaredWalletsByMint: new Map<string, ProjectDeclaredWalletRecord[]>(),
  supplySnapshotsByMint: new Map<string, ProjectSupplySnapshotRecord[]>(),
  walletBalanceSnapshotsByKey: new Map<string, ProjectWalletBalanceSnapshotRecord[]>(),
};

let ensuredSchema: Promise<void> | null = null;

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function newId(): string {
  return crypto.randomBytes(16).toString("hex");
}

async function ensureSchema(): Promise<void> {
  if (!hasDatabase()) return;
  if (ensuredSchema) return ensuredSchema;

  ensuredSchema = (async () => {
    const pool = getPool();
    await pool.query(`
      create table if not exists project_declared_wallet_nonces (
        token_mint text not null,
        wallet_pubkey text not null,
        nonce text primary key,
        created_at_unix bigint not null
      );
      create index if not exists project_declared_wallet_nonces_mint_idx on project_declared_wallet_nonces(token_mint);
      create index if not exists project_declared_wallet_nonces_wallet_idx on project_declared_wallet_nonces(wallet_pubkey);
      create index if not exists project_declared_wallet_nonces_created_idx on project_declared_wallet_nonces(created_at_unix);

      create table if not exists project_declared_wallets (
        id text primary key,
        token_mint text not null,
        wallet_pubkey text not null,
        label text null,
        status text not null,
        added_at_unix bigint not null,
        deprecated_at_unix bigint null,
        verification_method text not null,
        message text not null,
        signature text not null,
        verified_at_unix bigint not null,
        verified_by text not null,
        notes text null
      );
      create index if not exists project_declared_wallets_mint_idx on project_declared_wallets(token_mint);
      create index if not exists project_declared_wallets_wallet_idx on project_declared_wallets(wallet_pubkey);
      create index if not exists project_declared_wallets_status_idx on project_declared_wallets(token_mint, status);
      create index if not exists project_declared_wallets_added_idx on project_declared_wallets(token_mint, added_at_unix);

      create table if not exists project_supply_snapshots (
        id text primary key,
        token_mint text not null,
        snapshot_at_unix bigint not null,
        total_supply_raw text not null,
        decimals integer not null,
        total_supply_ui double precision not null,
        declared_control_raw text not null,
        declared_control_ui double precision not null,
        declared_control_pct double precision not null,
        source text not null,
        inputs_hash text not null
      );
      create index if not exists project_supply_snapshots_mint_idx on project_supply_snapshots(token_mint, snapshot_at_unix);
      create index if not exists project_supply_snapshots_source_idx on project_supply_snapshots(source);

      create table if not exists project_wallet_balances_snapshot (
        id text primary key,
        token_mint text not null,
        snapshot_at_unix bigint not null,
        wallet_pubkey text not null,
        balance_raw text not null,
        balance_ui double precision not null,
        balance_source text not null
      );
      create index if not exists project_wallet_balances_snapshot_mint_idx on project_wallet_balances_snapshot(token_mint, snapshot_at_unix);
      create index if not exists project_wallet_balances_snapshot_wallet_idx on project_wallet_balances_snapshot(wallet_pubkey);
      create unique index if not exists project_wallet_balances_snapshot_unique_idx on project_wallet_balances_snapshot(token_mint, snapshot_at_unix, wallet_pubkey);
    `);
  })().catch((e) => {
    ensuredSchema = null;
    throw e;
  });

  return ensuredSchema;
}

function uiFromRaw(input: { amountRaw: bigint; decimals: number }): number {
  const d = BigInt(Math.max(0, Math.min(18, Math.floor(input.decimals))));
  const div = 10n ** d;
  const whole = input.amountRaw / div;
  const frac = input.amountRaw % div;
  const fracStr = frac.toString().padStart(Number(d), "0").slice(0, 9);
  const wholeNum = Number(whole);
  const fracNum = fracStr.length ? Number(`0.${fracStr}`) : 0;
  return (Number.isFinite(wholeNum) ? wholeNum : 0) + (Number.isFinite(fracNum) ? fracNum : 0);
}

export function buildDeclaredWalletMessage(input: {
  tokenMint: string;
  walletPubkey: string;
  nonce: string;
  issuedAtUnix: number;
}): string {
  return `Ship & Commit\nDeclare Team Wallet\n\nTokenMint: ${input.tokenMint}\nWallet: ${input.walletPubkey}\nScope: declared_team_control\nNonce: ${input.nonce}\nIssuedAtUnix: ${input.issuedAtUnix}`;
}

export function hashInputs(fields: Record<string, unknown>): string {
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify(fields));
  return h.digest("hex");
}

export async function createDeclaredWalletNonce(input: {
  tokenMint: string;
  walletPubkey: string;
}): Promise<{ nonce: string; issuedAtUnix: number; message: string }> {
  await ensureSchema();

  const tokenMint = String(input.tokenMint ?? "").trim();
  const walletPubkey = String(input.walletPubkey ?? "").trim();
  if (!tokenMint) throw new Error("tokenMint is required");
  if (!walletPubkey) throw new Error("walletPubkey is required");

  const nonce = crypto.randomBytes(18).toString("hex");
  const issuedAtUnix = nowUnix();
  const rec: DeclaredWalletNonceRecord = { tokenMint, walletPubkey, nonce, createdAtUnix: issuedAtUnix };

  if (!hasDatabase()) {
    mem.nonces.set(nonce, rec);
    return { nonce, issuedAtUnix, message: buildDeclaredWalletMessage({ tokenMint, walletPubkey, nonce, issuedAtUnix }) };
  }

  const pool = getPool();
  await pool.query(
    "insert into project_declared_wallet_nonces (token_mint, wallet_pubkey, nonce, created_at_unix) values ($1,$2,$3,$4)",
    [tokenMint, walletPubkey, nonce, String(issuedAtUnix)]
  );

  return { nonce, issuedAtUnix, message: buildDeclaredWalletMessage({ tokenMint, walletPubkey, nonce, issuedAtUnix }) };
}

export async function consumeDeclaredWalletNonce(input: {
  tokenMint: string;
  walletPubkey: string;
  nonce: string;
  maxAgeSeconds: number;
}): Promise<{ ok: true; issuedAtUnix: number } | { ok: false; reason: string }> {
  await ensureSchema();

  const tokenMint = String(input.tokenMint ?? "").trim();
  const walletPubkey = String(input.walletPubkey ?? "").trim();
  const nonce = String(input.nonce ?? "").trim();
  const cutoff = nowUnix() - Math.max(1, input.maxAgeSeconds);

  if (!tokenMint || !walletPubkey || !nonce) return { ok: false, reason: "Missing fields" };

  if (!hasDatabase()) {
    const rec = mem.nonces.get(nonce);
    if (!rec) return { ok: false, reason: "Nonce not found" };
    if (rec.tokenMint !== tokenMint) return { ok: false, reason: "Nonce mint mismatch" };
    if (rec.walletPubkey !== walletPubkey) return { ok: false, reason: "Nonce wallet mismatch" };
    if (rec.createdAtUnix < cutoff) {
      mem.nonces.delete(nonce);
      return { ok: false, reason: "Nonce expired" };
    }
    mem.nonces.delete(nonce);
    return { ok: true, issuedAtUnix: rec.createdAtUnix };
  }

  const pool = getPool();
  const res = await pool.query(
    "delete from project_declared_wallet_nonces where nonce=$1 and token_mint=$2 and wallet_pubkey=$3 and created_at_unix >= $4 returning created_at_unix",
    [nonce, tokenMint, walletPubkey, String(cutoff)]
  );

  const row = res.rows[0];
  if (!row) return { ok: false, reason: "Nonce invalid or expired" };
  return { ok: true, issuedAtUnix: Number(row.created_at_unix) };
}

function rowToDeclaredWallet(row: any): ProjectDeclaredWalletRecord {
  return {
    id: String(row.id),
    tokenMint: String(row.token_mint),
    walletPubkey: String(row.wallet_pubkey),
    label: row.label ?? null,
    status: String(row.status) as DeclaredWalletStatus,
    addedAtUnix: Number(row.added_at_unix),
    deprecatedAtUnix: row.deprecated_at_unix == null ? null : Number(row.deprecated_at_unix),
    verificationMethod: "message_signature",
    message: String(row.message),
    signature: String(row.signature),
    verifiedAtUnix: Number(row.verified_at_unix),
    verifiedBy: "wallet_owner",
    notes: row.notes ?? null,
  };
}

export async function listDeclaredWallets(input: { tokenMint: string }): Promise<ProjectDeclaredWalletRecord[]> {
  await ensureSchema();

  const tokenMint = String(input.tokenMint ?? "").trim();
  if (!tokenMint) return [];

  if (!hasDatabase()) {
    return (mem.declaredWalletsByMint.get(tokenMint) ?? []).slice().sort((a, b) => a.addedAtUnix - b.addedAtUnix);
  }

  const pool = getPool();
  const res = await pool.query(
    "select * from project_declared_wallets where token_mint=$1 order by added_at_unix asc",
    [tokenMint]
  );
  return res.rows.map(rowToDeclaredWallet);
}

export async function listActiveDeclaredWallets(input: { tokenMint: string }): Promise<ProjectDeclaredWalletRecord[]> {
  const all = await listDeclaredWallets({ tokenMint: input.tokenMint });
  return all.filter((w) => w.status === "active");
}

export async function tryInsertDeclaredWallet(input: {
  tokenMint: string;
  walletPubkey: string;
  label?: string | null;
  message: string;
  signature: string;
  notes?: string | null;
}): Promise<{ inserted: true; record: ProjectDeclaredWalletRecord } | { inserted: false; existing: ProjectDeclaredWalletRecord }> {
  await ensureSchema();

  const tokenMint = String(input.tokenMint ?? "").trim();
  const walletPubkey = String(input.walletPubkey ?? "").trim();
  const label = input.label == null ? null : String(input.label).trim();
  const notes = input.notes == null ? null : String(input.notes);
  const message = String(input.message ?? "");
  const signature = String(input.signature ?? "").trim();

  if (!tokenMint) throw new Error("tokenMint is required");
  if (!walletPubkey) throw new Error("walletPubkey is required");
  if (!signature) throw new Error("signature is required");

  const t = nowUnix();

  if (!hasDatabase()) {
    const prev = mem.declaredWalletsByMint.get(tokenMint) ?? [];
    const existing = prev.find((r) => r.walletPubkey === walletPubkey && r.status === "active");
    if (existing) return { inserted: false, existing };

    const rec: ProjectDeclaredWalletRecord = {
      id: newId(),
      tokenMint,
      walletPubkey,
      label,
      status: "active",
      addedAtUnix: t,
      deprecatedAtUnix: null,
      verificationMethod: "message_signature",
      message,
      signature,
      verifiedAtUnix: t,
      verifiedBy: "wallet_owner",
      notes,
    };

    mem.declaredWalletsByMint.set(tokenMint, prev.concat([rec]));
    return { inserted: true, record: rec };
  }

  const pool = getPool();

  const existingRes = await pool.query(
    "select * from project_declared_wallets where token_mint=$1 and wallet_pubkey=$2 and status='active' order by added_at_unix desc limit 1",
    [tokenMint, walletPubkey]
  );

  const existingRow = existingRes.rows[0];
  if (existingRow) {
    return { inserted: false, existing: rowToDeclaredWallet(existingRow) };
  }

  const recId = newId();

  const res = await pool.query(
    `insert into project_declared_wallets (
      id, token_mint, wallet_pubkey, label, status, added_at_unix, deprecated_at_unix,
      verification_method, message, signature, verified_at_unix, verified_by, notes
    ) values ($1,$2,$3,$4,'active',$5,null,'message_signature',$6,$7,$5,'wallet_owner',$8)
    returning *`,
    [recId, tokenMint, walletPubkey, label, String(t), message, signature, notes]
  );

  const row = res.rows[0];
  if (!row) throw new Error("Failed to insert declared wallet");
  return { inserted: true, record: rowToDeclaredWallet(row) };
}

export async function deprecateDeclaredWallet(input: {
  tokenMint: string;
  walletPubkey: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  await ensureSchema();

  const tokenMint = String(input.tokenMint ?? "").trim();
  const walletPubkey = String(input.walletPubkey ?? "").trim();
  if (!tokenMint || !walletPubkey) return { ok: false, reason: "Missing fields" };

  const t = nowUnix();

  if (!hasDatabase()) {
    const prev = mem.declaredWalletsByMint.get(tokenMint) ?? [];
    const next = prev.map((r) => {
      if (r.walletPubkey !== walletPubkey) return r;
      if (r.status !== "active") return r;
      return { ...r, status: "deprecated" as const, deprecatedAtUnix: t };
    });
    mem.declaredWalletsByMint.set(tokenMint, next);
    return { ok: true };
  }

  const pool = getPool();
  await pool.query(
    "update project_declared_wallets set status='deprecated', deprecated_at_unix=$3 where token_mint=$1 and wallet_pubkey=$2 and status='active'",
    [tokenMint, walletPubkey, String(t)]
  );
  return { ok: true };
}

function rowToSupplySnapshot(row: any): ProjectSupplySnapshotRecord {
  return {
    id: String(row.id),
    tokenMint: String(row.token_mint),
    snapshotAtUnix: Number(row.snapshot_at_unix),
    totalSupplyRaw: String(row.total_supply_raw),
    decimals: Number(row.decimals),
    totalSupplyUi: Number(row.total_supply_ui),
    declaredControlRaw: String(row.declared_control_raw),
    declaredControlUi: Number(row.declared_control_ui),
    declaredControlPct: Number(row.declared_control_pct),
    source: String(row.source) as any,
    inputsHash: String(row.inputs_hash),
  };
}

export async function insertSupplySnapshot(input: Omit<ProjectSupplySnapshotRecord, "id">): Promise<ProjectSupplySnapshotRecord> {
  await ensureSchema();

  const rec: ProjectSupplySnapshotRecord = { ...input, id: newId() };

  if (!hasDatabase()) {
    const prev = mem.supplySnapshotsByMint.get(rec.tokenMint) ?? [];
    mem.supplySnapshotsByMint.set(rec.tokenMint, prev.concat([rec]).slice(-2000));
    return rec;
  }

  const pool = getPool();
  const res = await pool.query(
    `insert into project_supply_snapshots (
      id, token_mint, snapshot_at_unix, total_supply_raw, decimals, total_supply_ui,
      declared_control_raw, declared_control_ui, declared_control_pct, source, inputs_hash
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    returning *`,
    [
      rec.id,
      rec.tokenMint,
      String(rec.snapshotAtUnix),
      rec.totalSupplyRaw,
      rec.decimals,
      rec.totalSupplyUi,
      rec.declaredControlRaw,
      rec.declaredControlUi,
      rec.declaredControlPct,
      rec.source,
      rec.inputsHash,
    ]
  );
  const row = res.rows[0];
  if (!row) throw new Error("Failed to insert supply snapshot");
  return rowToSupplySnapshot(row);
}

export async function listSupplySnapshots(input: {
  tokenMint: string;
  sinceUnix: number;
  limit: number;
}): Promise<ProjectSupplySnapshotRecord[]> {
  await ensureSchema();

  const tokenMint = String(input.tokenMint ?? "").trim();
  const sinceUnix = Math.floor(Number(input.sinceUnix ?? 0));
  const limit = Math.max(1, Math.min(2000, Math.floor(Number(input.limit ?? 200))));

  if (!tokenMint) return [];

  if (!hasDatabase()) {
    const prev = mem.supplySnapshotsByMint.get(tokenMint) ?? [];
    return prev
      .filter((s) => s.snapshotAtUnix >= sinceUnix)
      .slice()
      .sort((a, b) => a.snapshotAtUnix - b.snapshotAtUnix)
      .slice(-limit);
  }

  const pool = getPool();
  const res = await pool.query(
    "select * from project_supply_snapshots where token_mint=$1 and snapshot_at_unix >= $2 order by snapshot_at_unix asc limit $3",
    [tokenMint, String(sinceUnix), limit]
  );
  return res.rows.map(rowToSupplySnapshot);
}

export async function getLatestSupplySnapshot(tokenMint: string): Promise<ProjectSupplySnapshotRecord | null> {
  await ensureSchema();

  const mint = String(tokenMint ?? "").trim();
  if (!mint) return null;

  if (!hasDatabase()) {
    const prev = mem.supplySnapshotsByMint.get(mint) ?? [];
    const sorted = prev.slice().sort((a, b) => b.snapshotAtUnix - a.snapshotAtUnix);
    return sorted[0] ?? null;
  }

  const pool = getPool();
  const res = await pool.query(
    "select * from project_supply_snapshots where token_mint=$1 order by snapshot_at_unix desc limit 1",
    [mint]
  );
  const row = res.rows[0];
  return row ? rowToSupplySnapshot(row) : null;
}

export async function insertWalletBalanceSnapshots(input: {
  tokenMint: string;
  snapshotAtUnix: number;
  balances: Array<{ walletPubkey: string; balanceRaw: string; balanceUi: number; balanceSource: string }>;
}): Promise<void> {
  await ensureSchema();

  const tokenMint = String(input.tokenMint ?? "").trim();
  const snapshotAtUnix = Math.floor(Number(input.snapshotAtUnix ?? 0));
  const balances = Array.isArray(input.balances) ? input.balances : [];

  if (!tokenMint || !snapshotAtUnix) return;

  if (!hasDatabase()) {
    const k = `${tokenMint}:${snapshotAtUnix}`;
    const rows: ProjectWalletBalanceSnapshotRecord[] = balances.map((b) => ({
      id: newId(),
      tokenMint,
      snapshotAtUnix,
      walletPubkey: String(b.walletPubkey ?? "").trim(),
      balanceRaw: String(b.balanceRaw ?? "0"),
      balanceUi: Number(b.balanceUi ?? 0),
      balanceSource: String(b.balanceSource ?? "rpc"),
    }));
    mem.walletBalanceSnapshotsByKey.set(k, rows);
    return;
  }

  const pool = getPool();
  for (const b of balances) {
    const walletPubkey = String(b.walletPubkey ?? "").trim();
    if (!walletPubkey) continue;
    await pool.query(
      `insert into project_wallet_balances_snapshot (id, token_mint, snapshot_at_unix, wallet_pubkey, balance_raw, balance_ui, balance_source)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (token_mint, snapshot_at_unix, wallet_pubkey) do nothing`,
      [newId(), tokenMint, String(snapshotAtUnix), walletPubkey, String(b.balanceRaw ?? "0"), Number(b.balanceUi ?? 0), String(b.balanceSource ?? "rpc")]
    );
  }
}

export async function listTokenMintsWithActiveDeclaredWallets(input: { limit: number }): Promise<string[]> {
  await ensureSchema();

  const limit = Math.max(1, Math.min(1000, Math.floor(Number(input.limit ?? 200))));

  if (!hasDatabase()) {
    const out = new Set<string>();
    for (const [mint, rows] of mem.declaredWalletsByMint.entries()) {
      if (rows.some((r) => r.status === "active")) out.add(mint);
    }
    return Array.from(out).slice(0, limit);
  }

  const pool = getPool();
  const res = await pool.query(
    "select distinct token_mint from project_declared_wallets where status='active' limit $1",
    [limit]
  );
  return res.rows.map((r: any) => String(r.token_mint));
}

export async function computeSnapshotFromRaw(input: {
  tokenMint: string;
  snapshotAtUnix: number;
  decimals: number;
  totalSupplyRaw: bigint;
  balances: Array<{ walletPubkey: string; balanceRaw: bigint }>;
  source: ProjectSupplySnapshotRecord["source"];
  balanceSource: string;
}): Promise<{ snapshot: Omit<ProjectSupplySnapshotRecord, "id">; walletBalances: Array<{ walletPubkey: string; balanceRaw: string; balanceUi: number; balanceSource: string }> }> {
  const tokenMint = String(input.tokenMint ?? "").trim();
  const snapshotAtUnix = Math.floor(Number(input.snapshotAtUnix ?? 0));

  const decimals = Math.max(0, Math.min(18, Math.floor(Number(input.decimals ?? 0))));
  const totalSupplyRaw = BigInt(input.totalSupplyRaw ?? 0);

  const walletBalances = input.balances.map((b) => {
    const raw = BigInt(b.balanceRaw ?? 0);
    return {
      walletPubkey: String(b.walletPubkey ?? "").trim(),
      balanceRaw: raw.toString(),
      balanceUi: uiFromRaw({ amountRaw: raw, decimals }),
      balanceSource: String(input.balanceSource ?? "rpc"),
    };
  });

  let declaredControlRaw = 0n;
  for (const b of input.balances) {
    try {
      declaredControlRaw += BigInt(b.balanceRaw ?? 0);
    } catch {
    }
  }

  const totalSupplyUi = uiFromRaw({ amountRaw: totalSupplyRaw, decimals });
  const declaredControlUi = uiFromRaw({ amountRaw: declaredControlRaw, decimals });

  const declaredControlPct = totalSupplyUi > 0 ? Math.max(0, Math.min(1, declaredControlUi / totalSupplyUi)) : 0;

  const inputsHash = hashInputs({
    tokenMint,
    snapshotAtUnix,
    decimals,
    totalSupplyRaw: totalSupplyRaw.toString(),
    balances: walletBalances.map((w) => ({ walletPubkey: w.walletPubkey, balanceRaw: w.balanceRaw })),
  });

  const snapshot: Omit<ProjectSupplySnapshotRecord, "id"> = {
    tokenMint,
    snapshotAtUnix,
    totalSupplyRaw: totalSupplyRaw.toString(),
    decimals,
    totalSupplyUi,
    declaredControlRaw: declaredControlRaw.toString(),
    declaredControlUi,
    declaredControlPct,
    source: input.source,
    inputsHash,
  };

  return { snapshot, walletBalances };
}
