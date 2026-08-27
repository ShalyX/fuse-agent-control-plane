# Fuse Real Product Production Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn Fuse from a tested operator-oriented control plane and public demonstration into a self-serve product that a new customer can discover, create an organization, connect a provider and payment source, protect an agent, run a first inference, and understand the resulting spend without operator intervention.

**Architecture:** Keep the existing financial control plane as the source of truth for mandates, reservations, policy decisions, receipts, circuits, reconciliation, and audit events. Add a customer-facing product layer around it with tenant onboarding, browser sessions, setup state, provider connections, payment funding, agent registration, mandate creation, and an end-to-end first-run flow. Separate public product APIs from admin APIs and keep signing, payment authorization, and custody behind an explicit production gate.

**Tech Stack:** Existing TypeScript, Express, PostgreSQL/Neon, Vercel-compatible runtime, React-free server-rendered console surfaces where practical, existing `packages/fuse-client`, Circle Developer-Controlled Wallets, Circle Gateway, Anthropic/OpenRouter adapters, Vitest, Supertest, and the existing migration/readiness/operations scripts.

---

## Product truth and release boundary

Fuse is currently strong as an API-first control plane and inspectable demo. It is not yet a self-serve product. This plan must not turn the demo into a fake onboarding path or claim production custody before the authority model is resolved.

The production target is:

> A developer or small team can create a workspace, connect a provider, create an agent, assign a spending policy, fund or authorize the payment path, send an inference request through Fuse, and inspect the exact decision, charge, payment status, and receipt from one product surface.

The first production release must support one clearly bounded custody mode. Do not ship a vague “wallet connected” abstraction that hides who controls the funds or who signs payments.

### Explicit non-goals for the first production release

- General consumer banking
- Arbitrary wallet custody or withdrawal products
- Multi-chain payments beyond one documented network
- Automatic mainnet signing without explicit authority, limits, and incident controls
- Marketplace, team billing, or reseller features
- Unbounded model/provider routing
- Customer-facing reliability research claims
- Exactly-once upstream provider execution claims
- Hiding reconciliation holds from customers

---

## Current baseline to preserve

The implementation starts from the frozen staged candidate identified by:

- TREE `dd75e8cb0ccd40d954952b69f14db27a6794c2d1`
- DIFF_SHA256 `6f1f90f23ecdf49de1b564ab0952545514aa8f314976f40459da634981b94b90`

Before implementation begins, create a branch from this candidate and verify:

```bash
git status --short
git diff --cached --check
npm run check
npm run product:smoke
```

Do not alter the public evidence routes or historical evidence semantics while adding the customer product layer.

---

# Phase 0: Product contract and architecture freeze

## Task 0.1: Define the first customer persona and happy path

**Objective:** Reduce the product to one falsifiable first-run workflow.

**Files:**
- Create: `docs/product/customer-journey.md`
- Modify: `README.md`
- Modify: `docs/final-submission-pack.md` only where current limitations or product claims become stale

**Decisions to record:**

- Primary customer is a developer or small team running autonomous agents.
- The first supported inference provider mode is tenant-scoped Anthropic or OpenRouter, not both as an unbounded choice unless both are operationally tested.
- The first supported payment mode names the payer, signer, chain, Gateway contract, asset, and funding mechanism explicitly.
- The first success event is a real or clearly labeled testnet inference that produces a durable Fuse receipt.
- Every screen and API response distinguishes configured, authorized, funded, pending, finalized, failed, and blocked states.

**Acceptance:** A new engineer can explain the exact customer flow in under two minutes without referring to the hackathon desk.

## Task 0.2: Define the state machine for onboarding

**Objective:** Make setup state explicit rather than inferred from missing records.

**Files:**
- Create: `docs/product/onboarding-state-machine.md`
- Create: `src/product/onboardingState.ts`
- Test: `tests/onboardingState.test.ts`

**States:**

- `created`
- `identity_ready`
- `provider_pending`
- `provider_verified`
- `payment_pending`
- `payment_ready`
- `agent_pending`
- `mandate_pending`
- `ready_to_run`
- `first_run_completed`
- `blocked`

