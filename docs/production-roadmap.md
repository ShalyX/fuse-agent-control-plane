# Fuse Production Roadmap

## Purpose

This roadmap turns the Arc hackathon proof into a production agent-spending control plane. It combines the original custody and trust framing with the production-engineering, defensibility, and go-to-market assessments.

The near-term priority is architectural. Pricing and go-to-market hypotheses remain reference material until the custody-agnostic foundation is real enough to put in front of prospective customers.

## Where the demo assumptions stop being safe

The demo controls both sides of every transaction. Fuse triggers signatures for the parent wallet, decides whether a child request is authorized, and calculates the charge. Scout, Builder, and Reviewer are Fuse-controlled logical identities rather than independent economic counterparties.

That assumption ends when an external organization controls the parent agent or funds. The production architecture must not assume that Fuse, the customer, provider, signer, and settlement rail share one trust boundary.

## Phase 0A — Authority, custody, and economic-risk gate

This is a product, architecture, and legal decision rather than an engineering default. It blocks production wallet provisioning, signing, settlement ownership, mainnet deployment, and launch with real customer funds.

### Core question

Does Fuse ever have unilateral authority to trigger signatures that move a customer's funds?

Circle Developer-Controlled Wallets keep key material at Circle, but Fuse's backend can request signatures. The distinction between key custody and practical authority over money movement must not be used to pre-answer legal or regulatory analysis.

### Models to evaluate

| Model | Signing authority | Provider-cost risk | Autonomy |
|---|---|---:|---|
| Fuse-triggered Developer-Controlled Wallet | Fuse backend | Fuse or customer depending on funding | High |
| Customer-operated signer service | Customer infrastructure | Customer | High |
| Delegated or session key | Limited customer delegation | Bounded by delegation | High |
| Smart-account spending permission | On-chain policy | Bounded by contract | High |
| Pre-funded Fuse balance | Fuse inside funded amount | Bounded by prepayment | High |
| Bring-your-own provider credential | Provider bills customer directly | Customer | High |
| Human-approved user wallet | Customer | Customer | Low |

User-controlled does not inherently require a human click for every request; an automated customer-controlled signer or delegated key may preserve autonomy without giving Fuse the master authority.

### Economic-risk requirement

Provider inference must not proceed against an unenforceable promise to pay. Candidate mechanisms include:

- a pre-funded customer balance with internal reservation and exact final debit;
- rail-native maximum authorization followed by exact capture, if Circle supports those semantics;
- customer-operated signing under bounded delegated authority;
- customer-owned provider credentials, so the provider invoices the customer directly.

“Charge a conservative estimate and credit the difference” is not assumed to be the final design. It can create overcharge, refund, liability, statement, and reconciliation complexity. The selected mechanism must preserve exact accounting without exposing Fuse to unbounded provider cost.

### Phase 0A outputs

- Qualified fintech regulatory analysis
- Money-transmission and custody analysis
- Trust-boundary and abuse-case model
- Authority/custody decision matrix
- Provider-payment responsibility decision
- Control-only versus settlement-mode decision
- Geographic launch scope
- Terms of service and privacy-policy requirements
- Contract governance and administrative-key assumptions

## Phase 0B — Custody-agnostic foundation

This proceeds in parallel with Phase 0A. It must not encode assumptions about who owns a wallet, controls a signer, or bears provider costs.

### Financial ledger

All monetary mutations use an append-only, balanced ledger:

- Atomic integer amounts only
- Explicit asset, chain, and account identifiers
- Balanced debit and credit totals per journal entry
- Immutable tariff references
- Reservations, releases, charges, refunds, reclaims, reversals, and adjustments as separate entries
- Current balances derived as projections rather than mutable source-of-truth values
- Continuous invariant checks

Initial account classes include customer available, customer reserved, child delegated authority, provider expense, Fuse receivable, Gateway pending settlement, Gateway finalized settlement, refund liability, and reconciliation discrepancy.

### Independent lifecycle state machines

**Request**

```text
received → admitted → reserved → provider_pending → response_held
→ payment_pending → released → completed
```

Exceptional terminal or review states include provider_failed, reservation_expired, payment_rejected, response_expired, manual_review, and compensation_required.

**Payment**

```text
created → signed → submitted → accepted → pending_batch → finalized
```

Exceptional states include rejected, expired, failed, reversed, disputed, and unknown.

**Mandate**

```text
draft → active → paused → closing → closed
```

Exceptional states include exhausted, tripped, expired, and reconciliation_hold.

### Production invariants

- A provider completion is billed at most once.
- A payment authorization reconciles at most once.
- A released response corresponds to one admitted request.
- Settled spend never exceeds active authority.
- Child authority never exceeds its parent’s delegable balance.
- Reclaim never includes reserved or settled authority.
- Expiring a reservation cannot erase a later valid settlement.
- Every monetary mutation produces a balanced journal entry.
- Every state transition identifies its actor and causal event.
- A tariff is immutable once referenced by a receipt.
- A finalized receipt cannot be silently modified.
- Duplicate webhook delivery is harmless.
- Unknown settlement states enter an operator-visible discrepancy queue.

## Phase 1A — Production control foundation

**Outcome:** one provider, reliable policy enforcement, and customer-controlled provider billing. This can become useful before Fuse controls customer funds.

### Normalized data model

Replace the demo’s serialized state record with normalized entities:

- organizations
- users and service accounts
- agent identities
- provider configurations and credentials
- mandates and delegated allowances
- reservations and usage events
- tariff versions and quotes
- held responses
- policy versions
- circuit transitions
- audit events
- receipt bundles and Arc anchors

Settlement-mode tables are designed but activated only after Phase 0A resolves authority and custody.

### Authentication and authorization

