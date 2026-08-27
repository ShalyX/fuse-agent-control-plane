# Fuse Full Production Project Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn Fuse from a production-oriented agent-spending control-plane foundation and partially implemented product layer into a self-serve, externally usable, operationally bounded product with a verified customer golden path.

**Architecture:** Preserve the existing financial control plane as the source of truth for admission, reservation, provider execution, payment holding, reconciliation, circuit decisions, receipts, and audit evidence. Complete the product layer around it rather than creating a second policy or payment engine. Start with a clearly documented control mode or tightly gated testnet settlement mode; do not expose ambiguous custody or payment authority.

**Tech Stack:** TypeScript, Express 5, PostgreSQL/Neon, Vite/server-rendered console surfaces, Vitest, Supertest, TypeScript SDK, Anthropic/OpenRouter adapters, Circle Developer-Controlled Wallets, Circle Gateway/x402, viem, Zod, Vercel-compatible deployment, and the existing Fuse ledger/circuit/reliability runtime.

---

## 1. Current state and evidence

Repository: `/root/fuse-v3-amendment`

Current branch: `main`

Current working tree: staged and modified files plus untracked product-plan/customer-onboarding files. This is not yet a frozen release candidate.

Observed verification:

- `npm run product:smoke` passes.
- TypeScript build passes.
- 621 tests pass.
- 1 test fails in `tests/http.test.ts` because the authenticated console copy changed while the test still expects the previous wording.
- 18 integration tests are skipped, including Postgres/reliability integration suites.
- `npm audit --audit-level=high` could not complete because the configured npm mirror returned `404 NOT_IMPLEMENTED` for the audit endpoint. Dependency risk remains unverified.
- Product implementation already exists for workspace onboarding, readiness, provider connections, agents, credentials, policies, mandates, product inference, receipts, sandbox runs, product client, and package export smoke.
- The customer-facing path is not yet proven end to end from a clean browser session through durable hosted receipt readback.
- Payment/custody authority is not yet frozen as a production product decision.

### Current maturity statement

Fuse is currently a serious production-oriented control-plane foundation with a partially implemented self-serve product layer. It is not yet a generally usable production product and must not claim unrestricted production customer payments, custody, or settlement.

### Progress ledger

Update this section after every implementation slice. Do not mark an item `verified` from code inspection alone. A verified item needs the named test, smoke, deployment, or external evidence to have actually passed.

Status values:

- `pending` — not started or not yet assessed
- `active` — currently being implemented
- `blocked` — requires a decision, credential, external system, or user approval
- `verified` — acceptance evidence exists
- `deferred` — intentionally outside the current release scope

| ID | Workstream | Status | Evidence / next action |
|---|---|---|---|
| A | Candidate integrity and failing console test | verified | Updated `tests/http.test.ts`; focused console test passed; `npm run check` passed: 89 suites, 622 tests; `npm run product:smoke` passed |
| B | Product contract and customer journey | verified | Added `docs/product/customer-journey.md`, `docs/product/onboarding-state-machine.md`, and the tested/exported `src/product/onboardingState.ts`; focused tests: 7 passed; full `npm run check`: 90 suites, 627 tests passed, 18 skipped; build passed |
| C | Human authentication and workspace tenancy | verified for invite-only alpha locally | HTTP session issuance, typed source-credential revocation, individual logout/revocation, expiry, opaque tokens, workspace binding, and durable Postgres storage are covered; broader-beta cookie/magic-link identity, CSRF, and hosted session proof remain outside this alpha boundary |
| D | Provider connection and canonical provider path | verified for invite-only alpha | Hosted OpenRouter provider verification and bounded paid inference evidence exist; remaining: clean hosted restart/readback proof against the frozen candidate |
| E | Agent identity, scoped credentials, and SDK | partial | Product identity and credential lifecycle are live-tested, including recovery/replacement and revoked-credential rejection across three beta workspaces; remaining: clean-install/package-consumption proof |
| F | Policy, mandates, branches, and explanations | partial | Policy/mandate validation and bounded live inference receipts are verified; remaining: complete activation-prerequisite and explanation route matrix |
| G | Durable sandbox and evidence readback | partial | Authenticated workspace-scoped sandbox readback and three hosted receipt readbacks are verified; remaining: hosted restart/redeploy persistence proof |
| H | Authenticated customer console and browser smoke | partial | Console contract/browser smoke is locally verified; remaining: clean browser session plus hosted session-restore/readiness proof |
| I | Payment authority and custody decision | verified locally for invite-only control mode | `docs/product/payment-authority-decision.md` approves control mode; runtime hard-selects control mode, disables settlement, and rejects control-plane payment/signer configuration; deployed-candidate alignment still requires hosted verification |
| J | Hosted first-run inference and durable receipt | partial | Three beta workspaces have completed paid inference records and protected receipt readback; remaining: freeze/review the exact deployed candidate and prove restart persistence |
| K | Abuse controls, audit, runbooks, and observability | partial | Postgres-backed limiting is wired for onboarding, authenticated product, and admin routes; operational audit coverage includes invite/onboarding/rate-limit decisions and session lifecycle audit exists; remaining: executable telemetry, alert ownership, runbook drills, and an authorized `ops:check` |
| L | Migration, restore, rollback, and deployment gates | partial | Frozen clean-clone/package proof passes; hosted `/health` and three-tenant receipt readback pass; hosted `/ready` is 503 `DEPENDENCY_UNAVAILABLE`, and restart/redeploy proof is intentionally not run without a deployment action |
| M | Independent review and frozen release candidate | active | Exact candidate review returned BLOCK on typed source-credential revocation, individual session revocation, and concurrent invite replay; all three now have local TDD fixes. `npm run check` passes 99 suites/675 tests with 22 environment-gated skips and build passes. The reviewed freeze is invalidated by these fixes; next action is a new exact freeze and independent re-review |
| N | Closed beta with external teams | verified for current three-tenant evidence | Daemon, Aegis, and Vanta receipt readback pass with 510 total actual atomic cost; public launch remains deferred |
| O | Public production launch | deferred | Only after Milestones A–E pass |