Every transition must include actor, organization, request ID, timestamp, and reason. Invalid transitions fail closed.

**Verification:** Unit tests cover legal transitions, duplicate transitions, stale transitions, and transitions after organization suspension.

---

# Phase 1: Tenant onboarding and browser sessions

## Task 1.1: Add customer account and workspace identity model

**Objective:** Let a customer create and own a workspace without using the bootstrap script.

**Files:**
- Create: `src/identity/customerAccounts.ts`
- Create: `src/persistence/customerAccountStore.ts`
- Create: `migrations/<next>_customer_accounts.sql`
- Test: `tests/customerAccounts.test.ts`

**Data requirements:**

- Customer account ID
- Verified email or external identity subject
- Organization ID
- Membership role
- Status and suspension reason
- Created/updated timestamps
- Last authentication timestamp
- Audit actor and causation metadata

Do not store passwords unless a complete password security system is intentionally selected. Prefer a managed identity provider or a narrowly scoped email magic-link/session implementation.

## Task 1.2: Add browser session authentication

**Objective:** Replace paste-a-service-credential as the primary product login path.

**Files:**
- Create: `src/http/customerAuth.ts`
- Create: `src/identity/sessionStore.ts`
- Create: `migrations/<next>_customer_sessions.sql`
- Modify: `src/http/app.ts`
- Test: `tests/customerAuth.test.ts`
- Test: `tests/http.test.ts`

**Requirements:**

- Secure, httpOnly, same-site session cookie
- Server-side session record with rotation and expiry
- CSRF protection for browser mutations
- Explicit logout and revocation
- Session-to-organization binding
- No provider secrets, bearer credentials, or private keys in browser storage
- Session creation and revocation audit events
- Rate limits on login, magic-link request, callback, and passwordless verification if used

**Acceptance:** A browser user can refresh, sign out, sign back in, and cannot access another organization by changing IDs in a URL or request body.

## Task 1.3: Build first-run workspace shell

**Objective:** Provide a truthful setup flow instead of sending customers directly to an operator console.

**Files:**
- Create or modify: `src/http/console.ts`
- Create: `src/http/customerConsole.ts`
- Create: `src/product/onboardingReadModel.ts`
- Test: `tests/customerConsole.test.ts`
- Test: `tests/onboardingReadModel.test.ts`

**Screens:**

- Workspace overview
- Setup checklist
- Provider connection
- Payment setup
- Agent creation
- Spending policy and mandate creation
- Test inference
- Receipts and activity

Every incomplete step must show why it is blocked and the next legal action. No fake metrics, fake balances, or disabled controls that look active.

---

# Phase 2: Provider connection as a real customer flow

## Task 2.1: Add tenant provider connection lifecycle

**Objective:** Let a customer connect and verify one provider without exposing secrets after submission.

**Files:**
- Modify: `src/product/providerConnections.ts`
- Modify: `src/persistence/providerConfigStore.ts`
- Create: `src/product/providerConnectionService.ts`
- Modify: `src/http/app.ts`
- Test: `tests/providerConnectionService.test.ts`
- Test: `tests/http.test.ts`

**States:**

- `not_configured`
- `submitted`
- `verifying`
- `verified`
- `invalid`
- `revoked`
- `rotation_required`

**Requirements:**

- Provider key submitted once over TLS
- AES-256-GCM encryption with active key ID and authenticated organization/provider context
- No plaintext key in logs, responses, browser storage, or audit payloads
- Verification request uses a bounded harmless provider call or provider-specific validation endpoint
- Provider model and tariff are explicit
- Rotation preserves the previous key until no longer needed for decrypting existing records
- Revoke immediately blocks new inference
- Failed verification does not create a usable configuration

## Task 2.2: Add provider readiness and failure UX

**Objective:** Make provider problems diagnosable by the customer without leaking secrets.

**Files:**
- Modify: `src/product/readiness.ts`
- Modify: `src/http/console.ts`
- Test: `tests/productReadiness.test.ts`

