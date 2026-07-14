# Fuse

**Programmable money controls for autonomous AI.**

Fuse is a financial control plane for metered AI inference: a parent agent delegates scoped allowances to logical child agents, Fuse reserves worst-case request cost, reconciles real provider token usage, and isolates a runaway branch without stopping the rest.

## Verified locally

- Hierarchical root/child budget accounting in integer micro-USDC
- Atomic-in-process reservation semantics and idempotency conflicts
- Exact token pricing and worst-case reservation pricing
- Deterministic `HEALTHY → ELEVATED → TRIPPED` circuit behavior
- Held-response flow that produces an exact x402 quote and releases only after payment acceptance
- Executable three-child isolation demo

```bash
npm install
npm run check
npm run demo
```

## Circle Phase 0 status

The official integration packages are installed and their current TypeScript declarations compile in this repository:

- `@circle-fin/x402-batching`
- `@x402/core`
- `@x402/evm`
- `@circle-fin/developer-controlled-wallets`
- `viem`

Fuse now includes a tested adapter from Circle Developer-Controlled Wallet `client.signTypedData(...)` to the signer interface required by `BatchEvmScheme`. The adapter enforces the `GatewayWalletBatched` EIP-712 domain and serializes bigint payment fields safely.

The live Circle flow is deliberately not mocked. It uses:

- `CIRCLE_API_KEY`
- `CIRCLE_ENTITY_SECRET`
- A live Arc Testnet Developer-Controlled EOA
- Arc Testnet USDC

Phase 0 proves, against current Circle documentation and SDKs:

1. Use a Developer-Controlled Wallet on Arc Testnet.
2. Deposit USDC into Circle Gateway.
3. Produce the exact EIP-3009 authorization required by Gateway Nanopayments.
4. Complete an x402 paid retry.
5. Verify payer balance movement and Gateway settlement evidence.

**Phase 0 is complete.** Final seller balance credit remains asynchronous because Gateway batches settlement; its settlement reference is recorded below.

### Live Phase 0 evidence

- Circle API authentication succeeded.
- Ten live Arc Testnet Developer-Controlled EOA wallets were discovered.
- A funded Arc Testnet EOA was selected and its wallet balance was verified.
- ERC-20 approval completed on Arc Testnet: `0x7e42dab5bf341e328546bbfee0507d2e8c75bc5068da97c59af0e9fff47c994a`.
- Gateway deposit completed on Arc Testnet: `0x06a89c672cddac713ad3de55a5727b53fbc36aa797cfa5b2b2bbe79f382616b2`.
- Gateway balance was verified at `0.001` USDC after deposit.
- A real protected endpoint returned HTTP `402 Payment Required`.
- The parent Developer-Controlled EOA signed the real `GatewayWalletBatched` EIP-712 payload through Circle `signTypedData`.
- Circle Gateway accepted and settled the paid retry; the endpoint returned HTTP `200`.
- Gateway settlement reference: `d6ceaae5-6a63-42f6-9630-78af396d18fa` on `eip155:5042002`.
- Buyer Gateway available balance decreased from `0.001` to `0.000999` USDC.
- Seller credit was not yet visible during the first minute of balance polling, consistent with the payment remaining in Gateway's batch-settlement lifecycle; do not claim final seller credit until observed.

## Architecture boundary

Children are logical Fuse identities. The parent Circle wallet is the payer and owns the shared Gateway balance. Fuse checks each child capability and root mandate before requesting a parent-wallet signature. The Arc mandate contract anchors the session maximum and one final receipt-bundle hash; per-completion metering, circuit enforcement, and Nanopayment authorization remain off-chain.

## Phase 1 API spine

The OpenAI-compatible `POST /v1/chat/completions` route is implemented and tested end-to-end with an injected provider and payment guard:

