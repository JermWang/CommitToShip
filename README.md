# Ship & Commit

Ship & Commit is a Solana launchpad that ties a token creator's pump.fun creator fees to delivery. Fees are locked in an on-chain escrow, the creator commits to milestones, token holders vote on whether each milestone was delivered, and escrow is released to the creator only for approved milestones. Missed milestones are forfeited to the holders who voted and to `$SHIP` buybacks and rewards.

## How it works

The homepage (`/`) walks through these steps as a scroll story.

1. **Launch.** Name the token, add an image and approve once. The token goes live on pump.fun from a dedicated Privy-managed launch wallet with Auto-Lock on. Already launched? Use **Manual Lock** to link an existing pump.fun token after proving you control the dev wallet.
2. **Lock.** Creator fees are swept from pump.fun's creator vault into the project's dedicated escrow. For Auto-Lock, the escrow is the Privy-managed launch wallet itself. Anyone can check the balance on-chain.
3. **Commit.** The creator adds milestones, each unlocking part of the escrow. A milestone is either a **deadline** (deliver by a date) or a **market-cap** goal (resolved automatically by the scheduler once the market cap holds above the target).
4. **Verify.** When a deadline milestone ships, the creator signs a completion message and holders vote approve or reject with signed wallet messages. A milestone passes when it reaches the approval threshold and has more approvals than rejections.
5. **Release.** Approved milestones become claimable after a delay and the creator claims them from escrow. Failed milestones are forfeited: 50% to the holders who voted (weighted by holdings and `$SHIP` multiplier), 45% to the `$SHIP` buyback treasury and 5% to the vote-reward treasury.

The exact rules, timings and defaults are in [docs/platform-overview.md](docs/platform-overview.md), which is also shown in the app at `/docs/platform-overview`.

## Features

- **Auto-Lock launches** on pump.fun with a Privy-managed launch wallet and escrow, plus an optional dev buy after launch.
- **Manual Lock** for tokens that are already live, gated on dev-wallet verification.
- **Deadline and market-cap milestones.** Market-cap milestones need a sustained run above the target, with liquidity floors and a minimum number of samples, so a single price spike cannot resolve them.
- **Holder voting** with signed messages and a minimum holding value per voter.
- **Failure distributions** that split forfeited escrow between voters and the `$SHIP` treasuries.
- **Vote rewards**: an optional fixed `$SHIP` amount per vote, claimable from the holder dashboard.
- **Creator dashboard** (`/creator`) for managing milestones, sweeping fees and claiming releases. **Holder dashboard** (`/dashboard`) for vote rewards and balances. **Public profiles** at `/u/[wallet]`.
- **API-only utilities** (no UI yet): ASD, which sells a capped daily percentage of a creator-funded token vault through Jupiter, and Transparent Bundler, which handles declared team wallets and daily supply snapshots.
- **Audit log** of every sensitive action, viewable by admins at `/admin/audit-logs`.

## Tech stack

- Next.js 14 (App Router) and TypeScript on Node 20.18+
- Solana: `@solana/web3.js` and wallet-adapter (Phantom, Solflare, Backpack)
- Postgres through `pg`. The app creates its own tables at runtime.
- Privy server wallets for launch, escrow and ASD wallets
- pump.fun / PumpPortal for launches and fee claims, Jupiter for prices and swaps, DexScreener for market data
- three.js for the homepage emblem
- Hosted on Railway: one web service plus Railway Postgres

## Routes

| Route | What it is |
|-------|------------|
| `/` | "How it works" scroll story (Launch, Lock, Commit, Verify, Release, Your turn) |
| `/?tab=commit` | Launchpad: Auto-Lock launch or Manual Lock |
| `/?tab=discover` | Discover live projects |
| `/story` | Permanent redirect to `/` |
| `/commit/[id]` | Project page: escrow, milestones, voting, claims |
| `/creator` | Creator dashboard |
| `/dashboard` | Holder dashboard: vote rewards and `$SHIP` balance |
| `/u/[wallet]` | Public profile |
| `/admin/audit-logs` | Admin audit-log viewer (wallet-signed admin login) |
| `/docs/platform-overview` | Platform overview, rendered from `docs/platform-overview.md` |

API routes are in `app/api/**`. The main groups are:

- `launch/*` and `pumpfun/*`: launch flow and fee claims
- `commitments/*`: commitments, milestones, votes, claims and distributions
- `projects/*` and `profiles/*`: metadata, images and declared wallets
- `vote-reward/*`, `wallet/*` and `timeline`
- `admin/*`: admin endpoints and scheduler jobs
- `webhooks/privy`: Privy webhook receiver

Infrastructure routes:

- `/api/healthz`: liveness, with no dependencies
- `/api/health`: database and RPC check
- `/api/rpc`: same-origin Solana RPC proxy with a method allowlist, so the server RPC key never reaches the browser
- `/api/assets/*`: signed image uploads, served from Postgres

