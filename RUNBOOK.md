# Ship & Commit: Operations Runbook

This runbook covers production on Railway. The Railway project `ship-and-commit` has two services:

| Service | Role |
|---------|------|
| `ship-and-commit` | Next.js app: web, API and the in-process scheduler |
| `Postgres` | Railway Postgres. The app reads it through `DATABASE_URL=${{Postgres.DATABASE_URL}}` |

Variable names that start with `CTS_` come from the project's earlier name and are kept on purpose. Do not rename them.

---

## 1. Deploy

Deploy committed code from a clean checkout. `railway up` uploads your working directory, minus `.gitignore` and `.railwayignore` entries, so uncommitted edits would ship too.

```bash
git status                                # must be clean
railway link                              # once per checkout: project ship-and-commit
railway up --service ship-and-commit      # build + deploy
```

What happens next:

- **Build:** `npm run build`. `NEXT_PUBLIC_*` values are inlined at this step.
- **Start:** `npm run start`, which runs `next start -H 0.0.0.0` on Railway's `PORT`.
- **Healthcheck:** `GET /api/healthz` with a 120 s timeout. The new deployment receives traffic only after it passes.
- **Restarts:** restart policy `ON_FAILURE`, up to 5 retries (see `railway.json`).
- **Boot:** `instrumentation.ts` calls `app/lib/boot.ts`. Boot warms the database schema (tables are created if missing), writes a `server_boot` audit event and starts the scheduler (section 6).

Pre-flight checklist for a first deploy or a new environment:

- [ ] `DATABASE_URL` references the Postgres service.
- [ ] `APP_ORIGIN` is set. Use a comma-separated list if both the Railway domain and a custom domain are live.
- [ ] `ADMIN_WALLET_PUBKEYS`, `ESCROW_DB_SECRET` and `CRON_SECRET` are set. The app throws in production without the first two, and the scheduler stays off without `CRON_SECRET`.
- [ ] `SOLANA_RPC_URL` points to a dedicated provider. The public RPC fallback is heavily rate-limited and logs a warning.
- [ ] `PRIVY_APP_ID`, `PRIVY_APP_SECRET` and `PRIVY_WEBHOOK_SIGNING_SECRET` are set. The Privy webhook points at `https://<domain>/api/webhooks/privy`.
- [ ] `ESCROW_FEE_PAYER_SECRET_KEY` is set and the key is funded with SOL.
- [ ] `CTS_SHIP_BUYBACK_TREASURY_PUBKEY` and `CTS_VOTE_REWARD_FAUCET_OWNER_PUBKEY` are set before any failure distribution runs.
- [ ] `CTS_MOCK_MODE` is unset. The app refuses to use the database in production while it is set.
- [ ] `TRUSTED_PROXY_HOPS=2`, the value verified for Railway.

## 2. Rollback

- **Dashboard (preferred):** open service `ship-and-commit`, go to **Deployments**, choose the last good deployment, open its menu and select **Redeploy** (or **Rollback**). That deployment's build image goes live again, with the `NEXT_PUBLIC_*` values it was built with.
- **CLI:** `railway redeploy --service ship-and-commit` redeploys the latest deployment, which is useful after a crash or a variable change. To return to older code, check out the last good commit in a clean checkout and run `railway up --service ship-and-commit`.
- The schema is additive (`create table if not exists`, `add column if not exists`), so rolling code back does not require a database rollback.

## 3. Health checks

| Endpoint | Checks | Use |
|----------|--------|-----|
| `GET /api/healthz` | Process only. Returns `{status:"ok", uptime}` | Railway liveness. It never touches the database or RPC, so a slow dependency cannot cause restart loops. |
| `GET /api/health` | `SELECT 1` on Postgres, plus Solana RPC | Deep check. Returns HTTP 503 when a dependency is down. |

```bash
curl -s https://<domain>/api/healthz
curl -s https://<domain>/api/health | jq
```

## 4. Logs

```bash
railway logs --service ship-and-commit            # runtime logs of the current deployment
railway logs --service ship-and-commit --build    # build logs
```

Useful prefixes:

- `[scheduler]`: job scheduling, failed jobs and HTTP errors from job endpoints
- `[boot]`: schema warm-up failures
- `[rpc]`: missing `SOLANA_RPC_URL`
- `DB pool error`: Postgres connection problems

Audit trail: the `public.audit_logs` table, which is also viewable by admins at `/admin/audit-logs`. Events whose names contain `_error` or `_denied`, or start with `admin_`, are also posted to `AUDIT_WEBHOOK_URL` when it is set. Audit rows older than 120 days are pruned automatically.

## 5. Environment variables

`.env.example` is the reference for every variable.

```bash
railway variables --service ship-and-commit                        # list
railway variables --service ship-and-commit --set "KEY=value"      # set (triggers a redeploy)
```

- **Server-side variables** take effect on the next deployment. Railway redeploys automatically after a change.
- **`NEXT_PUBLIC_*` variables** are inlined at build time. They need a new build (`railway up`); a restart or a redeploy of an old image does not pick them up.
- **Blank by design for now:** `NEXT_PUBLIC_TOKEN_CONTRACT_ADDRESS`, `CTS_SHIP_TOKEN_MINT` and `NEXT_PUBLIC_X_URL`. Until they are set, the contract pill, X button, `$SHIP` voting multiplier and per-vote rewards stay inactive.
- **Before the custom domain exists:** `APP_ORIGIN` and `NEXT_PUBLIC_SITE_URL` use the Railway domain. When the domain is attached:
  1. Add it to `APP_ORIGIN`, keeping the Railway domain in the comma-separated list.
  2. Set `NEXT_PUBLIC_SITE_URL`.
  3. Rebuild.
  4. Update the Privy webhook URL.

### Secrets and rotation

| Secret | Purpose | Rotation |
|--------|---------|----------|
| `ESCROW_DB_SECRET` | Encrypts escrow secret keys at rest (legacy and dev-fallback keypair escrows; production escrows are Privy wallets) | **Do not rotate while encrypted escrows hold funds.** Dual-key decryption is not implemented, so rotation would need a re-encryption migration. |
| `PRIVY_APP_SECRET` / `PRIVY_AUTHORIZATION_PRIVATE_KEY(S)` | Sign and send transactions from Privy-managed launch, escrow and ASD wallets | Update in Railway, then verify a launch and a claim or release. `PRIVY_AUTHORIZATION_PRIVATE_KEYS` accepts a comma-separated list for overlap. |
| `PRIVY_WEBHOOK_SIGNING_SECRET` | Verifies Privy (Svix) webhooks | Rotate in Privy and Railway together. |
| `ESCROW_FEE_PAYER_SECRET_KEY` | Pays fees for pump.fun fee claims, escrow sweeps, launch-wallet refunds and escrow transfers | Fund the new key, swap the variable, then drain the old key. |
| `CRON_SECRET` | Scheduler and cron endpoints (`x-cron-secret`) | Any long random string. Takes effect on the next deploy. |
| `ASSET_SIGNING_SECRET` | Signs image-upload URLs. Falls back to `ESCROW_DB_SECRET`, then `PRIVY_APP_SECRET` | In-flight uploads (valid for 2 h at most) need a retry. |

## 6. Database

- Railway Postgres. TLS is switched off automatically for `*.railway.internal` and localhost hosts and on for everything else; `PG_SSL` overrides this.
- **Migrations:** there is no migration step. Each store runs `create table if not exists` and `alter table ... add column if not exists` on first use, and boot warms this up. Uploaded images (token icons, banners, avatars) live in the `uploaded_assets` table and are served by `/api/assets/*`, so a database backup covers them too.
- **Pool:** `PG_POOL_MAX` (default 10 in production), `PG_POOL_CONNECTION_TIMEOUT_MS` (10 s) and `PG_POOL_IDLE_TIMEOUT_MS` (30 s).
- **Shell:** `railway connect Postgres` opens `psql`.
- **Backups:** use the Postgres service's **Backups** tab in Railway if your plan includes it. Take a manual dump before risky changes:
  ```bash
  pg_dump "$(railway variables --service Postgres --kv | sed -n 's/^DATABASE_PUBLIC_URL=//p')" -Fc -f ship-commit-$(date +%F).dump
  ```