1. Requires `Idempotency-Key` and `X-Fuse-Child` headers.
2. Reserves worst-case token cost against child and root budgets.
3. Calls the provider only once and holds the response.
4. Computes an exact micro-USDC quote from provider-reported usage.
5. Dynamically invokes Circle Gateway x402 middleware for that exact price.
6. Reuses the cached inference on the paid retry.
7. Reconciles the reservation and returns an OpenAI-compatible response with a Fuse receipt.

The runtime supports two explicitly selected provider adapters through `FUSE_PROVIDER`:

- `anthropic` (default) targets Anthropic's official Messages API with `ANTHROPIC_API_KEY`, the Anthropic wire format, and provider-reported `input_tokens` / `output_tokens`.
- `openrouter` targets OpenRouter's OpenAI-compatible `/api/v1/chat/completions` endpoint with `OPENROUTER_API_KEY`, an organization-prefixed `OPENROUTER_MODEL`, and provider-reported `prompt_tokens` / `completion_tokens`.

Both adapters feed the same internal `InferenceProvider` contract. OpenRouter-mediated Claude traffic must be described as Claude inference through OpenRouter, not as direct official Anthropic API traffic. The gateway-facing route remains OpenAI-compatible so calling agents do not need to speak either upstream wire format.

When PostgreSQL-backed controlled inference is configured, `/v1/chat/completions` requires an authenticated agent credential, `inference:invoke`, a tenant-scoped mandate, and an idempotency key. Admission and maximum-cost reservation commit before the provider call. A denial records decision evidence with a zero reservation and does not call the provider or payment guard. In `dry_run`, hard authorization failures still deny; policy-limit violations are recorded as `wouldOutcome: DENY` but the real provider request proceeds, so it is reserved and reconciled like any other billable execution. Completed requests replay from stored output; changed payloads under the same key are rejected.

Fuse does not claim exactly-once upstream execution across the provider-success/database-commit crash boundary. An `executing` request is never automatically dispatched again: retries receive `REQUEST_IN_PROGRESS` during a five-minute lease, then move the execution and non-terminal mandate into reconciliation hold for operator review. This is an at-most-once retry posture, not proof that the upstream provider cannot bill a request whose local completion commit was lost.

### Historical metered inference evidence

The committed July 12 evidence below was produced before the official-Anthropic migration, using the previous AgentRouter backend. It remains valid evidence of Fuse's metering, Circle payment, circuit, persistence, and Arc commitment behavior, but it is not presented as official Anthropic traffic:

- The provider returned real usage: 27 input tokens and 15 output tokens.
- Fuse calculated an exact charge of `0.000306` USDC using the configured demo price schedule.
- The first Fuse response was HTTP `402`.
- The Circle Developer-Controlled parent EOA signed the exact EIP-3009 authorization.
- Circle Gateway accepted settlement reference `8b9f04db-4d52-44d4-b12e-d932c8315bfb` on `eip155:5042002`.
- The paid retry returned HTTP `200` with `FUSE LIVE PAID OK`.
- The receipt identifies the real parent payer, logical child `scout`, exact token usage, exact charge, and Gateway settlement reference.

Direct Anthropic defaults to a `3.00` input / `15.00` output USDC-per-million reservation tariff for `claude-sonnet-4-6`. OpenRouter Claude Sonnet 4.6 defaults to a conservative `3.30` / `16.50` reservation ceiling based on the reviewed endpoint set; provider-reported cost remains authoritative for reconciliation, and missing, mismatched-model, or over-reservation results enter reconciliation hold.

```bash
npm run dev
```

## Public demo