### Fallback and resumption protocol

When work is interrupted, a new agent/session should:

1. Read this plan and the progress ledger first.
2. Inspect `git status --short --branch` and the latest commit.
3. Run the narrowest verification command for the first non-verified workstream.
4. Preserve unrelated staged, unstaged, and untracked changes.
5. Resume from the first unresolved dependency, not from the last conversational promise.
6. Update the ledger only with evidence from real tool output.
7. Record blockers explicitly rather than silently skipping them.

The immediate fallback order is:

1. Candidate integrity and the failing console test.
2. Product contract and payment/custody decision.
3. Human authentication and workspace tenancy.
4. Provider verification.
5. Agent/SDK path.
6. Policy/mandate activation.
7. Sandbox and browser proof.
8. Hosted first-run inference.
9. Operations and release gates.
10. Closed beta.

### Definition of full-blown project status

Fuse is full-blown when a new external customer can, without repository knowledge or manual database edits:

1. Open Fuse.
2. Create or authenticate a workspace.
3. Understand truthful setup readiness.
4. Connect and verify one supported provider.
5. Create an agent.
6. Issue a scoped credential.
7. Create and activate a bounded policy/mandate.
8. Run a bounded first inference.
9. Inspect decision, reserved cost, actual cost, payment state, circuit state, and receipt.
10. Retry safely with idempotency semantics.
11. Pause a branch or revoke access.
12. Return later and recover the same workspace state.
13. Understand blocked, pending, failed, held, and reconciled outcomes.
14. Complete the flow in a closed beta with external users.

---

## 2. Non-negotiable product decisions

These decisions must be recorded before payment activation or public production claims.

### 2.1 Supported launch mode

Choose one and document it in `docs/product/payment-authority-decision.md`:

- Control mode: customer pays the provider directly; Fuse enforces policy, budgets, metering, containment, and evidence.
- Testnet settlement mode: one explicitly bounded Arc/Base testnet path with operator approval and no mainnet custody claim.
- Managed settlement mode: only after authority, custody, legal, signer, withdrawal, incident, and reconciliation controls are approved.

Recommended first external release: control mode or invite-only testnet mode. Do not launch with a vague “connect wallet” abstraction.

### 2.2 First supported provider

Select one provider for the first customer path. Anthropic and OpenRouter can both remain implemented, but the first release must have one canonical, hosted-verified path. Provider choice, model, tariff, timeout, retry, and credential lifecycle must be explicit.

### 2.3 Human authentication model

Select one initial path:

- Invite-only workspace token/session for private alpha.
- Magic-link or managed identity provider for broader beta.

Do not make raw service-credential paste the primary customer login path.

### 2.4 Product boundary

Keep the public hackathon/evidence desk separate from the authenticated customer product. The desk can remain read-only and evidence-forward. It must not be mistaken for the self-serve customer console.

---

## 3. Release milestones

### Milestone A — Candidate integrity

Exit criteria:

- Known console test failure fixed with a regression test.
- No source corruption or literal redaction artifacts.
- Working tree scope classified.
- `npm run check` passes.
- `npm run product:smoke` passes.
- Dependency audit runs successfully against an authoritative registry or documented approved scanner.
- Candidate tree and binary diff digest recorded.

### Milestone B — Self-serve alpha

Exit criteria:

- A human can create/authenticate a workspace.
- Tenant isolation is tested.
- Provider configuration is secret-safe and verifiable.
- Agent and scoped credential lifecycle works.
- Policy/mandate creation and activation work.
- Deterministic sandbox proves branch-local containment.
- Customer console shows truthful readiness and evidence.
- SDK clean-install quickstart works without internal imports.

