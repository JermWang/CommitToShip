# Ship & Commit

## Protocol Overview

Ship & Commit is a launch accountability layer for the Solana ecosystem.

We provide the infrastructure for developers to formalize execution commitments, lock capital against delivery milestones, and establish verifiable credibility with market participants before, during, and after token distribution.

Ship & Commit is accountability infrastructure for post-launch execution. It formalizes commitments, milestone escrow, and verifiable delivery records.

---

## Purpose

The accessibility of permissionless token creation has produced an environment where launch is trivial but execution is rare. The result is a market saturated with projects that lack durable intent, transparent timelines, or enforceable accountability.

Ship & Commit exists to address this structural gap.

We provide a neutral commitment registry that enables builders to:

- Bind themselves to explicit delivery timelines
- Lock capital in escrow against milestone completion
- Surface their execution record to stakeholders in a standardized, auditable format

The goal is to make developer intent legible and developer accountability enforceable. Token promotion and token filtering remain outside scope.

---

## Position in the Ecosystem

Ship & Commit operates downstream of Pump.fun and other token creation venues.

| Layer | Function |
|-------|----------|
| **Pump.fun** | Token creation, bonding curve distribution, market discovery |
| **Ship & Commit** | Commitment formalization, milestone escrow, execution verification |

Ship & Commit extends launch infrastructure with accountability primitives that did not previously exist.

**Pump.fun answers:** Can this token launch and trade?

**Ship & Commit answers:** Is this builder bound to a real execution plan, and what mechanisms exist to enforce it?

---

## What We Are

### Accountability Infrastructure

Ship & Commit provides protocol-level primitives for commitment and enforcement:

- **Commitment Objects:** Immutable records of who is responsible, what is promised, and when delivery is expected
- **Milestone Schedules:** Defined unlock conditions tied to verifiable completion events
- **Escrow Mechanics:** Capital locked against delivery, released only upon satisfaction of explicit criteria
- **Audit Trails:** Timestamped, cryptographically signed records of all state transitions

### A Credibility Surface

The platform surfaces builders through demonstrated behavior and verifiable execution:

- Milestone definitions that are specific and measurable
- Completion events that are timestamped and signed
- Holder participation that reflects genuine stakeholder engagement
- Consistent follow-through across commitment lifecycles

The system records execution and makes it visible through public, auditable state transitions.

---

## Scope Boundaries

| Boundary | Clarification |
|----------|---------------|
| **Launch and distribution mechanics** | Token creation and distribution remains with venues like Pump.fun; Ship & Commit focuses on post-launch commitments and verification |
| **Listings and discovery** | Discovery remains external; the platform exposes execution records rather than rankings |
| **Investment recommendations** | Commitments and signals are procedural records; users interpret independently |
| **Custody** | Users retain full control of their wallets; participation uses signed messages |

---

## Commitment Lifecycle

### 1. Commitment Creation

A builder establishes a public commitment containing:

- Authority wallet (the accountable party)
- Commitment statement (the declared intent)
- Milestone definitions (deliverables and unlock amounts)
- Timing constraints (deadlines, claim windows, delay periods)

This record is immutable once created.

### 2. Milestone Completion

Upon completing a milestone, the builder signs a completion attestation. This creates a verifiable record establishing:

- Explicit acknowledgment of completion by the authority
- Precise timestamp of the completion event

### 3. Holder Signaling

Token holders may signal approval for completed milestones via signed messages.

Signaling can be configured to require token ownership and minimum eligibility thresholds, ensuring that governance reflects genuine stakeholder participation rather than synthetic activity.

### 4. Unlock Conditions

A milestone transitions from locked to claimable only when all defined conditions are satisfied:

- Completion attestation signed
- Required delay period elapsed
- Approval threshold met (if configured)

### 5. Release

Fund release is an explicit, auditable action tied to on-chain transactions and server-side audit logs.