- Organization accounts
- Role-based access
- Scoped agent API keys
- Rotation and revocation
- Per-mandate capabilities
- Administrative separation between funding, policy, and operations
- Tamper-evident audit history
- No operational access based only on a child name or mandate identifier

### Provider adapter layer

The official Anthropic Messages API is the first adapter. AgentRouter has already been removed from runtime, source, scripts, tests, dependencies, and Vercel configuration.

The common provider contract must support:

- provider-reported usage normalization
- streaming
- provider-specific error classification
- bounded timeouts and retry policy
- idempotency behavior
- tariff-version references
- model capability metadata
- credential isolation
- provider health and latency instrumentation

Future adapters include OpenAI, Google, internal inference endpoints, aggregators, MCP services, and non-LLM paid tools.

### Reliability

Design and test explicitly for:

- concurrent requests against one mandate
- duplicate and out-of-order retries
- provider success followed by database failure
- payment success followed by response loss
- process termination at every lifecycle boundary
- network partitions
- duplicate webhook delivery
- stale reservations
- poison queue messages
- Postgres failover and restore

The standard is that every request reaches one explainable terminal or operator-review state.

### Security

- Managed secret storage rather than production `.env` files
- Encryption in transit and at rest
- Strict log redaction
- Rate limiting and abuse controls
- Dependency and container scanning
- External API penetration testing
- Incident-response procedures
- Retention and deletion policies
- External contract review before mainnet

### Operator console

Authenticated and intentionally narrow:

- create an organization
- configure a provider
- create a mandate
- register agent identities
- delegate allowances
- inspect requests, policy decisions, and circuit transitions
- pause or close authority
- inspect audit evidence

## Phase 1B — Production settlement

**Gate:** begins only after Phase 0A selects the authority, funding, and custody model.

### Authoritative payment lifecycle

```text
created → signed → submitted → accepted → pending_batch → finalized
```

With rejected, expired, failed, reversed, disputed, and unknown handling.

Required operational infrastructure:

- webhook signature verification and ingestion
- idempotent reconciliation workers
- settlement aging
- retries with bounded backoff
- operator-visible discrepancy queue
- compensating journal entries rather than historical rewrites
- customer statements and exports

### Arc lifecycle

- Explicit contract-version registry
- Immutable versus upgradeable decision
- Published source and reproducible builds
- Administrative-key and multisig policy
- Pause and emergency behavior
- Mandate migration strategy
- Mainnet deployment process
- Optional versus mandatory organization-level anchoring

## Phase 2 — Customer-ready control plane

**Outcome:** an outside team can integrate without Fuse engineers operating the workflow for them.

- Versioned policy builder
- Per-call, session, hourly, daily, and monthly ceilings
- Absolute and relative cost acceleration
- Token-volume, request-rate, and repeated-failure anomalies
- Provider-failover and tool-specific limits
- Approval thresholds
- Auto-close versus pause-and-review
- Policy replay against historical runs
- Dry-run deployment
- Alerts and approval workflows
- Run and receipt explorer
- Budget and settlement reporting
- TypeScript and Python SDKs
- Signed webhooks
- Credential vault
- Usage and payment exports
- Team roles and full audit history

## Phase 3 — Agent treasury platform

**Outcome:** Fuse governs spending beyond inference and remains useful if payment rails commoditize native budget primitives.

- Multiple providers and paid tools
- Provider routing
- Delegated wallets
- Policy templates
- Cross-provider and cross-rail budgets
- Service discovery
- Production Arc deployment
- Enterprise controls and compliance posture

If Circle ships native cap/charge/refund primitives, Fuse adopts them as an enforcement backend rather than competing with them.

What remains above the rail:

- hierarchical agent authority
- policy and anomaly decisions
- cross-provider and cross-rail control
- usage-to-payment reconciliation
- application-layer enforcement
- operational evidence
- operator workflows

Positioning:

> Circle provides programmable-money primitives. Fuse turns them into an agent treasury and spending-policy system.

## Product modes

### Control mode

The customer pays providers directly. Fuse supplies identity, policy, metering, containment, routing, and audit evidence. Fuse does not control customer funds.

### Settlement mode

Fuse additionally orchestrates wallet authority, HTTP 402 payment, Gateway reconciliation, USDC accounting, and Arc commitments under the authority model selected in Phase 0A.

This separation provides a lower-risk initial product and preserves value independently of any single payment rail.

## Operational readiness

Production releases require:

- trace IDs across request, provider call, payment, receipt, and anchor
- metrics for held responses, stale reservations, payment aging, and reconciliation lag
- defined service-level objectives
- alerts on ledger invariant failures
- redacted structured logs
- backup and restore tests
- recovery-point and recovery-time targets
- deployment rollback process
- provider and payment-rail health isolation
- dead-letter queues and operator runbooks

## Parked commercial hypotheses

### Initial customer profile

Teams operating production multi-agent workloads with meaningful variable cost exposure: agent platforms, coding-agent infrastructure, support automation, enterprise AI platforms, and funded on-chain agents. Hobbyists and single-agent consumer use are not the initial focus.

### Pricing hypothesis

A platform subscription for organizations, policy management, retention, alerts, and audit; a usage component tied to controlled requests or active agent identities; and an optional managed-settlement fee as a secondary line rather than the core model.

## Sequencing

1. Preserve and submit the hackathon proof.
2. Run Phase 0A authority/custody work and Phase 0B custody-agnostic engineering in parallel.
3. Ship Phase 1A control mode before assuming Fuse must control customer funds.
4. Begin Phase 1B settlement only after authority, custody, legal, and economic-risk decisions are explicit.
5. Begin Phase 2 only when the Phase 1 foundations are operational rather than merely modeled.
6. Revisit Phase 3 defensibility continuously as Circle and provider capabilities evolve.