### Milestone C — Hosted first-run proof

Exit criteria:

- Clean browser session reaches the product.
- Workspace state persists across reload/restart.
- One bounded inference executes through the canonical hosted route.
- Provider result and Fuse receipt are durably readable afterward.
- Payment status is truthful: configured, pending, finalized, failed, blocked, or held.
- Ambiguous outcomes enter reconciliation instead of retrying automatically.
- Browser console has no fatal errors.

### Milestone D — Invite-only beta

Exit criteria:

- Three to five external teams complete the golden path.
- At least three teams can recover after an induced failure.
- Credential rotation/revocation works.
- No cross-tenant incident.
- No unresolved Critical or High payment/security issue.
- Support can operate documented runbooks without engineering database edits.

### Milestone E — Public launch candidate

Exit criteria:

- Authority/custody decision approved.
- Environment separation and secret management are verified.
- Global abuse controls are active.
- Migration, restore, rollback, and deployment gates pass.
- Observability and alert ownership exist.
- Legal/product boundary copy is accurate.
- Exact release commit, deployment, docs, and evidence are aligned.

---

## 4. Implementation plan

## Phase 0 — Freeze, repair, and baseline the candidate

### Task 0.1: Reproduce and repair the failing console assertion

**Objective:** Restore the full test gate after the console copy change.

**Files:**

- Modify: `tests/http.test.ts`
- Inspect: `src/http/console.ts`
- Test: `tests/http.test.ts`

**Steps:**

1. Read the failing assertion and current rendered console copy.
2. Decide whether the new wording or the old wording matches the product contract.
3. Write/update the regression assertion to test behavior and truthful copy, not an accidental implementation string.
4. Run the focused test and confirm it passes.
5. Run the complete suite.

**Verification:**

```bash
npx vitest run tests/http.test.ts
npm run check
```

### Task 0.2: Audit source for transport redaction corruption

**Objective:** Ensure the generated console and TypeScript sources contain valid code and no literal redaction sentinels.

**Files:**

- Inspect: `src/http/console.ts`
- Inspect: `src/http/app.ts`
- Inspect: `src/runtime.ts`
- Inspect: all staged and untracked source files

**Steps:**

1. Search source and generated output for `***`, truncated secret references, malformed object literals, and unexpected placeholder strings.
2. Use byte-level inspection for any sensitive-looking lines rather than round-tripping full files through displayed output.
3. Run TypeScript build and focused route tests.
4. Preserve valid secret-env references and do not print credential values.

**Verification:**

```bash
npm run build
git diff --check
```

### Task 0.3: Freeze the candidate scope

**Objective:** Establish exactly what belongs to the release candidate.

**Files:**

- No production files by default.
- Candidate metadata may be saved under `.hermes/`.

**Steps:**

1. Inspect `git status --short`.
2. Classify staged, unstaged, and untracked files as release, unrelated, or deferred.
3. Stage only the intended candidate once implementation is complete.
4. Record tree identity and binary diff digest.
5. Do not dispatch independent review until the candidate is frozen.

**Verification:**

```bash
git status --short
git write-tree
git diff --cached --binary | sha256sum
```

---

## Phase 1 — Product contract, state model, and threat model

### Task 1.1: Freeze customer vocabulary

**Objective:** Make the same object names and lifecycle states appear in docs, API, SDK, and console.

**Files:**

- Modify: `docs/product/product-contract.md`
- Create: `docs/product/customer-journey.md`
- Create: `docs/product/onboarding-state-machine.md`
- Modify: `README.md` only where current claims are stale

**Required objects:** Workspace, environment, provider connection, agent, credential, root mandate, branch, execution, receipt, circuit event, reconciliation case.

**Required states:** configured, verifying, verified, blocked, pending, finalized, failed, held, revoked, paused, tripped, disabled.

**Verification:** A new engineer can explain the first-run path in under two minutes without opening the hackathon desk implementation.

### Task 1.2: Freeze the authority and custody threat model

**Objective:** Make the financial trust boundary explicit before payment activation.

**Files:**

- Modify: `docs/product/threat-model.md`
- Create: `docs/product/payment-authority-decision.md`
- Create: `docs/product/control-mode-boundary.md`

**Required analysis:**

- Customer, Fuse, provider, signer, Circle, Gateway, chain, and operator roles.
- Who controls funds and who can authorize payment.
- Provider-cost exposure when payment fails.
- Duplicate, replay, timeout, pending-batch, and unknown settlement behavior.
- Kill switch, withdrawal, refund, and reconciliation authority.
- Testnet versus mainnet boundaries.

**Verification:** Payment activation is blocked unless the documented model matches the runtime implementation.

---

## Phase 2 — Human workspace authentication and tenancy

### Task 2.1: Implement durable workspace membership

**Objective:** Bind every customer action to a workspace derived from the authenticated principal.