Expose safe states such as invalid key, model mismatch, provider unavailable, quota exceeded, and configuration migration required. Do not expose raw upstream bodies or credentials.

## Task 2.3: Run tenant-provider migration and rollback rehearsal

**Objective:** Prove that the production provider schema can be deployed and rolled back safely.

**Files:**
- Modify: `scripts/migrate-provider-config.ts` only if required
- Create: `docs/runbooks/provider-config-migration.md`
- Create: `scripts/verify-provider-config-rollback.ts`
- Test: existing provider Neon/concurrency suites

**Verification:** Run against an isolated Neon branch, verify migration, rotate a key, simulate rollback, and confirm old key IDs remain decryptable until rewrite completes.

---

# Phase 3: Agent creation, credentials, and SDK usability

## Task 3.1: Add customer-facing agent registration

**Objective:** Let a workspace create an agent without admin API knowledge.

**Files:**
- Modify: `src/identity/agentIdentity.ts`
- Modify: `src/http/app.ts`
- Create: `src/product/agentSetupService.ts`
- Test: `tests/agentSetupService.test.ts`
- Test: `tests/http.test.ts`

**Requirements:**

- Human-readable name and stable machine ID
- Organization binding from session, never request body
- Agent status lifecycle
- Audit event
- Duplicate name and ID handling
- Suspend and revoke actions

## Task 3.2: Add scoped credential issuance UI and API

**Objective:** Let the customer issue a credential for an agent with the minimum capability set.

**Files:**
- Modify: `src/identity/apiCredentials.ts`
- Modify: `src/http/app.ts`
- Modify: `src/http/console.ts`
- Test: `tests/apiCredentials.test.ts`

**Requirements:**

- Credential shown exactly once
- Hash and display prefix only persisted
- Capability presets for inference-only, receipts-read, and operator-read
- Expiry required or strongly defaulted
- Rotation and revocation visible in the UI
- Copy-to-clipboard only after explicit reveal
- Never display credentials in logs, analytics, error payloads, or URL query strings

## Task 3.3: Make the SDK genuinely installable

**Objective:** Give developers a documented, tested path from API key to first response.

**Files:**
- Modify: `packages/fuse-client/src/client.ts`
- Modify: `packages/fuse-client/src/types.ts`
- Create: `packages/fuse-client/README.md`
- Create: `examples/quickstart.ts`
- Create: `examples/quickstart.js`
- Test: `tests/fuseClientPackage.test.ts`

**Requirements:**

- Correct Authorization header behavior
- Clear typed errors for 401, 403, 402, 409, 429, and 503
- Idempotency and mandate headers generated from typed input
- Retry guidance that never retries `REQUEST_IN_PROGRESS` or ambiguous payment outcomes automatically
- Node and browser support explicitly separated if browser use is not safe
- Versioned package publishing process

**Verification:** A clean temporary project installs the package, calls readiness, runs sandbox, and reaches a controlled inference response using documented environment variables.

---

# Phase 4: Spending policy and mandate setup

## Task 4.1: Add customer policy presets

**Objective:** Make the financial controls understandable without requiring policy schema knowledge.

**Files:**
- Create: `src/product/policyPresets.ts`
- Modify: `src/http/app.ts`
- Modify: `src/http/console.ts`
- Test: `tests/policyPresets.test.ts`

**Initial presets:**

- Development sandbox
- Conservative production agent
- High-throughput bounded agent

Each preset must expose model allowlist, per-call cap, hourly cap, daily cap, token limits, request rate, and behavior on violation. Advanced JSON editing can exist later, but the preset must be canonical and round-trippable.

## Task 4.2: Build mandate creation and activation flow

**Objective:** Let a customer bind an agent to a policy and activate it safely.

**Files:**
- Modify: `src/product/mandateManagement.ts`
- Modify: `src/http/app.ts`
- Modify: `src/http/console.ts`
- Test: `tests/mandateManagement.test.ts`
- Test: `tests/http.test.ts`

