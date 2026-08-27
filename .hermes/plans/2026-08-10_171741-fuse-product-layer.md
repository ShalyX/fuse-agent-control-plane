# Fuse Developer Product Layer Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn Fuse from a demonstrated financial control plane into a usable developer product for agent teams that need branch-local spending limits and runaway-cost containment.

**Architecture:** Keep the existing TypeScript/Express control plane as the financial source of truth. Add a tenant-scoped product API, a small SDK/middleware package, a no-funds sandbox path, and an authenticated console that consumes the same APIs. Keep Circle signing, Gateway payment, provider credentials, database state, and Arc commitments behind explicit boundaries. The product layer must never weaken admission, reservation, reconciliation, idempotency, or signer authorization.

**Tech Stack:** TypeScript, Express 5, PostgreSQL/Neon, Zod, Vitest, Supertest, `@circle-fin/developer-controlled-wallets`, `@circle-fin/x402-batching`, `@x402/core`, `@x402/evm`, viem, React/Vite only if the console is split into a separate frontend app.

---

## Product decision

### Target user

A developer or platform team operating autonomous agents that call paid inference or service APIs.

### Core job

Connect an agent workflow, assign each logical branch a bounded USDC allowance, observe actual usage, and contain a runaway branch without stopping healthy siblings.

### Golden path

`Create workspace → connect provider → create test mandate → add Scout and Reviewer branches → run sandbox → trip Scout → observe Reviewer continue → inspect receipt`

### MVP promise

Fuse makes branch-local financial blast radius visible and enforceable.

### Explicit non-goals for MVP

- Consumer wallet UX
- A marketplace
- Generic DeFi workflows
- Multi-chain support beyond the verified Arc/Base boundary required by the product
- Provider routing across arbitrary models
- Per-agent independent custody wallets
- Finalized Gateway batch claims when Circle does not expose them
- Broad team administration or enterprise SSO
- Replacing the existing control plane with a second payment abstraction

---

## Current context and invariants

The current repository already contains:

- `src/core/service.ts` for admission, reservation, provider execution, payment holding, replay, and reconciliation
- `src/core/ledger.ts`, `src/core/financialLedger.ts`, and `src/core/circuit.ts` for financial accounting and circuit behavior
- `src/persistence/identityStore.ts`, `policyStore.ts`, `providerConfigStore.ts`, and `schemaBootstrap.ts` for durable control state
- `src/identity/apiCredentials.ts` and `src/identity/credentialAdministration.ts` for agent authentication
- `src/circle/paymentGuard.ts` and `src/circle/developerWalletSigner.ts` for Circle payment boundaries
- `src/signer/remoteSigner.ts`, `src/signer/authorizationStore.ts`, and `src/signer/runtime.ts` for isolated signing
- `src/http/app.ts`, `src/http/auth.ts`, `src/http/desk.ts`, and `src/http/console.ts` for the current HTTP/public surfaces
- `tests/http.test.ts`, `tests/inferenceExecution.test.ts`, `tests/policyStore.test.ts`, `tests/identityStore.test.ts`, `tests/circuit.test.ts`, `tests/financialLedger.test.ts`, and existing reliability suites

Preserve these invariants:

1. Admission and maximum-cost reservation commit before provider dispatch.
2. A denial never calls the provider or payment guard.
3. Completed idempotency keys replay the cached output and receipt.
4. Changed payloads under the same idempotency key are rejected.
5. An executing request is never automatically redispatched after a crash boundary.
6. Child authority cannot exceed the root mandate.
7. A tripped branch cannot continue spending, while healthy siblings remain eligible.
8. Control-plane credentials never contain signer secrets.
9. Mainnet payment success requires facilitator settlement evidence, not merely a typed-data signature.
10. Gateway API index lag is recorded as a discrepancy and never causes repeated deposits.

---

## Phase 0: Freeze the product contract before implementation

### Task 0.1: Write the product contract

**Files:**
- Create: `docs/product/product-contract.md`
- Reference: `README.md`, `docs/final-submission-pack.md`

Define the user, golden path, object names, lifecycle states, and MVP non-goals. Use one vocabulary throughout the API, SDK, console, and docs.

Required objects:

- Workspace
- Environment
- Provider connection
- Root mandate
- Agent branch
- Execution
- Receipt
- Circuit event

Required states:

- Workspace: `active`, `suspended`
- Environment: `sandbox`, `testnet`, `mainnet`
- Mandate: existing lifecycle states plus product-facing labels
- Branch: `healthy`, `elevated`, `tripped`, `disabled`
- Execution: existing durable states plus product-facing explanation

**Validation:** Product copy and API names use the same terms. No new object bypasses existing policy or ledger state.

### Task 0.2: Add product-layer threat model

**Files:**
- Create: `docs/product/threat-model.md`
- Reference: `src/identity/*`, `src/signer/*`, `src/circle/*`, `src/http/auth.ts`

Document trust boundaries for workspace users, agent credentials, provider credentials, payer addresses, signer services, Gateway, and Arc. Include abuse cases for cross-tenant reads, branch escalation, replay, duplicate payment, leaked provider credentials, and untrusted webhook/receipt data.

**Validation:** Security review checklist exists before product endpoints are implemented.

---

## Phase 1: Workspace and onboarding primitives

### Task 1.1: Add tenant/workspace persistence

**Files:**
- Modify: `src/persistence/schemaBootstrap.ts`
- Create or modify: `src/persistence/workspaceStore.ts`
- Test: `tests/workspaceStore.test.ts`
- Optional integration test: `tests/workspaceStore.neon.test.ts`

Add durable workspace records with immutable IDs, display name, owner identity, status, and timestamps. Do not store raw API keys or Circle secrets in workspace tables.

**TDD:** Write store tests for create, read, duplicate name handling, suspended workspace rejection, and tenant isolation before implementation.

**Validation:** `npx vitest run tests/workspaceStore.test.ts` passes. Postgres migration/readiness tests cover the new schema.

### Task 1.2: Add workspace-scoped user/session authorization

**Files:**
- Modify: `src/http/auth.ts`
- Create: `src/identity/workspaceAuthorization.ts`
- Modify: `src/identity/apiCredentials.ts`
- Test: `tests/workspaceAuthorization.test.ts`
- Test: `tests/auth.test.ts`

Implement authenticated workspace membership with roles:

- `owner`
- `operator`
- `viewer`

Use existing credential patterns where possible. Keep agent credentials separate from human console sessions. A viewer must not create mandates, rotate credentials, or initiate payment configuration.

**Validation:** Cross-workspace reads and mutations return the same safe authorization error. No endpoint accepts a workspace ID without deriving membership from the authenticated principal.

### Task 1.3: Add setup/readiness endpoint

**Files:**
- Modify: `src/http/app.ts`
- Create: `src/product/setupReadiness.ts`
- Test: `tests/setupReadiness.test.ts`

Expose a workspace-scoped read-only readiness object with:

- Database readiness
- Provider connection state, without revealing credentials
- Signer configuration state
- Wallet chain and custody state
- Gateway environment alignment
- Sandbox availability
- Missing setup steps

**Validation:** The endpoint never prints secrets and distinguishes unavailable, configured, and verified. It must not claim payment readiness from configuration alone.

---

## Phase 2: Product API around the control-plane spine

### Task 2.1: Add workspace-scoped provider connection API

**Files:**
- Modify: `src/providers/providerAdministration.ts`
- Modify: `src/persistence/providerConfigStore.ts`
- Create: `src/product/providerConnections.ts`
- Test: `tests/providerConnections.test.ts`
- Extend: `tests/providerAdministration.test.ts`

Support the first production path only:

- Anthropic official Messages API adapter
- OpenRouter OpenAI-compatible adapter

Store encrypted/indirected credential references only. The console may accept a credential once, but the API must never return it. Provider/model selection must remain authoritative from the tenant configuration and must be checked before dispatch.

**Validation:** Provider mismatch fails before provider invocation. Credential read APIs return metadata, not secret material.

### Task 2.2: Add mandate and branch management API

**Files:**
- Create: `src/product/mandateManagement.ts`
- Modify: `src/policy/policyAdministration.ts`
- Modify: `src/persistence/policyStore.ts`
- Test: `tests/mandateManagement.test.ts`
- Extend: `tests/policyAdministration.test.ts`, `tests/policyStore.test.ts`

Expose safe operations for:

- Create a sandbox or testnet root mandate
- List current mandates
- Create child branches with allowance and workload class
- Pause/disable a branch
- Read branch state and available allowance
- View reclaim and circuit events

Do not expose arbitrary balance mutation. All allowance changes must pass existing root/child accounting and lifecycle rules.