**Files:**

- Modify: `src/persistence/schemaBootstrap.ts`
- Modify: `src/product/workspaceOnboardingStore.ts`
- Create or modify: `src/identity/workspaceAuthorization.ts`
- Tests: `tests/workspaceOnboardingStore.test.ts`, `tests/auth.test.ts`

**Acceptance:**

- Workspace IDs are never trusted from arbitrary request bodies.
- Cross-workspace reads and mutations fail with the same safe error shape.
- Suspended workspaces cannot mutate policy, credentials, provider, or payment state.

### Task 2.2: Add browser session authentication

**Objective:** Replace credential paste as the normal customer entry path.

**Files:**

- Create: `src/http/customerAuth.ts`
- Create: `src/identity/sessionStore.ts`
- Modify: `src/http/app.ts`
- Modify: `src/http/console.ts`
- Tests: `tests/customerAuth.test.ts`, `tests/http.test.ts`

**Requirements:**

- Secure httpOnly same-site cookie.
- Server-side session record with expiry and rotation.
- Explicit logout and revocation.
- CSRF protection for browser mutations.
- Session-to-workspace binding.
- No provider secrets, bearer tokens, or private keys in browser storage.
- Rate limits on login/session issuance.

**Verification:** Refresh, logout, re-login, cross-tenant access, expired session, revoked session, CSRF, and session fixation tests pass.

### Task 2.3: Add workspace recovery

**Objective:** Let customers return to the same workspace without engineering support.

**Files:**

- Modify: `src/product/customerOnboarding.ts`
- Modify: `src/product/workspaceOnboardingStore.ts`
- Create: `src/product/workspaceRecovery.ts`
- Tests: `tests/customerOnboarding.test.ts`, `tests/workspaceRecovery.test.ts`

**Requirements:**

- Recovery code or managed identity path.
- One-time consumption.
- Hash-only persistence.
- Rotation after recovery.
- Safe not-found behavior.

---

## Phase 3 — Provider connection lifecycle

### Task 3.1: Complete provider metadata and secret boundary

**Objective:** Allow a workspace to configure one provider without returning or logging the secret.

**Files:**

- Modify: `src/product/providerConnections.ts`
- Modify: `src/persistence/providerConfigStore.ts`
- Modify: `src/http/app.ts`
- Tests: `tests/providerConnections.test.ts`, `tests/providerConfigStore.test.ts`

**States:** `not_configured`, `submitted`, `verifying`, `verified`, `invalid`, `revoked`, `rotation_required`.

**Requirements:**

- Encrypt provider credentials with active key ID and organization/provider context.
- Never return plaintext after submission.
- Never store secrets in audit records, logs, URLs, or browser storage.
- Verify with a bounded provider call.
- Persist provider/model/tariff metadata.
- Revoke immediately blocks new inference.

### Task 3.2: Select and verify the first production provider

**Objective:** Make one provider path genuinely hosted-verifiable.

**Files:**

- Modify: provider adapter under `src/providers/`
- Tests: provider contract tests and hosted smoke scripts
- Docs: `docs/product/quickstart.md`

**Requirements:**

- Official endpoint and authentication contract.
- Bounded timeout and retry policy.
- Stable error classes.
- Usage normalization.
- Tariff version attached to every receipt.
- No retry after uncertain dispatch.

**Verification:** Direct credential probe through the real loader, followed by one bounded inference in the target environment. Do not report provider support from unit tests alone.

### Task 3.3: Prove provider migration and rollback

**Objective:** Ensure provider credential schema changes are recoverable.

**Files:**

- Modify: `scripts/migrate-provider-config.ts`
- Create: `scripts/verify-provider-config-rollback.ts`
- Create: `docs/runbooks/provider-config-migration.md`
- Tests: existing Neon/concurrency suites

**Verification:** Isolated Postgres migration, credential rotation, rollback, old-key decryptability, and clean restart.

---

## Phase 4 — Agent identity, credentials, and SDK

### Task 4.1: Complete customer-facing agent registration

**Objective:** Let a workspace create and suspend agents without admin database scripts.

**Files:**

- Modify: `src/product/agentIdentity.ts`
- Modify: `src/http/app.ts`
- Tests: `tests/agentIdentity.test.ts`, `tests/http.test.ts`

**Requirements:**

- Stable machine ID and human name.
- Organization binding from session.
- Duplicate handling.
- Suspend/revoke lifecycle.
- Audit event.

### Task 4.2: Complete scoped credential issuance

**Objective:** Issue minimum-capability agent credentials safely.

**Files:**

- Modify: `src/identity/apiCredentials.ts`
- Modify: `src/http/app.ts`
- Modify: `src/http/console.ts`
- Tests: `tests/apiCredentials.test.ts`, `tests/http.test.ts`

**Requirements:**

