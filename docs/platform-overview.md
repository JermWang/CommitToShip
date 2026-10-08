# Ship & Commit

## Overview

Ship & Commit is a launchpad on Solana that ties a creator's pump.fun creator fees to delivery.

Launching a token is easy; shipping is the hard part. Ship & Commit puts creator fees in an on-chain escrow, has the creator commit to milestones, and lets token holders decide whether each milestone was delivered. Creators get paid for what they ship. When a milestone is missed, the holders who voted get paid instead.

Every step is either a signed wallet message or an on-chain transaction, so anyone can check the record.

---

## How It Works

| Step | What happens |
|------|--------------|
| **1. Launch** | Launch on pump.fun with Auto-Lock on, or link a token you have already launched. |
| **2. Lock** | Creator fees go into a dedicated on-chain escrow instead of a personal wallet. |
| **3. Commit** | The creator sets milestones. Each one unlocks a share of the escrow. |
| **4. Verify** | Token holders review delivered milestones and vote with signed messages. |
| **5. Release** | Approved milestones pay the creator. Missed milestones are forfeited to voters and `$SHIP`. |

---

## 1. Launch

### Launch with Auto-Lock

Name your token, add an image and approve once.

- Ship & Commit creates a dedicated launch wallet for your token.
- You send about **0.011 SOL** to that wallet to cover pump.fun account rent and network fees.
- The token goes live on pump.fun from the launch wallet, with Auto-Lock already on.

Notes:

- Your form is validated, and your wallet's eligibility checked, **before** you are asked to send any SOL.
- Each wallet can run one Auto-Lock launch.
- After launch, you can optionally make a dev buy from your own wallet.
- The token's on-chain description includes a short "Launched with Ship & Commit" attribution.

### Manual Lock

Already launched on pump.fun? Link the existing token and prove that you control its dev wallet by signing a message. The project then gets its own escrow and milestones, the same as an Auto-Lock project. With Manual Lock, you fund the escrow yourself.

---

## 2. Lock

Every project has a **dedicated escrow address** on Solana:

- Anyone can see the balance on-chain.
- Funds leave it only through the release and forfeit rules below, and every movement is an on-chain transfer.
- With Auto-Lock, the platform-managed launch wallet is both the token's creator on pump.fun and the project's escrow. Creator fees build up in pump.fun's creator vault and are swept into the escrow. The creator can trigger a sweep from the creator dashboard at any time.

---

## 3. Commit

From the creator dashboard, the creator adds milestones. Each milestone unlocks a **percentage of the escrow**, and the total cannot go above 100%. There are two kinds.

### Deadline milestones

A deliverable with a due date. The creator can edit it until it is marked complete.

### Market-cap milestones

A market-cap target (for example `$250k` or `$10m`) that resolves itself, with no voting and no deadline. The platform tracks the token's market price, and the milestone counts as reached only after a **sustained** run above the target:

- the price stays above the target for about 15 minutes
- across a minimum number of consecutive price samples
- with no large gaps in data
- above a minimum liquidity floor

Only prices observed **after** the milestone was created count, and a single price spike is never enough. Market-cap milestones cannot be edited.

---

## 4. Verify

### Completing a milestone

When a deadline milestone ships, the creator signs a completion message. The creator can also ask for an **early review**, which opens voting right away instead of at the due date.

If a milestone is not marked complete within **24 hours after its due date**, it fails.

### Voting

- **Who can vote:** any wallet holding the project token worth **more than $20**. If no price is available, holding at least 1,000 tokens qualifies.
- **How:** approve or reject, with a signed wallet message. There are no transactions and no gas, and each wallet counts once per milestone.
- **When:** voting runs for **24 hours**, starting at the due date or when an early review opens. Votes outside that window do not count.
- **Passing:** a milestone is approved when it gets the minimum number of approving wallets set by the platform **and** more approvals than rejections. Otherwise it fails.

The project page shows the current approval threshold and live vote counts.

### Vote rewards

When enabled, every eligible vote cast inside the voting window earns a fixed `$SHIP` reward. You can claim it from your dashboard.

---

## 5. Release

### Approved: the creator gets paid

An approved milestone becomes **claimable 48 hours after it was completed**. The creator claims it with a signed message, and the milestone's share of the escrow is transferred on-chain to the creator. Market-cap milestones follow the same claim delay once they are reached.

### Missed: holders get paid

A failed milestone forfeits its share of the escrow, which is split as follows:

| Share | Recipient |
|-------|-----------|
| **50%** | Holders who voted on that milestone |
| **45%** | `$SHIP` buyback treasury |
| **5%** | `$SHIP` vote-reward treasury |

The voter share is split by weight. Each voter's weight is their project-token holdings at the time they voted, multiplied by a `$SHIP` holder multiplier:

| `$SHIP` held | Multiplier |
|--------------|------------|
| Under 100,000 | 1x |
| 100,000 or more | 1.3x |
| 10,000,000 or more | 2x |

When participation weighting is enabled, wallets that vote consistently across recent milestones get a further bonus, and wallets that skip votes get a penalty.

If no eligible holders voted, the voter share goes to the buyback treasury. Voters claim their share from the project page.

---

## Utilities

- **Creator dashboard** (`/creator`): manage milestones, sweep fees into escrow and claim releases.
- **Holder dashboard** (`/dashboard`): track and claim vote rewards and see your `$SHIP` balance.
- **Profiles** (`/u/<wallet>`): public creator and holder profiles.
- **Discover**: live projects with their escrowed amounts.
- **ASD**: an opt-in tool for creators. You lock project tokens in a dedicated vault, and a capped daily percentage is sold through Jupiter on a fixed schedule. The creator signs the configuration and can pause it at any time.
- **Transparent Bundler**: creators declare and verify team wallets, and the platform snapshots their balances daily so holders can see team supply.

---

## Security Model

- **You keep custody.** Holders and creators use their own wallets. Voting, completing milestones and claiming are all done with signed messages.
- **Dedicated escrows.** Each project's escrow is a platform-managed server wallet (Privy). It is used only for that project's sweeps, releases and forfeits.
- **Explicit, audited movements.** Every release, claim and forfeit is an on-chain transfer and is written to an audit log.
- **Defense in depth.** Rate limiting, origin checks, replay protection on signed messages, and wallet-signed admin sessions.

---

## Scope

| Ship & Commit does | Ship & Commit does not |
|--------------------|------------------------|
| Lock creator fees and release them against milestones | Guarantee that a project will deliver |
| Record commitments, votes and payouts publicly | Rank or recommend tokens |
| Let holders decide whether work was delivered | Hold users' personal wallets or funds |

Nothing on the platform is investment advice.

---

## FAQ

**Does Ship & Commit replace pump.fun?**
No. Tokens launch and trade on pump.fun. Ship & Commit adds the escrow, milestones and holder verification.

**Is delivery guaranteed?**
No. The system makes commitments explicit and enforceable: an unshipped milestone costs the creator its share of the escrow.

**Do I need `$SHIP` to vote?**
No. You only need to hold the project's token. Holding `$SHIP` increases your share of forfeited funds.

**Can a creator withdraw escrow early?**
No. Escrow is released only for approved milestones after the claim delay.