**Validation:** A child cannot over-allocate the root. A tripped branch cannot be re-enabled without an explicit product action and policy check. Viewer role is read-only.

### Task 2.3: Add execution and receipt read models

**Files:**
- Create: `src/product/executionReadModel.ts`
- Create: `src/product/receiptReadModel.ts`
- Test: `tests/productReadModels.test.ts`

Build stable product-facing response shapes over existing evidence and ledger records. Include:

- Request ID and idempotency key hash, not raw secrets
- Branch and workload class
- Requested, reserved, reported, and settled cost
- Provider/model metadata
- Circuit decision and reason
- Payment state and facilitator reference when available
- Arc commitment reference when available
- Gateway `pending_batch` as an explicit non-final state

**Validation:** Read models never infer settlement from a signature. Missing evidence is represented as missing or pending, not success.

### Task 2.4: Add sandbox run API

**Files:**
- Create: `src/product/sandboxRuns.ts`
- Modify: `src/http/app.ts`
- Test: `tests/sandboxRuns.test.ts`

Create a no-funds deterministic sandbox that exercises the real ledger, reservation, circuit, reclaim, and sibling-continuation logic with injected provider usage. It must not call Circle, Anthropic, OpenRouter, or a real wallet.

The sandbox scenario should provide:

- Scout with accelerating usage
- Reviewer with stable usage
- A visible trip event
- Reclaimed allowance
- A sibling completion
- Durable run ID and evidence bundle

**Validation:** One sandbox run is reproducible from a seed or fixed fixture. It cannot mutate production mandates or create payment receipts that look like real settlement.

---

## Phase 3: Developer integration surface

### Task 3.1: Define a stable SDK contract

**Files:**
- Create: `packages/fuse-client/package.json`
- Create: `packages/fuse-client/src/client.ts`
- Create: `packages/fuse-client/src/types.ts`
- Create: `packages/fuse-client/src/errors.ts`
- Create: `packages/fuse-client/README.md`
- Test: `packages/fuse-client/src/client.test.ts`
- Modify: root `package.json` only if workspaces are introduced

Provide a small typed client for:

- Workspace setup status
- Branch listing
- Sandbox execution
- Execution/receipt lookup
- Health/readiness

Do not put Circle private keys or provider secrets in the SDK. The SDK should use an agent credential or workspace-scoped public API token, depending on the integration mode.

**Validation:** A fresh example can install/build the package and run a sandbox flow without importing internal server modules.

### Task 3.2: Add provider middleware helper

**Files:**
- Create: `packages/fuse-client/src/middleware.ts`
- Create: `packages/fuse-client/examples/openai-compatible.ts`
- Create: `packages/fuse-client/examples/anthropic.ts`
- Test: `packages/fuse-client/src/middleware.test.ts`

Support the minimum integration pattern:

```ts
const fuse = createFuseClient({ baseUrl, credential });
const result = await fuse.inference.chat({
  branch: "reviewer",
  idempotencyKey,
  model,
  messages,
});
```

The helper must preserve caller idempotency, expose payment-required/retry state clearly, and never automatically retry a request whose execution state is uncertain.

**Validation:** Tests cover successful sandbox execution, duplicate idempotency, changed payload rejection, authorization denial, and in-progress replay behavior.

### Task 3.3: Publish one complete integration example

**Files:**
- Create: `examples/minimal-agent/README.md`
- Create: `examples/minimal-agent/package.json`
- Create: `examples/minimal-agent/src/index.ts`
- Modify: `README.md`

The example must show:

1. Configure a sandbox workspace
2. Create or select a branch
3. Run one inference request
4. Read the receipt
5. Trigger the runaway branch fixture
6. Show Reviewer continuing

The example must run without real provider credentials in sandbox mode. Separate the optional testnet/mainnet configuration clearly.

**Validation:** Run the example from a clean install with no secrets and assert the expected branch/circuit output.

---

## Phase 4: Authenticated product console

### Task 4.1: Decide console delivery boundary

**Files:**
- Create: `docs/product/console-boundary.md`
- Reference: `src/http/desk.ts`, `src/http/console.ts`, `src/http/landing.ts`

Choose between:

- Progressive enhancement of the existing server-rendered console for fastest MVP
- A separate `apps/console` React/Vite application for a richer production surface