- Show token exactly once.
- Store only hash and display prefix.
- Capability presets.
- Expiry required or strongly defaulted.
- Rotation and revocation.
- No token in logs, URLs, analytics, or error payloads.

### Task 4.3: Finish the public SDK contract

**Objective:** Prove an external developer can use Fuse without importing internals.

**Files:**

- Modify: `packages/fuse-client/src/client.ts`
- Modify: `packages/fuse-client/src/types.ts`
- Modify: `packages/fuse-client/src/errors.ts`
- Modify: `packages/fuse-client/README.md`
- Create: `examples/quickstart.ts`
- Create: `scripts/verify-quickstart.ts`
- Tests: `tests/fuseClientPackage.test.ts`, `tests/fuseClientMiddleware.test.ts`

**Requirements:**

- Readiness, branch, sandbox, inference, receipt, and health methods.
- Stable typed errors for 401/402/403/409/429/503.
- Idempotency and mandate headers.
- No automatic retry for in-progress or ambiguous payment outcomes.
- Node/browser support clearly separated.
- Built package export tested from a clean temporary project.

**Verification:**

```bash
npm run product:smoke
npm pack --dry-run
```

Then install the package into a clean temporary directory and run the sandbox quickstart.

---

## Phase 5 — Policy, mandate, and branch control surface

### Task 5.1: Add customer policy presets

**Objective:** Make spending controls understandable without requiring raw policy JSON.

**Files:**

- Create: `src/product/policyPresets.ts`
- Modify: `src/product/policyPublishing.ts`
- Modify: `src/http/app.ts`
- Modify: `src/http/console.ts`
- Tests: `tests/policyPresets.test.ts`, `tests/policyPublishing.test.ts`

**Initial presets:** development sandbox, conservative agent, high-throughput bounded agent.

Every preset must define model/provider allowlist, per-call cap, hourly/daily cap, token limits, request rate, workload class, and violation behavior.

### Task 5.2: Complete mandate activation

**Objective:** Prevent activation until all required prerequisites are ready.

**Files:**

- Modify: `src/product/mandateManagement.ts`
- Modify: `src/http/app.ts`
- Modify: `src/http/console.ts`
- Tests: `tests/mandateManagement.test.ts`, `tests/http.test.ts`

**Flow:** draft → assign agent → bind branch → verify provider/payment readiness → explicit activate.

**Acceptance:** A child cannot exceed parent authority. A tripped branch cannot resume silently. Activation is denied when provider, payment, custody, migration, or identity prerequisites are unavailable.

### Task 5.3: Add decision explanations

**Objective:** Turn opaque decisions into safe, actionable customer messages.

**Files:**

- Create: `src/product/decisionExplanation.ts`
- Modify: `src/product/executionReadModel.ts`
- Modify: `src/http/console.ts`
- Tests: `tests/decisionExplanation.test.ts`

**Acceptance:** Stable machine reason code remains available, while customer copy explains what happened and the next legal action.

---

## Phase 6 — Deterministic sandbox and evidence

### Task 6.1: Complete durable sandbox run lifecycle

**Objective:** Provide a no-funds proof path using the real ledger/circuit logic.

**Files:**

- Modify: `src/product/sandboxRuns.ts`
- Modify: `src/product/sandboxRunStore.ts`
- Modify: `src/http/app.ts`
- Tests: `tests/sandboxRuns.test.ts`, `tests/sandboxRunStore.test.ts`

**Scenario:** Scout accelerates and trips; unused authority is reclaimed; Reviewer continues and completes.

**Requirements:**

- Deterministic seed.
- Durable run ID.
- Explicit `sandbox` mode.
- No Circle, Gateway, provider, wallet, or chain calls.
- Sandbox receipt cannot look like real settlement.
- Idempotent rerun behavior.

### Task 6.2: Add durable artifact and read-back proof

**Objective:** Make every run inspectable after the request completes.

**Files:**

- Modify: `src/product/receiptReadModel.ts`
- Modify: `src/product/executionReadModel.ts`
- Create or modify: `src/product/activityReadModel.ts`
- Tests: `tests/productReadModels.test.ts`, `tests/productReceipts.test.ts`

**Required evidence:** request ID, idempotency hash, branch, workload class, requested/reserved/reported/settled cost, circuit decision, provider/model metadata, payment state, reconciliation state, and external references where present.

**Verification:** Create → read API → read public/customer page → assert run-specific markers render. Do not infer settlement from a signature.

---

## Phase 7 — Authenticated customer console

### Task 7.1: Complete onboarding shell

**Objective:** Give customers a truthful path from workspace creation to first sandbox.

**Files:**

- Modify: `src/http/console.ts`
- Create or modify: `src/product/onboardingReadModel.ts`
- Tests: `tests/customerConsole.test.ts`, `tests/onboardingReadModel.test.ts`

**Screens:** workspace, setup checklist, provider, payment, agents, policy, mandate, first run, receipts/activity.