**Flow:**

1. Choose agent
2. Choose policy preset
3. Set lifetime and daily limits
4. Review exact authority and payment mode
5. Create draft mandate
6. Verify provider and payment readiness
7. Explicitly activate
8. Display immutable mandate ID and current state

Activation must not be possible when provider, payment, custody, or required migrations are not ready.

## Task 4.3: Add customer-facing decision and hold explanations

**Objective:** Turn opaque policy outcomes into actionable product feedback.

**Files:**
- Create: `src/product/decisionExplanation.ts`
- Modify: `src/product/executionReadModel.ts`
- Modify: `src/http/console.ts`
- Test: `tests/decisionExplanation.test.ts`

Map reason codes to safe explanations and next actions. Preserve the raw stable reason code for API consumers.

---

# Phase 5: Payment and custody production gate

This phase cannot be compressed into a generic “connect wallet” feature. The team must choose and document one authority model.

## Task 5.1: Choose the first supported payment authority model

**Objective:** Resolve who controls funds and who authorizes each payment.

**Decision record:** `docs/product/payment-authority-decision.md`

Evaluate:

- Customer-controlled wallet with explicit customer signature
- Fuse-controlled developer wallet with customer deposit and strict withdrawal boundaries
- Pre-funded Circle Gateway balance controlled by an operator or service account
- Testnet-only launch with no mainnet custody claim

The decision must specify payer, signer, asset, chain, Gateway account, deposit path, withdrawal path, limits, failure handling, and legal/custody assumptions.

**Release gate:** No production payment activation until this document is approved and the implementation matches it.

## Task 5.2: Add payment setup state and funding visibility

**Objective:** Let a customer understand whether inference can be paid.

**Files:**
- Create: `src/product/paymentSetupService.ts`
- Modify: `src/product/paymentEvidence.ts`
- Create: `src/persistence/paymentAccountStore.ts`
- Create: `migrations/<next>_payment_accounts.sql`
- Modify: `src/http/app.ts`
- Test: `tests/paymentSetupService.test.ts`
- Test: `tests/paymentEvidence.test.ts`

Expose safe read models for:

- Payment mode
- Network and asset
- Payer identity, redacted as appropriate
- Available balance or “balance unavailable” state
- Minimum required balance
- Pending batch amount
- Finalized amount
- Last verification time
- Funding instructions
- Block reason

Never imply finalized settlement when Circle only reports pending batch.

## Task 5.3: Implement payment authorization behind a kill switch

**Objective:** Make the payment path operational without making it irreversible or globally available.

**Files:**
- Modify: signer service boundary and remote signer adapter
- Modify: `src/http/app.ts`
- Create: `src/product/paymentAuthorizationGate.ts`
- Create: `docs/runbooks/payment-activation.md`
- Test: `tests/paymentAuthorizationGate.test.ts`

**Controls:**

- Organization allowlist
- Environment and chain allowlist
- Per-authorization ceiling
- Cumulative authority ceiling
- Mandate and request binding
- Idempotency ledger
- Explicit operator approval immediately before submission where required
- Ambiguous Circle outcome enters review, never automatic redispatch
- Global kill switch and per-tenant kill switch
- No control-plane secret access to signer private material

## Task 5.4: Prove payment failure semantics

**Objective:** Ensure no customer is charged or told a request succeeded incorrectly.

**Test scenarios:**

- Insufficient Gateway balance
- Invalid authorization
- Expired authorization
- Duplicate authorization
- Gateway timeout after submission
- Circle response lost after submission
- Provider succeeded but payment failed
- Payment succeeded but local receipt commit failed
- Database unavailable
- Customer cancels during authorization

Every scenario must produce a documented state, customer message, operator action, and reconciliation path.

---

# Phase 6: First successful inference experience

## Task 6.1: Add an interactive first-run test

**Objective:** Let a customer prove setup works with one bounded request.

**Files:**
- Create: `src/product/firstRunService.ts`
- Modify: `src/http/console.ts`
- Modify: `src/product/inference.ts`
- Test: `tests/firstRunService.test.ts`
- Test: `tests/http.test.ts`

