# Ship & Commit — Operations Runbook

## Production Deployment Checklist

- Configure environment variables (see `.env.example`).
- Tables are created automatically at runtime (no manual migrations are needed on a fresh Postgres).
- Ensure `DATABASE_URL` is set (required in production; on Railway reference the Postgres service).
- Ensure `CRON_SECRET` is set (required for the built-in background scheduler).
- Set `CTS_PUBLIC_LAUNCHES=true` to allow anyone to launch; `CTS_LAUNCHES_PAUSED=1` is the emergency stop.
- Ensure `CTS_MOCK_MODE` is unset/false (forbidden in production).
- Ensure `ESCROW_DB_SECRET` is set (required in production to encrypt escrow secrets).
- Ensure `ADMIN_WALLET_PUBKEYS` is set (required in production).
- Ensure `APP_ORIGIN` is set (required in production for admin endpoints).
- Ensure `SOLANA_RPC_URL` points to a reliable provider.

## Critical Secrets + Rotation

### `ESCROW_DB_SECRET`

- Purpose: encrypts escrow secret keys at rest.
- Rotation requires a controlled migration:
  - Deploy code that can decrypt with both old+new keys (not implemented).
  - Re-encrypt all escrow secrets.
  - Remove old key.

### `PRIVY_APP_SECRET`

- Purpose: signs and sends transactions for Privy-managed escrow wallets.
- Rotation:
  - Update secret in hosting provider.
  - Validate pump.fun launch flow and any Privy wallet signing paths.

### `ASSET_SIGNING_SECRET` (falls back to `ESCROW_DB_SECRET`)

- Purpose: signs short-lived image upload URLs (token icons, banners, avatars).
- Rotation: update in Railway; in-flight uploads (max 2h validity) will need a retry.

### `ESCROW_FEE_PAYER_SECRET_KEY` (optional)

- Purpose: sponsor fees for escrow transfers.
- Rotation:
  - Replace with a funded new key.
  - Monitor for failed fee-payer balance checks.

## Monitoring & Alerts

### Audit Logs

- Stored in Postgres table: `public.audit_logs`.
- High-signal events can optionally be delivered to `AUDIT_WEBHOOK_URL`.

Recommended alert triggers:

- Any `*_error` event.
- Any `*_denied` event.
- Any `admin_*` event.

### Rate Limiting

- Stored in Postgres table: `public.rate_limits`.
- If DB is down in production, rate limiting fails closed (requests are rejected).

## Incident Response

### 1) Database outage / connection failures

Symptoms:

- API endpoints return `Database connection failed`.
- Rate limiting begins rejecting requests.

Actions:

- Confirm `DATABASE_URL` validity.
- Confirm the Railway Postgres service is healthy (Railway dashboard → Postgres → Metrics).
- Ensure `DATABASE_URL` references the Postgres service (`${{Postgres.DATABASE_URL}}`).
- Consider temporarily increasing `PG_POOL_CONNECTION_TIMEOUT_MS`.
- Liveness for the platform healthcheck is `/api/healthz` (no dependencies); `/api/health` runs the deep DB + RPC checks.

### 2) Solana RPC outage / degraded RPC

Symptoms:

- Funding/release actions fail to confirm.
- Voting endpoints time out.

Actions:

- Switch `SOLANA_RPC_URL` to a backup provider.
- Verify the new RPC supports `getLatestBlockhash`, `getBlockTime`, token account parsing.

### 3) Stuck “release lock” / concurrent release

Symptoms:

- Reward milestone release returns `Release already in progress`.

Actions:

- Check `reward_release_locks` row for that `(commitmentId, milestoneId)`.
- If no tx sig and lock is stale, delete/clear lock row.

### 4) Underfunded escrow

Symptoms:

- Release endpoint fails with `Escrow underfunded for this release`.

Actions:

- Verify escrow address balance in explorer.
- In assisted mode, funding is voluntary; communicate expectations clearly.
- In managed mode, verify fee routing is correctly configured.

## Reconciliation

### Escrow balance reconciliation

- Query all open commitments.
- For each commitment:
  - Fetch escrow balance on-chain.
  - Compare against expected funded amount (personal) or milestone unlock schedule (reward).

### Admin action reconciliation

- Use `audit_logs` to enumerate:
  - `admin_commitment_*`
  - `admin_reward_milestone_release_*`
  - `admin_pumpfun_launch_*`

For each event with a `signature`, confirm the tx on explorer.

## Scheduled Tasks

### Built-in scheduler

The web service runs its own scheduler (see `app/lib/boot.ts`); each job calls its admin endpoint over loopback with `CRON_SECRET` and takes a Postgres advisory lock, so several replicas never double-run a job:

| Job | Endpoint | Cadence |
|-----|----------|---------|
| Market-cap milestone resolution | `/api/admin/resolve-marketcap-milestones` | 1 min (if `CTS_ENABLE_MARKETCAP_MILESTONES`) |
| Reward milestone normalization | `/api/admin/normalize-rewards` | 10 min |
| ASD execution | `/api/admin/asd-execute` | 15 min (if `CTS_ASD_ENABLE_SWAPS`) |
| Bundler snapshots | `/api/admin/transparent-bundler-snapshot` | daily |
| Housekeeping (rate limits, staging uploads, nonces, old logs) | internal | 30 min |

Set `DISABLE_SCHEDULER=1` to turn it off (for example if you run a separate cron service).
Manual trigger: `POST` the endpoint with header `x-cron-secret: $CRON_SECRET`.