Default recommendation: progressive enhancement first. Keep the public hackathon desk read-only and separate from the authenticated operator console.

**Validation:** The decision documents deployment, auth, API origin, CSP, and rollback behavior before UI implementation.

### Task 4.2: Build authenticated workspace onboarding

**Files:**
- Modify: `src/http/console.ts` or create: `apps/console/src/routes/Onboarding.tsx`
- Create: `src/product/onboarding.ts`
- Test: `tests/onboarding.test.ts`

Screens:

- Create workspace
- Choose sandbox/testnet environment
- Connect provider metadata
- Create first root mandate
- Create Scout and Reviewer branches
- Run first sandbox

Every screen must show the next missing prerequisite and distinguish sandbox from real payment environments.

### Task 4.3: Build the control surface

**Files:**
- Modify: `src/http/console.ts` or create `apps/console/src/routes/Overview.tsx`
- Create: `src/product/consoleQueries.ts`
- Test: `tests/consoleQueries.test.ts`

Surface only load-bearing data:

- Branch state and allowance
- Reserved/settled/reclaimed amounts
- Acceleration signal and reason
- Last execution and receipt
- Payment state
- Arc/Gateway evidence links

Avoid decorative charts, fake live telemetry, empty-state theater, and giant labels over evidence. The live UI must degrade cleanly when provider, database, or Gateway state is unavailable.

### Task 4.4: Build the sandbox proof view

**Files:**
- Modify: `src/http/console.ts` or create `apps/console/src/routes/SandboxRun.tsx`
- Test: `tests/sandboxConsole.test.ts`

Provide a single action that starts the deterministic sandbox and then presents the causal sequence:

`reserved → usage reconciled → acceleration detected → Scout tripped → allowance reclaimed → Reviewer continued`

Use accessible state labels and compact evidence annotations. Do not display sandbox output as a real payment receipt.

---

## Phase 5: Production hardening and operational gates

### Task 5.1: Add product API rate limits and abuse controls

**Files:**
- Modify: `src/http/app.ts`
- Create: `src/product/rateLimits.ts`
- Test: `tests/productRateLimits.test.ts`

Rate-limit workspace setup, sandbox runs, provider connection mutations, and read endpoints separately. Use authenticated workspace identity and agent identity as dimensions. Ensure rate-limit failures do not mutate ledger or payment state.

### Task 5.2: Add audit events for product mutations

**Files:**
- Create: `src/product/auditEvents.ts`
- Modify: `src/persistence/schemaBootstrap.ts`
- Test: `tests/auditEvents.test.ts`

Record actor, workspace, action, target, result, and correlation ID for:

- Provider connection changes
- Mandate creation/update
- Branch creation/update/disable
- Credential issuance/revocation
- Sandbox start
- Payment configuration changes

Never store raw secrets or full bearer tokens.

### Task 5.3: Add readiness and deployment smoke coverage

**Files:**
- Modify: `scripts/smoke-production.ts`
- Modify: `scripts/check-mainnet-readiness.ts`
- Create: `scripts/smoke-product-layer.ts`
- Test: `tests/productionFoundation.test.ts`, `tests/http.test.ts`

Smoke checks must cover:

- `/health`
- `/ready`
- Workspace auth rejection
- Sandbox run
- Provider configuration mismatch rejection
- Real paid path only when separately authorized
- Gateway environment alignment
- Signer wallet chain/custody/readiness

A green readiness result must not claim paid settlement readiness unless the Gateway balance and facilitator environment are independently verified.

### Task 5.4: Complete clean-clone and public-artifact audit

**Files:**
- Modify: `.gitignore` if needed
- Modify: `README.md`
- Create: `docs/product/launch-checklist.md`

Verify from a clean checkout:

- `npm install`
- `npm run check`
- SDK/example install and build
- Sandbox run without secrets
- Public docs contain no private handoff files
- No provider keys, Circle keys, entity secrets, payment headers, or private endpoints are committed
- The public repo commit, deployment, and evidence links refer to the same release identity

---

## Phase 6: Staged release sequence

### Release A: Private developer alpha

Scope:

- Workspace onboarding
- Sandbox
- One provider integration
- SDK client
- Authenticated overview
- No real-money self-serve setup

Exit criteria:

- Five clean sandbox runs from a fresh workspace
- Cross-tenant authorization tests pass
- No provider or payment secrets exposed
- One external developer can complete the golden path from README only