## Local development

```bash
npm install
cp .env.example .env.local      # fill in what you need
npm run dev                     # http://localhost:3000
```

- With no `DATABASE_URL` (or with `CTS_MOCK_MODE=1`), the app runs on seeded in-memory mock data. Mock mode is refused when `NODE_ENV=production`.
- With a `DATABASE_URL`, tables are created automatically on first use.
- The background scheduler is off in development. To run it locally, set `ENABLE_SCHEDULER=1` and `CRON_SECRET`.
- Launches and payouts need a real `SOLANA_RPC_URL`, Privy credentials and a funded `ESCROW_FEE_PAYER_SECRET_KEY`.

## Environment

All variables are documented in [`.env.example`](.env.example). Names that start with `CTS_` come from the project's earlier name and are kept on purpose; renaming them would break existing deployments.

Required in production:

- `DATABASE_URL`: on Railway, `${{Postgres.DATABASE_URL}}`
- `APP_ORIGIN`: allowed origins, comma-separated
- `ADMIN_WALLET_PUBKEYS`
- `ESCROW_DB_SECRET`: never change it once escrows exist
- `CRON_SECRET`: without it, the scheduler does not start
- `SOLANA_RPC_URL`: use a dedicated provider
- `PRIVY_APP_ID`, `PRIVY_APP_SECRET` and `PRIVY_WEBHOOK_SIGNING_SECRET`. Every production escrow is a Privy wallet, so these are needed even for Manual Lock.
- `ESCROW_FEE_PAYER_SECRET_KEY`: a funded key that pays fees for fee claims, sweeps and refunds

Needed for forfeits and rewards: `CTS_SHIP_BUYBACK_TREASURY_PUBKEY` and `CTS_VOTE_REWARD_FAUCET_OWNER_PUBKEY`. A failure distribution is refused while either is missing.

Intentionally blank for now: `NEXT_PUBLIC_TOKEN_CONTRACT_ADDRESS`, `CTS_SHIP_TOKEN_MINT` and `NEXT_PUBLIC_X_URL`. While they are empty, the nav contract pill and X button are hidden, and the `$SHIP` voting multiplier and per-vote rewards are inactive. `NEXT_PUBLIC_SITE_URL` and `APP_ORIGIN` fall back to the Railway domain until a custom domain is attached.

`NEXT_PUBLIC_*` variables are inlined at build time, so changing one requires a rebuild.

## Deploying to Railway

The Railway project `ship-and-commit` has two services: the app (`ship-and-commit`) and **Postgres**.

1. On the app service, set the variables from `.env.example`, with `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
2. Deploy from a clean checkout of committed code. `railway up` uploads your working directory, including uncommitted changes:
   ```bash
   railway up --service ship-and-commit
   ```
3. `railway.json` sets the build (`npm run build`), the start command (`npm run start`, which binds `0.0.0.0`), the `/api/healthz` healthcheck and restart-on-failure. `.railwayignore` keeps local-only files out of the upload.
4. On boot, `instrumentation.ts` calls `app/lib/boot.ts`. Boot warms the database schema and, in production with `CRON_SECRET` set, starts the in-process scheduler.
5. In the Privy dashboard, point the webhook at `https://<your-domain>/api/webhooks/privy`.

Operations, rollback and incident handling are covered in [RUNBOOK.md](RUNBOOK.md).

## Project structure

```
app/
  page.tsx            "/" - story, or launchpad when ?tab=commit|discover
  HomeApp.tsx         launchpad (commit + discover tabs)
  story/              scroll story: emblem (three.js), ASCII horizon, chapters
  commit/ creator/ dashboard/ u/ admin/ docs/   pages
  components/         shared UI
  api/                route handlers
  lib/                server + shared libs (db, escrow store, Privy, pump.fun, Jupiter, scheduler in boot.ts)
docs/                 platform overview (rendered in-app) + reference PDF
public/               static assets and branding
instrumentation.ts    server boot hook (schema warm-up + scheduler)
railway.json          Railway build/deploy config
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Next.js dev server on port 3000 |
| `npm run build` | Production build |
| `npm run start` | Production server (`next start -H 0.0.0.0`; Railway sets `PORT`) |
| `npm run lint` | ESLint |
| `npm run recover-sol` / `recover-sol:dry` | Sweep leftover SOL from Privy-managed wallets (`scripts/recover-privy-sol.ts`; local only, not deployed). Check the hard-coded destination before running. |

## Custody

Users keep custody of their own wallets and take part through signed messages. In production, every new escrow (Auto-Lock and Manual Lock), every launch wallet and every ASD vault is a Privy-managed server wallet that signs through the Privy API. Raw escrow keypairs appear only in two cases: as a development fallback when Privy is unavailable, and in older escrows. Those keys are encrypted at rest with `ESCROW_DB_SECRET`. Every release, claim and distribution is an on-chain transfer recorded in the audit log.
