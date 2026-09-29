-- Ship & Commit - Postgres schema
--
-- Run this in the Supabase SQL editor (or apply via your migration tool).
-- This schema matches the tables used by the Next.js API routes.
--
-- Safe to run multiple times.

-- 1) Commitments (core state)
create table if not exists public.commitments (
  id text primary key,
  statement text null,
  authority text not null,
  destination_on_fail text not null,
  amount_lamports bigint not null,
  deadline_unix bigint not null,
  escrow_pubkey text not null,
  escrow_secret_key text not null,
  kind text not null default 'personal',
  creator_pubkey text null,
  token_mint text null,
  total_funded_lamports bigint not null default 0,
  unlocked_lamports bigint not null default 0,
  milestones_json text null,
  status text not null,
  created_at_unix bigint not null,
  resolved_at_unix bigint null,
  resolved_tx_sig text null
);

create index if not exists commitments_status_idx on public.commitments(status);
create index if not exists commitments_deadline_idx on public.commitments(deadline_unix);
create index if not exists commitments_kind_idx on public.commitments(kind);

-- 2) Reward milestone approval signals (token-holder voting)
create table if not exists public.reward_milestone_signals (
  commitment_id text not null,
  milestone_id text not null,
  signer_pubkey text not null,
  created_at_unix bigint not null,
  primary key (commitment_id, milestone_id, signer_pubkey)
);

create index if not exists reward_milestone_signals_commitment_idx
  on public.reward_milestone_signals(commitment_id);

create index if not exists reward_milestone_signals_milestone_idx
  on public.reward_milestone_signals(commitment_id, milestone_id);

-- 3) Admin wallet login nonces (challenge for signature)
create table if not exists public.admin_nonces (
  wallet_pubkey text not null,
  nonce text primary key,
  created_at_unix bigint not null
);

create index if not exists admin_nonces_wallet_idx
  on public.admin_nonces(wallet_pubkey);

-- 4) Admin sessions (httpOnly cookie session id -> wallet)
create table if not exists public.admin_sessions (
  session_id text primary key,
  wallet_pubkey text not null,
  created_at_unix bigint not null,
  expires_at_unix bigint not null
);

create index if not exists admin_sessions_wallet_idx
  on public.admin_sessions(wallet_pubkey);

create index if not exists admin_sessions_expires_idx
  on public.admin_sessions(expires_at_unix);

-- 5) Reward release idempotency locks (prevents double-send)
create table if not exists public.reward_release_locks (
  commitment_id text not null,
  milestone_id text not null,
  created_at_unix bigint not null,
  tx_sig text null,
  primary key (commitment_id, milestone_id)
);

-- 6) Jupiter price cache (for voting USD threshold)
create table if not exists public.token_price_cache (
  mint text primary key,
  price_usd double precision not null,
  updated_at_unix bigint not null
);

-- Optional hardening (recommended if you don't want these available via Supabase client APIs)
-- revoke all on table
--   public.commitments,
--   public.reward_milestone_signals,
--   public.admin_nonces,
--   public.admin_sessions,
--   public.reward_release_locks,
--   public.token_price_cache
-- from anon, authenticated;