Every incomplete state must show the exact missing prerequisite and next action.

### Task 7.2: Build the control surface around branch containment

**Objective:** Make Fuse’s unique value visible without fake dashboard telemetry.

**Files:**

- Modify: `src/http/console.ts`
- Create: `src/product/consoleQueries.ts`
- Tests: `tests/consoleQueries.test.ts`

**Must show:** branch state, allowance, reserved/settled/reclaimed amounts, acceleration signal, last execution, receipt, payment state, and evidence links.

### Task 7.3: Add browser-level golden-path smoke

**Objective:** Prove the UI behavior, not only the HTTP responses.

**Files:**

- Create: `scripts/smoke-product-browser.ts` or repository-standard browser test
- Modify: CI workflow
- Tests: browser smoke suite

**Scenarios:**

- Workspace creation.
- Session restore.
- Provider setup.
- Agent creation.
- Policy/mandate setup.
- Sandbox execution.
- Receipt inspection.
- Loading/success/error states.
- Mobile viewport.
- No fatal page errors.
- No secrets in storage or rendered output.

---

## Phase 8 — Payment and settlement boundary

### Task 8.1: Implement truthful payment readiness

**Objective:** Distinguish configuration from actual payment readiness.

**Files:**

- Modify: `src/product/paymentEvidence.ts`
- Create: `src/product/paymentSetupService.ts`
- Create: `src/persistence/paymentAccountStore.ts` if durable state is required
- Modify: `src/http/app.ts`
- Tests: `tests/paymentEvidence.test.ts`, `tests/paymentSetupService.test.ts`

**Read model:** payment mode, network, asset, payer identity, available balance, pending amount, finalized amount, last verification time, funding instructions, and block reason.

**Rule:** Gateway `pending_batch` is never represented as finalized settlement.

### Task 8.2: Add payment authorization kill switches

**Objective:** Ensure payment writes are bounded, revocable, and auditable.

**Files:**

- Create: `src/product/paymentAuthorizationGate.ts`
- Modify: signer boundary and payment guard
- Modify: `src/http/app.ts`
- Tests: `tests/paymentAuthorizationGate.test.ts`
- Docs: `docs/runbooks/payment-activation.md`

**Controls:** organization allowlist, chain/environment allowlist, per-request and cumulative ceilings, mandate/request binding, idempotency ledger, operator approval where required, global kill switch, tenant kill switch, and fail-closed unknown outcomes.

### Task 8.3: Prove payment failure semantics

**Objective:** Prevent false success, double charge, and unsafe redispatch.

**Required tests:** insufficient balance, invalid/expired authorization, duplicate authorization, timeout after submission, lost response, provider success/payment failure, payment success/receipt failure, database outage, cancellation, and reconciliation recovery.

**Acceptance:** Every scenario has a durable state, safe customer message, operator action, and recovery path.

### Task 8.4: Run one authorized hosted paid flow

**Objective:** Prove the strongest supported payment claim with real evidence.

**Prerequisites:** approved authority decision, live credentials, funded testnet or explicitly authorized environment, operator approval, and no unresolved security blocker.

**Evidence required:** provider response, payment response, transaction/facilitator reference, durable Fuse receipt, exact deployment revision, and readback after restart/redeploy.

Do not substitute a 402 challenge, configured environment variables, local mocks, or a typed-data signature for paid E2E proof.

---

## Phase 9 — Abuse controls, audit, and operations

**Current closure note (local candidate):** the runtime has a Postgres-backed limiter for onboarding and authenticated product routes when a database is configured, but the administrative limiter remains process-local. Durable `audit_events` storage exists across identity, policy, provider, and production-foundation paths, but session, onboarding, limiter, and payment coverage is incomplete. `docs/product/slo.md` and `docs/runbooks/phase-9-operations.md` are drafts that need executable metrics, alert wiring, and drill evidence. Phase 9 is not closed.

### Task 9.1: Add durable global rate limiting

**Objective:** Close the gap between warm-instance limits and multi-instance abuse control.

**Files:**

- Create: `src/abuse/globalRateLimiter.ts`
- Modify: `src/http/app.ts`
- Create migration or configure managed durable limiter
- Tests: `tests/globalRateLimiter.test.ts`

**Dimensions:** workspace, human principal, agent principal, IP/client identity where trusted, and endpoint class.

**Acceptance:** Anonymous traffic cannot exhaust authenticated workspace allowance. Forwarded headers are ignored unless trusted-proxy mode is explicitly configured.

### Task 9.2: Complete audit events

**Objective:** Make authority and money-related actions explainable.

**Files:**

- Create: `src/product/auditEvents.ts`
- Modify: persistence schema/bootstrap
- Create: `src/product/activityReadModel.ts`
- Tests: `tests/auditEvents.test.ts`, `tests/activityReadModel.test.ts`