- **Housekeeping** runs every 30 minutes and prunes:
  - expired rate-limit rows
  - unused launch staging uploads
  - admin nonces older than 1 h
  - expired admin sessions
  - audit logs older than 120 days
  - market snapshots older than 400 days

## 7. Scheduler

The app runs its own scheduler (`app/lib/boot.ts`). Each job calls its admin endpoint over loopback with `x-cron-secret: $CRON_SECRET`, inside a Postgres advisory lock, so overlapping deployments or replicas never run the same job twice.

| Job | Endpoint | Cadence | Runs when |
|-----|----------|---------|-----------|
| Market-cap milestone resolution | `/api/admin/resolve-marketcap-milestones` | 1 min | `CTS_ENABLE_MARKETCAP_MILESTONES=1` |
| Reward milestone normalization (vote windows, approvals, failures, claimable) | `/api/admin/normalize-rewards` | 10 min | always |
| ASD execution | `/api/admin/asd-execute` | 15 min | `CTS_ASD_ENABLE_SWAPS=1` |
| Transparent Bundler snapshots | `/api/admin/transparent-bundler-snapshot` | daily | always |
| Housekeeping | internal | 30 min | always |

- **Production:** the scheduler starts automatically when `CRON_SECRET` is set. `DISABLE_SCHEDULER=1` turns it off, for example if a separate cron service takes over.
- **Development:** the scheduler is off unless `ENABLE_SCHEDULER=1`.
- **Manual trigger:**
  ```bash
  curl -X POST https://<domain>/api/admin/normalize-rewards -H "x-cron-secret: $CRON_SECRET" -H "content-type: application/json" -d '{}'
  ```
- **Not scheduled:** sweeping managed creator fees into escrow. `/api/escrow/sweep` accepts `x-cron-secret` and, with no body, sweeps every managed commitment, but the built-in scheduler does not call it. Today, sweeps happen when a creator triggers one from `/creator` or an admin calls the endpoint. If you want sweeps on a timer, point an external cron at it.
- **Admin-triggered:** failure distributions for failed milestones (`.../milestones/[id]/failure-distribution/create`) require an admin session. They do not run on their own.

## 8. Emergency switches

| Variable | Effect |
|----------|--------|
| `CTS_LAUNCHES_PAUSED=1` | Rejects new Auto-Lock launches with HTTP 503 (`/api/launch/prepare`, `execute`, `dev-buy-tx`, launch image uploads). It does **not** block Manual Lock commitments. |
| `CTS_PUBLIC_LAUNCHES=false` | Restricts launches and new commitments to `CTS_CREATOR_WALLET_PUBKEYS` and admins |
| `CTS_ENABLE_REWARD_PAYOUTS=0` | Stops creator milestone claims and admin releases |
| `CTS_ENABLE_FAILURE_DISTRIBUTION_PAYOUTS=0` | Stops failure-distribution creation and voter claims |
| `CTS_ENABLE_VOTE_REWARD_DISTRIBUTIONS=0` / `CTS_ENABLE_VOTE_REWARD_PAYOUTS=0` | Stops allocating or paying `$SHIP` vote rewards |
| `CTS_ASD_ENABLE_SWAPS=0` | Stops ASD swaps (the job is not scheduled) |
| `CTS_ENABLE_MARKETCAP_MILESTONES=0` | Stops market-cap auto-resolution |
| `DISABLE_SCHEDULER=1` | Stops every background job |

These are server-side flags. Set them with `railway variables --set` and they apply on the automatic redeploy, which takes about a minute.

## 9. Incidents

### Database outage

Symptoms:

- API errors such as `Database connection failed`
- Every request rejected with 429, because rate limiting fails closed in production
- `/api/health` returns 503

Actions:

1. Check the Railway Postgres service (status and metrics).
2. Confirm `DATABASE_URL` still resolves to `${{Postgres.DATABASE_URL}}`.
3. If the database is slow rather than down, raise `PG_POOL_CONNECTION_TIMEOUT_MS`.
4. `/api/healthz` stays green on purpose, so Railway will not restart-loop the app.

### Solana RPC outage or degradation

Symptoms:

- Launches, claims and releases fail to confirm
- Voting times out on balance lookups
- `/api/health` RPC check fails

Actions:

1. Point `SOLANA_RPC_URL` at a backup provider. The browser uses `/api/rpc`, so it follows automatically unless `NEXT_PUBLIC_SOLANA_RPC_URL` is set.
2. Make sure the provider supports `getLatestBlockhash`, `getBlockTime`, `getSignaturesForAddress` and token-account parsing.
3. If launches are failing mid-flight, set `CTS_LAUNCHES_PAUSED=1`.

### Jupiter outage

Symptoms:

- Prices are missing
- ASD swaps error
- Voters get "Token price unavailable"

Behavior and actions:

- Voting falls back to DexScreener prices, then to stale cached prices, and finally to a 1,000-token minimum balance.
- If ASD errors persist, set `CTS_ASD_ENABLE_SWAPS=0`.
- Without `JUPITER_API_BASE_URL` the app uses the keyless `https://lite-api.jup.ag` tier. The keyed tier is `JUPITER_API_BASE_URL=https://api.jup.ag` with `JUPITER_API_KEY`. `JUPITER_TIMEOUT_MS` defaults to 8000.

### Fee payer out of SOL

Symptoms: `Insufficient fee payer balance`, or "Top up the fee payer wallet" hints on sweeps and claims.

Action: fund the `ESCROW_FEE_PAYER_SECRET_KEY` wallet.

### Stuck release lock

Symptom: `Release already in progress`.

Actions:

1. Inspect `reward_release_locks` (and `reward_milestone_payout_claims`) for `(commitment_id, milestone_id)`.
2. If no tx signature was recorded and the lock is stale, first try the admin reconcile endpoint (`POST /api/commitments/[id]/milestones/[milestoneId]/reconcile`). It looks for the on-chain transfer.
3. Clear the row only if the reconcile endpoint finds nothing.

### Stuck pump.fun fee claim

Symptom: `Sweep already in progress` (HTTP 409).

Action: inspect `pumpfun_creator_fee_claim_locks` and clear a stale row once you have confirmed that no claim transaction landed.

### Underfunded escrow

Symptom: `Escrow underfunded for this release` or `Escrow underfunded for milestone failure payout`.

Actions:

1. Check the escrow balance on an explorer.
2. For Auto-Lock projects, sweep pending creator fees first (from `/creator`, or `POST /api/escrow/sweep` as admin or cron).
3. Manual Lock projects are funded by the creator, so communicate this to holders.

### Launch failed after payment

- Each launch is recorded in `launch_attempts`, and its funded launch wallet in `public.launch_treasury_wallets`.
- An admin can refund a launch wallet through `POST /api/launch/refund`, or sweep leftover SOL back to the fee payer through `POST /api/launch/sweep`.
- **Warning:** for Auto-Lock, the launch wallet *is* the project escrow. In batch mode, `/api/launch/sweep` skips wallets whose launch succeeded, but the single-wallet mode (`walletId` or `creatorWallet` in the body) has no such guard. Never point it at the wallet of a live project, because it would move escrowed fees to the fee payer.
- The offline script `npm run recover-sol:dry` lists balances across all Privy wallets.

### Failure distribution refused

Symptom: HTTP 500 `CTS_SHIP_BUYBACK_TREASURY_PUBKEY is required` or `CTS_VOTE_REWARD_FAUCET_OWNER_PUBKEY is required`.

Action: set the missing variable and retry. The endpoint is idempotent: it finds transfers that were already sent before sending new ones.

## 10. Reconciliation

### Escrow balances

For each open commitment, compare the on-chain escrow balance with the expected amount. The expected amount is:

> swept fees − released milestones − reserved failure payouts

The `normalize-rewards` job keeps the derived totals in the database up to date.

### Admin actions

From `audit_logs`, list the `admin_*` events, for example:

- `admin_reward_milestone_release_ok`
- `admin_reward_milestone_release_error`
- `admin_milestone_failure_distribution_ok`
- `admin_milestone_failure_distribution_error`

Confirm every recorded `signature` on an explorer.

### Market-cap confirmations

Every auto-resolved milestone is recorded in two places:

- a row in `marketcap_milestone_confirmations`, with evidence (pair, price, liquidity, samples)
- a `marketcap_milestone_confirmed` audit event