**Requirements:**

- Fixed safe model or customer-selected allowed model
- Strict max tokens
- Explicit estimated maximum cost before execution
- Confirmation when the request can incur payment
- Idempotency key generated and displayed
- Live progress states
- 402 held-payment state explained
- Successful response links directly to decision, payment evidence, and receipt
- Failure state includes whether provider work may have occurred

## Task 6.2: Add customer receipt and spend surfaces

**Objective:** Make the product useful after the first inference, not just during setup.

**Files:**
- Modify: `src/product/receiptReadModel.ts`
- Modify: `src/product/executionReadModel.ts`
- Create: `src/product/spendSummaryReadModel.ts`
- Modify: `src/http/console.ts`
- Test: `tests/spendSummaryReadModel.test.ts`

Show:

- Spend by agent
- Spend by model
- Spend by time range
- Reserved, actual, pending, finalized, reconciled, and held amounts separately
- Circuit state and reason
- Requests in reconciliation hold
- Receipt and external payment references
- Exportable JSON or CSV only when data exists

Do not use one “balance” number to combine authority, spend, pending settlement, and available funds.

## Task 6.3: Add safe retry guidance

**Objective:** Prevent customers from causing duplicate provider calls or payments.

**Files:**
- Modify: `packages/fuse-client/src/errors.ts`
- Modify: `packages/fuse-client/src/client.ts`
- Create: `docs/product/retry-semantics.md`
- Test: `tests/retrySemantics.test.ts`

Document and enforce:

- Safe replay of a completed request with the same idempotency key
- Rejection of changed payloads under the same key
- No automatic retry for `REQUEST_IN_PROGRESS`
- No automatic retry for ambiguous payment outcomes
- Operator reconciliation for held executions

---

# Phase 7: Security, abuse, and operational readiness

## Task 7.1: Threat model the self-serve surface

**Objective:** Review the new customer surface as an attack boundary, not only as an API feature.

**Files:**
- Modify: `docs/product/threat-model.md`
- Create: `docs/product/self-serve-security-review.md`

Review:

- Account takeover
- Session fixation and CSRF
- Organization ID enumeration
- Credential leakage
- Provider key exfiltration
- Prompt and model abuse
- Spending abuse
- Rate-limit bypass across serverless instances
- Replay and idempotency abuse
- Webhook spoofing
- Payment authorization confusion
- Reconciliation poisoning
- Cross-tenant read and write access

## Task 7.2: Add global abuse controls

**Objective:** Close the documented gap where warm-instance limits do not provide global serverless abuse control.

**Files:**
- Create: `src/abuse/globalRateLimiter.ts`
- Create: `migrations/<next>_global_rate_limits.sql` or select a managed durable limiter
- Modify: `src/http/app.ts`
- Test: `tests/globalRateLimiter.test.ts`

Use a durable, atomic limiter for login, setup mutations, inference admission, payment attempts, and credential issuance. Keep local in-memory limiting as defense in depth, not as the only control.

## Task 7.3: Add structured audit and customer-visible activity

**Objective:** Make every financial or authority-changing action explainable.

**Files:**
- Modify: existing audit stores and schemas
- Create: `src/product/activityReadModel.ts`
- Test: `tests/activityReadModel.test.ts`

Every event needs organization, actor, action, resource, request ID, causation ID, outcome, and safe metadata. Customer activity must exclude secrets while retaining enough evidence for support and reconciliation.

## Task 7.4: Prepare support and incident runbooks

**Objective:** Make failures operable by a real team.

**Files:**
- Create: `docs/runbooks/customer-access.md`
- Create: `docs/runbooks/provider-failure.md`
- Create: `docs/runbooks/payment-failure.md`
- Create: `docs/runbooks/reconciliation-hold.md`
- Create: `docs/runbooks/suspicious-spend.md`
- Create: `docs/runbooks/data-restore.md`

Each runbook must include detection, customer impact, containment, evidence collection, safe remediation, rollback, and communication.