The system is intentionally conservative. Clarity and traceability take precedence over automation.

### 6. Failure Distribution

When a creator misses deadlines or fails to deliver on milestones, the escrowed funds are redistributed:

| Allocation | Recipient | Purpose |
|------------|-----------|---------|
| **50%** | Token holders who voted | Rewards engaged community members proportionally based on holdings and $SHIP multiplier |
| **50%** | $SHIP buyback treasury | Fuels protocol sustainability through token buybacks |

This mechanism ensures:

- **Holder protection:** Voters who participated in governance receive compensation
- **Protocol alignment:** Failed commitments strengthen the $SHIP ecosystem
- **Accountability enforcement:** Creators face real consequences for non-delivery

If no voters participated, the entire escrow balance routes to the buyback treasury.

---

## For Builders

Ship & Commit provides a mechanism to communicate seriousness through structure rather than narrative.

- **Formalized Intent:** Milestones and timelines are defined at commitment creation
- **Verifiable Progress:** Completion events are public, timestamped, and cryptographically signed
- **Stakeholder Alignment:** Holder signaling creates a feedback loop between execution and community
- **Credibility Differentiation:** Builders who deliver become distinguishable through verified outcomes

This is infrastructure for developers who intend to ship and want that intent to be legible.

---

## For Participants

Ship & Commit provides structured transparency for evaluating projects beyond price action.

- **Accountability Clarity:** Explicit record of who is responsible and what they have committed to deliver
- **Observable Execution:** Milestone state transitions with precise timestamps
- **Governance Visibility:** Transparent holder participation in approval processes
- **Reduced Information Asymmetry:** Clear separation between delivery claims and public execution records

---

## Design Principles

| Principle | Implementation |
|-----------|----------------|
| **Neutrality** | The system is infrastructure and avoids editorialization or promotion. |
| **Explicitness** | All state transitions are recorded and auditable. Nothing is implicit. |
| **Verifiability** | Key actions are wallet-signed and/or anchored to on-chain transactions. |
| **Conservatism** | Enforcement mechanisms are designed to be understandable under adversarial conditions. |
| **Long-term Alignment** | The system rewards follow-through and sustained delivery behavior. |

---

## Security Model

- **Wallet custody:** Users retain full control of their assets at all times
- **Signed participation:** Completion attestations and governance signals use cryptographic signatures
- **Dedicated escrows:** Commitment capital is held in purpose-built on-chain addresses
- **Explicit release:** Fund movements are auditable, rate-limited, and origin-protected
- **Defense in depth:** Sensitive operations require admin authentication with hardware wallet signing

---

## Credibility Over Curation

Ship & Commit curates execution signals. Token curation remains outside scope.

The platform surfaces:

- Commitments that are clearly defined and publicly recorded
- Milestones that are completed under transparent, enforceable rules
- Holder signaling patterns that indicate sustained stakeholder engagement

The output is a credibility surface, a mechanism for differentiating builders by behavior and follow-through.

---

## Frequently Asked Questions

**Does Ship & Commit replace Pump.fun?**

No. We complement Pump.fun by providing accountability infrastructure for post-launch execution. Pump.fun handles creation and distribution. We handle commitment and verification.

**Is this a guarantee of delivery?**

No. It is a framework for making delivery commitments explicit, trackable, and resistant to quiet abandonment. The system creates accountability, not certainty.

**Does the platform rank tokens by performance?**

No. We surface execution signals and commitment integrity. Market performance is outside our scope.

**Who is this for?**

Builders who intend to ship and want that intent to be credible.
Participants who want structured transparency and enforceable accountability.

---

## Summary

Ship & Commit is accountability infrastructure for the permissionless token economy.

We exist to surface and support developers who commit to execution, transparency, and follow-through. We formalize commitment, make developer intent legible, and create long-term trust between builders and participants.

Ship & Commit operates as the accountability layer for post-launch execution.