**Events:** provider changes, policy publication, mandate/branch changes, credential issuance/revocation, sandbox runs, payment configuration, payment attempts, holds, reconciliation, pause, trip, reclaim, and operator actions.

### Task 9.3: Write runbooks

**Files:**

- Create: `docs/runbooks/customer-access.md`
- Create: `docs/runbooks/provider-failure.md`
- Create: `docs/runbooks/payment-failure.md`
- Create: `docs/runbooks/reconciliation-hold.md`
- Create: `docs/runbooks/suspicious-spend.md`
- Create: `docs/runbooks/data-restore.md`
- Create: `docs/runbooks/release-checklist.md`

Each runbook must include detection, impact, containment, evidence collection, safe remediation, rollback, and communication.

### Task 9.4: Add observability and SLOs

**Files:**

- Create: `docs/product/slo.md`
- Modify: runtime structured logging and metrics
- Tests: `tests/observability.test.ts` where practical

Track: signup completion, time to ready, provider verification, first-run success, payment pending age, reconciliation hold count/age, circuit trips, credential lifecycle, cross-tenant denials, 429/503 rates, provider latency, and error classes.

---

## Phase 10 — Deployment, migration, restore, and release

### Task 10.1: Separate environments and secrets

**Objective:** Prevent staging/testnet values from reaching production.

**Files:**

- Create: `docs/runbooks/environment-matrix.md`
- Modify deployment configuration and CI
- Modify `.env.example`

**CI must reject:** test credentials in production builds, testnet chain IDs in production configuration, missing active key IDs, missing session secrets, and mixed Gateway domains.

### Task 10.2: Add clean-clone verification

**Objective:** Prove the project works without cached local state.

**Steps:**

1. Export the frozen candidate or clone it into a temporary directory.
2. Run `npm install` using the committed lockfile.
3. Run `npm run check`.
4. Run `npm run product:smoke`.
5. Run the SDK package smoke from a separate temporary project.
6. Run sandbox without secrets.

### Task 10.3: Add migration and restore gates

**Objective:** Prove production state survives releases and recovery.

**Required gates:** isolated migration, schema version, Neon restore rehearsal, unique record write/readback, restart survival, rollback deployment, receipt integrity, authority-state integrity, and reconciliation-case preservation.

### Task 10.4: Add canonical hosted deployment smoke

**Objective:** Verify the exact production alias and revision rather than a stale preview.

**Checks:**

- `/health`
- `/ready`
- authenticated identity
- workspace readiness
- provider metadata
- sandbox or bounded first-run path
- receipt lookup
- public evidence route
- browser route/deep-link handling
- no fatal console errors

Record deployment ID, revision, request IDs, record IDs, and evidence URLs.

Current evidence: `/health` returned 200 and all three protected beta receipt reads returned completed records. `/ready` returned 503 `DEPENDENCY_UNAVAILABLE`; restart/redeploy proof remains open because this local-only slice does not authorize a deployment action.

---

## Phase 11 — Independent review and controlled release

**Review status:** re-review required. Earlier release blockers for invite enforcement, payment ordering/control-mode alignment, durable administrative limiting, and audit coverage were repaired before the latest exact candidate review. That review returned BLOCK on three remaining findings: cross-type source-credential revocation, missing individual session revocation, and concurrent exact invite replay. All three now have local TDD fixes, and `npm run check` passes 99 suites/675 tests with 22 environment-gated skips plus a successful TypeScript build. These edits invalidate the reviewed freeze. Do not label the candidate invite-only-alpha release-ready or public-production ready until a new exact candidate is frozen and independently re-reviewed. Hosted readiness, restart persistence, executable operations evidence, and broader-beta authentication also remain open.

### Task 11.1: Freeze exact candidate for review

**Objective:** Ensure reviewers inspect the actual release candidate.

**Steps:**

1. Stage the intended release surface.
2. Record `git write-tree` and binary diff digest.
3. Run `git diff --cached --check`.
4. Dispatch focused security, product-composition, and operational reviews.
5. Do not modify the candidate during review.
6. Recompute identity after review.

### Task 11.2: Resolve review findings with TDD

For each Critical/High finding:

1. Write a regression test.
2. Run it and observe the expected failure.
3. Implement the smallest fix.
4. Run focused test.
5. Run full check.
6. Freeze and re-review the new exact candidate.

After two failed independent review cycles, stop broad review loops and request a scope decision.

### Task 11.3: Prepare private alpha

**Scope:** workspace, session, provider, agent, policy, sandbox, receipts, SDK, and authenticated console. No unrestricted real-money self-serve setup.

**Exit criteria:** five clean sandbox runs, tenant isolation, no secret leakage, and one external developer completes the path from the README.

### Task 11.4: Run closed beta

**Scope:** three to five external teams, one provider, one environment/payment mode, hard caps, support channel, daily reconciliation review.