---

# Phase 8: Production deployment and release gates

## Task 8.1: Separate environments and secrets

**Objective:** Prevent testnet, staging, and production authority from mixing.

**Files:**
- Create: `docs/runbooks/environment-matrix.md`
- Modify: deployment configuration and CI workflows
- Modify: `.env.example` if present

Define separate values for:

- Database
- Provider keys
- Encryption keys
- Circle account and wallet
- Chain and Gateway contract
- Webhook signing keys
- Session secrets
- Feature flags
- Rate limits
- Sentry or observability destination

CI must reject production builds containing test credentials, testnet chain IDs, or missing active key IDs.

## Task 8.2: Add migration, restore, and rollback gates

**Objective:** Prove persistence changes are reversible and recoverable.

**Files:**
- Create: `docs/runbooks/release-checklist.md`
- Modify: CI workflows
- Modify: `scripts/smoke-production.ts`

Required gates:

- Isolated migration run
- Neon restore rehearsal
- Schema version check
- Health and readiness
- Authenticated identity check
- Public evidence check
- Provider verification check
- Payment setup check
- Inference dry run
- Reconciliation visibility check
- Rollback to the last branch-aware deployment

## Task 8.3: Add observability and SLOs

**Objective:** Know when customer setup or money movement is failing.

**Files:**
- Create: `docs/product/slo.md`
- Modify: runtime logging and metrics
- Create: `tests/observability.test.ts` where practical

Track without secrets:

- Signup completion rate
- Time from workspace creation to ready
- Provider verification success rate
- First inference success rate
- 402 to paid completion rate
- Payment pending age
- Reconciliation hold count and age
- Circuit trip count
- Credential issuance/revocation rate
- Cross-tenant authorization failures
- 429 and 503 rates
- Provider latency and error classes

Define alert thresholds and on-call owners before production launch.

---

# Phase 9: Documentation, packaging, and launch

## Task 9.1: Rewrite the README around customer value

**Objective:** Make the repository explain how a real customer uses Fuse, not only how a judge views the demo.

**Files:**
- Modify: `README.md`
- Create: `docs/product/quickstart.md`
- Create: `docs/product/api-reference.md`
- Create: `docs/product/limits-and-pricing.md`
- Create: `docs/product/security.md`
- Create: `docs/product/faq.md`

The first page must answer:

- Who is Fuse for
- What happens on the first day
- What it costs
- Who controls the funds
- Which providers and chains are supported
- What happens when a request fails
- How to delete or revoke access
- What is not production-ready

## Task 9.2: Publish a real quickstart

**Objective:** Prove a clean user can go from zero to first receipt.

**Files:**
- Create: `docs/product/quickstart.md`
- Modify: `examples/quickstart.ts`
- Create: `scripts/verify-quickstart.ts`

The quickstart must work in a fresh environment and include exact output shapes, expected errors, cleanup, and cost boundaries. It must not depend on the public hackathon demo record.

## Task 9.3: Package and version the SDK

**Objective:** Make integration maintainable for external developers.

**Files:**
- Modify: `packages/fuse-client/package.json`
- Modify: `packages/fuse-client/README.md`
- Create: `packages/fuse-client/CHANGELOG.md`
- Modify: CI publishing workflow

Require API compatibility tests, generated type checks, documented support matrix, and a release process that does not publish unpublished production claims.

## Task 9.4: Run a closed beta before public launch

**Objective:** Validate the product with real users while limiting financial and operational blast radius.

**Beta shape:**

- 3 to 5 teams
- One provider mode
- One chain/payment mode
- Testnet or tightly capped production authority
- Manual support channel
- Explicit usage caps
- Daily reconciliation review
- No automatic expansion of limits

**Exit criteria:** At least three external teams complete setup, first inference, receipt inspection, credential rotation, and recovery from one induced failure without engineering intervention.

---

# Verification strategy

Every code task follows TDD.

1. Write the failing unit or integration test.
2. Run the focused test and confirm failure for the intended reason.
3. Implement the smallest change.
4. Run the focused test.
5. Run adjacent suites.
6. Run the full suite and build before merging.

