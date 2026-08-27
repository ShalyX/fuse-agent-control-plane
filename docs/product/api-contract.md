# Fuse product API contract

Status: implementation contract for the current product layer

Base path: `/api/v1/product`

## Authentication

Every protected route requires a bearer credential authenticated by the control plane.

Capabilities are checked at the route boundary. The workspace is always derived from the authenticated principal. Callers cannot select or override the workspace in request bodies or query parameters.

Capability groups:

- `mandates:read` for readiness and mandate reads
- `mandates:write` for mandate creation and transitions
- `mandates:admin` for mandate agent and branch administration
- `agents:write` for agent creation
- `credentials:issue` for agent credential issuance
- `providers:read` and `providers:write` for provider connections
- `policies:write` for policy publishing
- `inference:invoke` for product inference
- `receipts:read` for receipt access

## Common error envelope

Errors use this shape:

```json
{
  "error": {
    "code": "STABLE_MACHINE_CODE"
  }
}
```

Some decision and inference errors include additional fields such as `decisionId` and `reasonCodes`. Clients must branch on `error.code`, not on human-readable text.

Common product codes:

- `MISSING_MANDATE`
- `INVALID_MANDATE_REFERENCE`
- `INVALID_RECEIPT_REFERENCE`
- `INVALID_RECEIPT_PAGE_SIZE`
- `INVALID_RECEIPT_CURSOR`
- `MISSING_IDEMPOTENCY_KEY`
- `POLICY_DENIED`
- `REQUEST_IN_PROGRESS`
- `REQUEST_REQUIRES_REVIEW`
- `RECEIPT_NOT_FOUND`
- `RECEIPT_QUERY_UNAVAILABLE`
- `INFERENCE_EXECUTION_UNAVAILABLE`

## Product routes

### Readiness

`GET /api/v1/product/readiness`

Requires `mandates:read`.

Returns the authenticated workspace's product readiness read model. `ready` requires a live
database, a verified active provider configuration whose encrypted credential is resolvable,
a provider/model-compatible policy with positive execution limits, an active agent with an
unrevoked and unexpired `inference:invoke` credential, and an active unexpired mandate with
remaining authority. Workload policies additionally require a matching live branch with
remaining authority. The durable PostgreSQL sandbox store must also be available. Draft,
paused, revoked, expired, exhausted, unverified, corrupt, incompatible, or in-memory-only state
fails closed with actionable `missingSteps`.

Signer, wallet, and Gateway checks are `not_applicable` in customer-direct control mode. They
become required only when the runtime explicitly selects settlement mode. The endpoint is a
read model and does not mutate control-plane state.

### Agent and credential setup

`POST /agents`

Requires `agents:write`.

Creates an agent identity in the authenticated workspace.

`POST /agent-credentials`

Requires `credentials:issue`.

Issues a credential for an agent. Secret material is returned only through the credential issuance flow and is never included in receipts.

### Provider connections

`POST /provider-connections`

Requires `providers:write`.

Creates or updates tenant-owned provider configuration through the existing provider configuration boundary.

`GET /provider-connections`

Requires `providers:read`.

Returns safe provider metadata. Provider secrets are not returned.

### Policies

`POST /policies`

Requires `policies:write`.

Publishes an immutable policy version through the existing policy administration path.

### Mandates

`POST /mandates`

Requires mandate write authorization.

Creates a bounded mandate using the existing ledger and policy rules.

Mandate administration routes add agents, branches, and lifecycle transitions. These routes do not bypass policy admission or mutate balances directly.

### Inference

`POST /inference`

Requires `inference:invoke`.

Required headers:

- `Idempotency-Key` or `X-Request-Id`
- `X-Fuse-Mandate`

The request is admitted through policy before provider invocation. Reservation occurs before invocation. A completed response includes reserved and actual atomic cost.

Possible terminal product outcomes include:

- completed
- denied
- in progress
- requires review
- unavailable

### Receipt list

`GET /mandates/:mandateId/receipts`

Requires `receipts:read`.

Query parameters:

- `limit`: integer from 1 through 100. Default 50.
- `cursor`: opaque v2 keyset cursor.

Response:

```json
{
  "receipts": [
    {
      "decisionId": "decision-id",
      "requestId": "request-id",
      "workspaceId": "workspace-id",
      "mandateId": "mandate-id",
      "agentId": "agent-id",
      "policyId": "policy-id",
      "policyVersion": 1,
      "outcome": "ALLOW",
      "wouldOutcome": "ALLOW",
      "enforced": true,
      "reasonCodes": [],
      "estimatedCostAtomic": "100",
      "reservedCostAtomic": "100",
      "actualCostAtomic": "87",
      "executionStatus": "completed",
      "failureCode": null,
      "reconciliationResolved": false
    }
  ],
  "nextCursor": "opaque-or-null"
}
```

The production store uses keyset pagination ordered by `(decided_at, id)`. Clients must treat cursors as opaque and must not decode, construct, or persist assumptions about their internal format.

Agent principals only see receipts whose `agentId` matches the authenticated agent. Operator and service-account principals see receipts within their authenticated workspace and mandate scope.

### Single receipt

`GET /receipts/:requestId`

Requires `receipts:read` and the `X-Fuse-Mandate` header.

Returns `{ "receipt": ... }` using the same receipt schema as the list endpoint.

A missing receipt, a receipt outside mandate scope, and an agent reading another agent's receipt all return `404 RECEIPT_NOT_FOUND`.

## Execution and receipt read models

The product read models are projections over policy decisions, execution settlements, and explicitly supplied payment evidence. They do not create a second ledger or infer missing financial state.

Execution fields include:

- `requestedAtomic`: policy-time estimate
- `reservedAtomic`: reservation committed before provider dispatch
- `reportedAtomic`: provider-reported or reconciled amount
- `settledAtomic`: populated only for a completed settlement
- `provider`, `model`, `branchId`, and `workloadClass`
- `circuit.state` and `circuit.reason`
- `payment.status` and optional facilitator reference
- `arc.status` and optional commitment reference

`mode: "sandbox"` forces payment and Arc evidence to `not_applicable`. Sandbox output cannot present itself as a paid execution.

For live executions, absent evidence remains explicit:

- Gateway batch settlement is `pending_batch`, not `settled`
- Missing Arc evidence is `unavailable`, not `verified`
- Reconciliation hold keeps `settledAtomic` as `null`
- An Arc commitment is exposed only when supplied as verified evidence

Receipt read models contain the policy identity and outcome alongside the complete execution projection. Raw prompts, messages, credentials, provider secrets, and untrusted input snapshots are excluded.


A receipt is a product read model over a policy decision and, when present, an execution settlement.

Important fields:

- `estimatedCostAtomic`: policy-time estimate
- `reservedCostAtomic`: amount reserved before provider invocation
- `actualCostAtomic`: provider-reported or reconciled final amount, otherwise `null`
- `executionStatus`: current durable execution state
- `failureCode`: durable execution or reconciliation failure code
- `reconciliationResolved`: whether the reconciliation case has been resolved

`reconciliation_hold` is a valid receipt state. It is not converted into success, failure, or an invented cost.

## Sandbox

`POST /sandbox/runs`

Requires `sandbox:run`. The request body is optional and may contain `{ "seed": "..." }`.

The response is a deterministic, idempotent sandbox run scoped to the authenticated workspace. It is explicitly marked `mode: "sandbox"` and never claims provider, Circle, wallet, Gateway, or Arc settlement.

When the app is configured with `PostgresSandboxRunStore`, the run record is persisted in `fuse_product_sandbox_runs` and survives service restart. The deterministic `(workspace, seed)` identity is the idempotency key. Without that dependency, the route uses the explicit process-local test fallback and does not claim restart durability.

The first scenario contains the causal sequence:

`reserved → usage reconciled → acceleration detected → Scout tripped → allowance reclaimed → Reviewer continued`

Sandbox execution uses injected usage against the existing ledger and circuit primitives. It does not call real providers or payment infrastructure. Repeating the same seed in the same workspace returns the same run ID and result.


The product layer:

- derives workspace identity from authentication
- preserves policy admission as the authorization boundary
- preserves ledger and reservation authority in the control plane
- never exposes provider credentials through product read models
- treats unresolved settlement evidence as unresolved
- does not create a second balance or ledger
- does not authorize signing