**Exit criteria:** at least three teams complete setup, first run, receipt inspection, credential rotation, and induced-failure recovery without engineering database intervention.

### Task 11.5: Public launch decision

Launch only when:

- Product and payment authority decisions are approved.
- Hosted golden path is proven.
- Security and dependency reviews are clean at policy severity.
- Abuse controls, audit, runbooks, restore, rollback, and observability are operational.
- Docs and UI match actual behavior.
- Claims distinguish local, testnet, hosted, pending, finalized, and production evidence.

---

## 5. Verification command set

Run targeted commands first, then the full gate.

### Local correctness

```bash
npx vitest run tests/http.test.ts
npm run build
npm run product:smoke
npm run check
```

### Product-focused checks

```bash
npx vitest run \
  tests/customerOnboarding.test.ts \
  tests/workspaceOnboardingStore.test.ts \
  tests/setupReadiness.test.ts \
  tests/providerConnections.test.ts \
  tests/agentIdentity.test.ts \
  tests/mandateManagement.test.ts \
  tests/productReadiness.test.ts \
  tests/productInference.test.ts \
  tests/productReceipts.test.ts \
  tests/sandboxRuns.test.ts \
  tests/fuseClientPackage.test.ts \
  tests/fuseClientMiddleware.test.ts
```

### Clean-source checks

```bash
git diff --check
npm install
npm run check
npm run product:smoke
```

### Operations checks

```bash
npm run ops:check
npm run smoke:production
npm run verify:live-product
```

Run these only with the correct target environment and never treat configuration presence as proof of external execution.

### Dependency audit

```bash
npm audit --audit-level=high
```

If the configured registry cannot serve audit requests, switch to an approved authoritative registry or use a documented alternative scanner. Do not report dependency status as clean while the command is blocked.

---

## 6. Risks and guardrails

### Risk: Product surface outruns the control plane

Guardrail: product services must delegate to existing admission, ledger, circuit, reservation, reconciliation, and receipt primitives. No duplicate budget logic in the console.

### Risk: Payment authority remains ambiguous

Guardrail: no unrestricted payment activation until `payment-authority-decision.md` is approved and runtime checks match it.

### Risk: Sandbox evidence is mistaken for real payment

Guardrail: use a separate sandbox namespace and explicit `mode: sandbox`; never issue real-looking settlement references for sandbox runs.

### Risk: Browser UI appears ready while dependencies are missing

Guardrail: readiness must distinguish unavailable, configured, and verified, with explicit next steps.

### Risk: In-memory abuse protection is mistaken for global protection

Guardrail: label it single-instance defense and add durable limiting before public multi-instance launch.

### Risk: Independent review examines stale files

Guardrail: exact tree and binary diff digest on dispatch and verdict; any candidate mutation invalidates the review.

### Risk: Hosted deployment differs from the reviewed candidate

Guardrail: verify canonical alias, deployed revision, environment manifest, and record-specific evidence after deployment.

### Risk: Research reliability machinery blocks product delivery

Guardrail: keep optional held-out/reliability experiments disabled by default and separate from ordinary product readiness. Research evidence cannot substitute for customer workflow proof.

### Risk: Real external demand is assumed from founder testing

Guardrail: treat founder-operated Customer Zero as technical evidence only. Closed beta with external teams is required for usability and demand evidence.

---

## 7. Immediate implementation order

Do not start with more visual polish or additional reliability protocol work. Execute this order:

1. Fix the failing console test.
2. Audit source for corruption and run the full local gate.
3. Freeze the current product contract and payment/custody boundary.
4. Finish human sessions, workspace tenancy, and recovery.
5. Finish provider verification and the first canonical provider path.
6. Finish agent credential lifecycle and clean-install SDK quickstart.
7. Finish policy/mandate activation prerequisites.
8. Finish durable sandbox and browser golden-path smoke.
9. Add payment readiness and kill-switch semantics.
10. Prove one authorized hosted first-run inference and durable receipt readback.
11. Add durable abuse controls, audit events, runbooks, restore/rollback, and observability.
12. Freeze, independently review, clean-clone verify, deploy, and smoke the exact release.
13. Run the closed beta.
14. Decide whether public production launch is justified.

---

## 8. Final completion claim to use only after all gates pass

> Fuse is a self-serve agent-spending control product for bounded, inspectable inference workflows. External customers can create and recover a workspace, connect a supported provider, create scoped agent credentials, define and activate spending authority, run bounded inference, inspect policy and receipt evidence, handle payment and reconciliation states truthfully, and pause or revoke access. The supported payment/custody mode, deployment environment, limits, and unresolved boundaries are documented and verified against the hosted release.

Until then, use:

> Fuse is a production-oriented agent-spending control-plane foundation with a partially implemented self-serve product layer. The sandbox and product APIs are implemented and locally tested; hosted customer workflow, payment authority, operational controls, and external beta validation remain in progress.