### Release B: Testnet beta

Scope:

- Arc Testnet mandate path
- Circle Developer-Controlled Wallet signer boundary
- Testnet Gateway payment flow
- Durable receipt and Arc evidence links
- Explicit operator approval for funded tests

Exit criteria:

- One bounded paid request settles with authoritative facilitator evidence
- Gateway balance is verified independently from regular wallet balance
- Ambiguous settlement enters reconciliation hold
- Deployment smoke and rollback are documented

### Release C: Mainnet-gated pilot

Scope:

- Separate Base mainnet deployment and wallet
- Circle mainnet Gateway balance verification
- Invite-only workspaces
- Hard spend caps and operator approval
- No automatic production rollout

Exit criteria:

- Mainnet facilitator, network, asset, Gateway domain, and wallet all align
- Gateway API index and on-chain balance agree before paid validation
- One successful paid flow has payment response, transaction reference, and durable receipt
- Independent security review approves the release candidate

---

## Test and verification strategy

Every code-producing task follows:

1. Write the failing test.
2. Run the focused test and record the expected failure.
3. Implement the smallest change.
4. Run the focused test.
5. Run adjacent unit/integration tests.
6. Run `npm run check` after each coherent phase.
7. Run the clean-clone build before release claims.

Canonical repository verification:

```bash
npm run check
```

Focused product verification after MVP:

```bash
npx vitest run \
  tests/workspaceStore.test.ts \
  tests/workspaceAuthorization.test.ts \
  tests/setupReadiness.test.ts \
  tests/mandateManagement.test.ts \
  tests/sandboxRuns.test.ts \
  tests/productReadModels.test.ts \
  tests/onboarding.test.ts \
  tests/consoleQueries.test.ts
npm run build
npm run smoke:product-layer
```

Acceptance test for the golden path:

- A new workspace can be created.
- A sandbox environment is selected.
- Scout and Reviewer branches are created with bounded allowances.
- The deterministic sandbox runs without provider or wallet secrets.
- Scout reaches `TRIPPED`.
- Reviewer completes.
- The receipt identifies sandbox mode and does not claim real settlement.
- A second run is idempotent or receives a safe conflict, never a duplicate execution.

---

## Risks and tradeoffs

### Product surface can outrun the engine

Mitigation: build read models and sandbox against existing ledger/circuit APIs first. Do not duplicate budget logic in the console.

### Authentication complexity delays the MVP

Mitigation: separate human workspace sessions from agent credentials. Start with invite-only workspace tokens and add broader identity providers later.

### Sandbox creates misleading proof

Mitigation: label every sandbox receipt and evidence artifact. Keep sandbox IDs and payment IDs structurally distinct.

### Mainnet Gateway indexing remains operationally fragile

Mitigation: keep mainnet behind an explicit gate. Require on-chain and indexed balance agreement. Never repeatedly deposit on API lag.

### Console becomes generic SaaS chrome

Mitigation: focus the UI on branch state, cost containment, receipts, and evidence. No decorative charts or fake operational telemetry.

### SDK compatibility burden

Mitigation: support one typed client and one middleware path first. Version the public request/receipt shapes and document deprecation policy before adding adapters.

### Current public deployment differs from the final candidate

Mitigation: bind each release to a commit, deployment URL, environment manifest, and evidence set. Do not claim the latest local V4 fixes are public until committed, pushed, and redeployed.

---

## Open decisions before implementation

1. Progressive-enhanced existing console or separate React/Vite console for the first alpha.
2. Invite-only workspace tokens or an external identity provider for human login.
3. Anthropic-first or OpenRouter-first for the first SDK example.
4. Whether the first paid beta is Arc Testnet only or includes the isolated Base mainnet deployment.
5. Whether sandbox runs are persisted in the same evidence tables with an explicit `sandbox` namespace or stored in separate product tables.

## Recommended build order

Implement in this order:

1. Product contract and threat model
2. Workspace persistence and authorization
3. Sandbox API
4. Product read models
5. SDK client and minimal example
6. Mandate/branch management API
7. Authenticated onboarding
8. Control surface
9. Rate limits and audit events
10. Testnet paid beta gates
11. Mainnet-gated pilot

The first useful external milestone is not a dashboard screenshot. It is a fresh developer completing the golden path without reading internal source code and seeing a truthful, durable explanation of what happened.