### Required test layers

- Unit tests for state machines and validators
- HTTP authorization and tenant-isolation tests
- PostgreSQL integration tests with two independent connections
- Provider adapter contract tests
- Payment authorization and ambiguous-outcome tests
- Browser/session tests
- SDK clean-install tests
- Migration and rollback tests
- Production smoke tests
- Security review with explicit no-secret assertions
- External closed-beta acceptance tests

### Release commands

At minimum, every release candidate must pass:

```bash
npm run check
npm run product:smoke
npm run smoke:production
npm run ops:check
```

Then run the environment-specific migration, restore, payment, and first-run probes from the release checklist. A green local suite is not sufficient evidence for hosted payment or production deployment.

---

# Milestones and release gates

## Milestone A

Customer can create a workspace, sign in, and see truthful setup state.

Gate

- Session and tenant isolation tests pass
- No service credential paste required for normal browser use
- Account recovery and logout verified

## Milestone B

Customer can connect a provider and create an agent with a scoped credential.

Gate

- Provider secret handling reviewed
- Rotation and revocation verified
- Fresh workspace can reach provider verified state

## Milestone C

Customer can create and activate a bounded mandate.

Gate

- Policy and mandate explanation reviewed by a non-author
- Activation blocked when dependencies are missing
- Decision evidence visible

## Milestone D

Customer can fund or authorize the documented payment mode and run a first inference.

Gate

- Payment authority decision approved
- Kill switches tested
- Ambiguous payment outcomes enter reconciliation
- No false success or false finalization claims

## Milestone E

Customer can understand ongoing spend and operate safely.

Gate

- Spend, receipts, pending payments, and holds visible
- Credential rotation and incident runbooks tested
- Global abuse controls active

## Milestone F

Closed beta is successful.

Gate

- Three external teams complete the full journey
- No cross-tenant incident
- No unresolved Critical or High payment/security issue
- Support can resolve common failures using runbooks

## Public production launch

Only after all milestones pass.

The public launch message should be:

> Fuse gives agent teams bounded, inspectable spending controls around inference. Connect a supported provider, define a mandate, authorize the documented payment path, and receive durable evidence for every completed request.

Do not launch with the current demo framing as if it were customer onboarding. Keep `/desk` as the evidence and demonstration surface, but make the customer product the primary path.

---

# Open decisions that must be resolved before implementation reaches payment activation

1. Who is legally and operationally responsible for customer funds?
2. Is the first real product testnet-only or capped mainnet?
3. Which identity provider or passwordless authentication method is used?
4. Is Fuse customer-controlled, operator-controlled, or hybrid for signing?
5. Which provider is the first supported production provider?
6. What is the billing model for Fuse itself?
7. Which customer data retention and deletion guarantees are offered?
8. What support response time is promised during the beta?
9. What happens to pending Gateway batches when a workspace is suspended?
10. Which jurisdictions and customer types are excluded from the initial launch?

Do not implement around these questions silently. Each answer changes the API, custody, security, and operating model.

---

# Definition of real product done

Fuse is a real product when a new external customer can complete this sequence without repository knowledge or an engineer manually editing the database:

1. Open the product.
2. Create or authenticate a workspace.
3. Understand the setup checklist.
4. Connect and verify a supported provider.
5. Create an agent.
6. Issue a scoped agent credential.
7. Choose a policy and create a draft mandate.
8. Review the exact authority and payment behavior.
9. Activate the mandate only after prerequisites are satisfied.
10. Run a bounded first inference.
11. See the provider result, policy decision, reserved amount, actual amount, payment state, and receipt.
12. Retry safely using the documented idempotency behavior.
13. Revoke the credential or pause the mandate.
14. Return later and recover the same workspace state.
15. Understand every blocked, pending, failed, or reconciled outcome.

Until that sequence works in a closed beta with real external users, Fuse should be described as a production-oriented control-plane foundation and live demo, not as a generally usable product.