- Control desk: [fuse-agent-control-plane.vercel.app/desk](https://fuse-agent-control-plane.vercel.app/desk)
- State API (current mutable record): [fuse-agent-control-plane.vercel.app/api/state](https://fuse-agent-control-plane.vercel.app/api/state)
- Direct persisted record (`demo-mandate`): [fuse-agent-control-plane.vercel.app/api/runs/demo-mandate](https://fuse-agent-control-plane.vercel.app/api/runs/demo-mandate)
- Source and evidence: [github.com/ShalyX/fuse-agent-control-plane](https://github.com/ShalyX/fuse-agent-control-plane)

The public deployment is backed by Neon Postgres. The off-chain state record ID is `demo-mandate`; this is separate from the Arc contract's hashed mandate ID `0xa12a9146913454b8e14e132a1ee07df1a114cbc01e80e2c1a0bc8bfd58e88c6c`. Ledger state, reservations, circuits, held provider responses, idempotency results, and released receipts survive serverless cold starts. `/api/state` and `/api/runs/demo-mandate` send explicit `no-store` CDN and browser cache headers. The direct run endpoint returns the current database-backed state, its persisted receipts, and the Arc anchor boundary in one response.

The committed durability probe predates the official-Anthropic migration: process A performed one real provider inference and returned HTTP `402`; it was stopped; process B loaded the held response from Neon, accepted Circle authorization `75aa0a58-2fc7-412b-b5bf-44a366e94ce8`, and returned HTTP `200` without repeating inference. Evidence: [`evidence/cold-start-paid-retry-2026-07-12.json`](evidence/cold-start-paid-retry-2026-07-12.json).

## Golden combined run

The live combined run now exercises the full system in one process:

1. Three real legacy-provider calls from Scout with provider-reported token usage.
2. One real Circle Gateway Nanopayment per completed call.
3. Genuine cost acceleration from growing prompt context: `$0.000180 → $0.001050 → $0.005874`.
4. `HEALTHY → ELEVATED → TRIPPED` after two consecutive increases above 4×.
5. Automatic reclaim of Scout's remaining `$0.052896` allowance to the parent pool.
6. A subsequent Scout request blocked with HTTP `409 BRANCH_TRIPPED` before inference.
7. A real Reviewer inference and `$0.000198` payment succeeding while Scout remains tripped.

The persistent run settled `$0.007302` total and increased parent reserve from `$0.020000` to `$0.072896`. Its complete receipt set is committed at [`evidence/persistent-golden-run-2026-07-12.json`](evidence/persistent-golden-run-2026-07-12.json).

## Arc mandate anchor

`FuseSpendMandate` is deployed on Arc Testnet at [`0xf736609aa15b255322df4d5dfe6ea66b59b7c663`](https://testnet.arcscan.app/address/0xf736609aa15b255322df4d5dfe6ea66b59b7c663).

The contract deliberately exposes only a two-transaction lifecycle:

1. `openMandate(mandateId, maximumSpendAtomic, controller)` once per session.
2. `closeMandate(mandateId, totalPaidAtomic, receiptHash)` once per session.

There is no per-completion `recordSettlement` method. The persistent golden run was anchored with a `250000` atomic cap, `7302` atomic final spend, and canonical receipt hash `0x91391b64514c0b4ec350b864dc1f8ad34b51d69180746e818c8420a75f70325c`.

- [Open transaction](https://testnet.arcscan.app/tx/0xe92bb389d8b05c6121274c2bc7e1edf4a2ecd150afd18dc339eec8aa2aecab9b)
- [Close transaction](https://testnet.arcscan.app/tx/0x03a9f53dc180865a7168cf44f6f0ed2da03fe246aa7f68ddb286abe6cd27d772)
- [Machine-readable on-chain evidence](evidence/arc-mandate-2026-07-12.json)

Run it with:

```bash
npm run dev
node --env-file=.env --import tsx scripts/golden-run.ts
```

## Control desk

`GET /desk` serves the browser-tested control plane for the hackathon demo. It includes:

- Root and child budget tree for Scout, Builder, and Reviewer.
- A clearly labeled deterministic isolation replay that does not incur provider or payment charges.
- `HEALTHY → ELEVATED → TRIPPED` Scout progression.
- Reviewer continuation after Scout isolation.
- The committed legacy-provider/Circle settlement reference as historical payment evidence.
- Responsive layout and reduced-motion handling.

`GET /api/state` exposes the current persisted ledger and circuit state without serializing bigint values directly.

## Submission assets

- [Production roadmap](docs/production-roadmap.md)
- [Pitch deck source](docs/pitch-deck.md)
- [Three-minute demo script](docs/demo-script.md)
- [Encode / Arc submission copy](docs/submission.md)
- [System architecture diagram](docs/fuse-architecture.svg)

## Persistence

Set `DATABASE_URL` to enable the transactional Postgres store. Each mutation locks the mandate row with `SELECT ... FOR UPDATE`, preserving root/child reservation invariants across concurrent serverless workers. Without `DATABASE_URL`, Fuse intentionally falls back to an in-memory store for local development and tests.

## Production foundation

The hackathon state record remains intact for reproducible public evidence while the custody-agnostic production core is built beside it. The first production slice adds:

- An append-only, per-asset balanced financial journal using atomic integer amounts.
- Immutable actor and causation metadata for every journal entry.
- Independent request, payment, and mandate lifecycle state machines.
- Explicit `accepted`, `pending_batch`, and `finalized` payment states.
- Postgres-backed append-only store APIs for audit events and journal entries; database-role or trigger enforcement is still pending.
- Duplicate-ID protection and transactional journal/posting persistence.

These modules do not provision wallets or assume who controls a signer. Real-money wallet and settlement work remains gated by the authority/custody decision in the [production roadmap](docs/production-roadmap.md).

### Identity and control-mode boundary

The second custody-agnostic slice adds:

- Normalized organizations and agent identities.
- Transactional audit events for organization creation, agent registration, credential issuance, and revocation.
- One-time, high-entropy `fuse_sk_…` credentials; only the SHA-256 hash and a display prefix are persisted.
- Explicit capabilities for inference, mandate reads/writes, and receipt reads.
- Credential expiry, revocation, active-agent checks, and constant-time credential-digest comparison.
- A fail-closed capability middleware with stable `401`, `403`, and sanitized `503` responses.
- `GET /api/v1/identity`, protected by `mandates:read`, while the public hackathon evidence routes remain unchanged.

There is deliberately no public user-provisioning endpoint yet. Organization users are modeled for the future operator console, while administrative API access is bootstrapped through a service account.

### Administrative bootstrap and credential rotation

Run the bootstrap command once against a new organization:

```bash
DATABASE_URL='<postgres-url>' \
FUSE_BOOTSTRAP_ORG_ID='<organization-id>' \
FUSE_BOOTSTRAP_ORG_NAME='<organization-name>' \
FUSE_BOOTSTRAP_SERVICE_ACCOUNT_ID='<service-account-id>' \
FUSE_BOOTSTRAP_SERVICE_ACCOUNT_NAME='<service-account-name>' \
npm run identity:bootstrap
```

The command atomically creates the organization, administrative service account, credential, and their audit events, then prints the high-entropy bearer token exactly once. Only the digest is stored. The bootstrap credential expires after 24 hours by default; set `FUSE_BOOTSTRAP_EXPIRES_AT` to an explicit ISO timestamp when a different short bootstrap window is required. Re-running with the same identifiers fails rather than silently minting another administrative credential.

A service account with the required capability can then call:

- `POST /api/v1/admin/agent-credentials` with `credentials:issue`.
- `POST /api/v1/admin/agent-credentials/:credentialId/revoke` with `credentials:revoke`.
- `POST /api/v1/admin/service-account-credentials` with `credentials:issue` to mint a replacement administrative credential.
- `POST /api/v1/admin/service-account-credentials/:credentialId/revoke` with `credentials:revoke` to invalidate the prior credential after rotation.

Administrative routes require an `admin` service-account role in addition to the route capability. Operators and viewers are limited to role-compatible runtime/read capabilities at credential issuance and authentication. All endpoints derive the organization from the authenticated service account, require `X-Request-Id` for audit causation, return no-store responses, and never accept an organization identifier from the request body.

### Versioned policy control plane

The next custody-agnostic slice adds a tenant-scoped policy substrate beside the unchanged public hackathon flow:

- Append-only policy-version APIs with deterministic `ALLOW`/`DENY` results and stable reason codes.
- `dry_run`, `enforce`, and `paused` policy modes.
- Provider, model, capability, per-call, hourly, daily, rate, and token controls.
- Control mandates that must be created in `draft` and explicitly activated through the mandate lifecycle.
- Tenant-scoped agent assignments and immutable decision records with unique request identifiers.
- Transactional audit events for policy publication, mandate creation, assignment, state transitions, and policy-version changes.
- Mandate-row locking during evaluation and state/policy mutations.
- Policy changes only while a mandate is `draft` or `paused`; switching modes requires publishing a new version and binding it before reactivation.

Administrative policy routes are:

- `POST /api/v1/admin/policies` with `policies:write`.
- `GET /api/v1/admin/policies/:policyId/versions/:version` with `policies:read`.
- `POST /api/v1/admin/mandates` with `mandates:admin`; mandates always start in `draft`.
- `POST /api/v1/admin/mandates/:mandateId/agents` with `mandates:admin`.
- `POST /api/v1/admin/mandates/:mandateId/transitions` with `mandates:admin`.
- `POST /api/v1/admin/mandates/:mandateId/policy` with `mandates:admin`.
- `GET /api/v1/admin/mandates/:mandateId/decisions` with `policies:read`.
- `GET /api/v1/admin/reconciliation` with `policies:read`.
- `POST /api/v1/admin/reconciliation/:requestId/resolve` with `mandates:admin`, an explicit resolution, operator note, external evidence reference, and request ID.

`policies:write` and `mandates:admin` are admin-only service-account capabilities. `policies:read` is available to admin, operator, and viewer service accounts. Policy versions and decisions are append-only through the application API; database-role or trigger enforcement against direct `UPDATE`/`DELETE` remains pending.

With `DATABASE_URL` configured, authenticated `/v1/chat/completions` requests use policy admission, transactional reservation, provider invocation, and usage reconciliation. OpenRouter cannot start without that controlled path. The no-database direct-Anthropic route remains a legacy compatibility mode and is not part of the policy-control evidence.

The repository also contains an independently deployable signer boundary and operator tools:

- `npm run ops:check` reports health and open reconciliation holds without printing credentials.
- `npm run ops:reconcile -- ... --yes resolve` resolves one reviewed hold and requires an evidence note plus external reference; it never redispatches inference.
- `vercel.signer.json` is the separate signer build configuration; it does not select a Vercel project by itself. Signer deployment must run through an isolated Vercel link whose inspected project name is exactly `fuse-shaly-signer`, never through the control-plane repository link. The service binds one organization, wallet, Gateway contract, recipient, chain, validity window, exact EIP-712 type shape, per-authorization ceiling, and cumulative authority ceiling before invoking Circle signing. A dedicated PostgreSQL authorization ledger payload-binds idempotency keys, replays completed signatures, serializes concurrent requests, and retains ambiguous Circle outcomes for review without automatic redispatch.
- `npm run mainnet:readiness` is read-only. It requires the Base Gateway available balance to equal the deliberately small configured cap and verifies the authenticated Shaly signer boundary reports the exact payer wallet, Base chain ID, Gateway contract, recipient, LIVE/BASE/DEVELOPER wallet classification, zero ambiguous authorizations, and the same authority ceiling.

Signer startup verifies through Circle that the configured signer is the exact-address, `LIVE`, developer-controlled `BASE` wallet. Test API credentials and testnet wallets fail closed and cannot back Base mainnet signing. The control-plane runtime rejects Circle and signer-database secrets at startup. A remote-signer adapter is present for the eventual outbound payment workflow, but no public control-plane route invokes signing yet; payment orchestration remains disabled until mandate/accounting integration and a separate release review are complete.

These controls reduce authority exposure but do not settle the legal/custody model. The signer service is not part of the public control-plane deployment, and a Base mainnet payment remains gated on explicit operator approval immediately before transaction submission.
