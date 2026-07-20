# Sibling Divergence Shadow v1

Status: instrumentation candidate awaiting A/B/C replay and live-shadow evidence

Mode: shadow-only behavioral evidence; deterministic workload authority is enforced

Trust boundary: centralized Fuse control plane; no customer delegation signature is claimed

## Purpose

This slice tests one falsifiable product hypothesis:

> At Fuse's real branch fan-out, does branch-aware sibling divergence reduce detection time or dollars-through compared with deterministic ceilings and flat behavioral signals, without materially increasing false interventions?

It is deliberately not a general anomaly framework. It introduces policy-bound workload classes, immutable branch/delegation evidence, explicit financial exposure, and one shadow evaluator.

## Safety model

### Layer 1: deterministic authority

The following controls remain authoritative and cannot be learned away:

- mandate state and expiry;
- authenticated organization and agent assignment;
- required capability;
- provider and model allowlists;
- mandate, hourly, daily, rate, and token ceilings;
- branch-bound workload-class allowlist;
- immutable branch lifetime budget and expiry;
- per-class call ceiling;
- per-class invocation count;
- per-class aggregate branch budget;
- minimum server-observed input shape.

Unknown branches, mismatched agents, unknown classes, and class escalation fail closed. These controls apply even when the policy is otherwise `dry_run`.

### Behavioral layer

Sibling-divergence evaluation occurs only after successful provider execution and reconciliation. It writes evidence but cannot:

- deny a request;
- reduce authority;
- transition a mandate or branch;
- invoke a provider;
- authorize payment or settlement.

### Loss boundary

Every workload-scoped decision records:

- `branchLimitAtomic`;
- `branchCommittedBeforeAtomic`;
- `requestReservationAtomic`;
- `maximumExposureAtomic`;
- `remainingAuthorityAtomic`.

`maximumExposureAtomic` is the lesser of the branch's unconsumed lifetime budget, its unconsumed class budgets, and the mandate's unconsumed budget before the decision. It is not labeled safe or acceptable merely because it is bounded.

## Workload classes as capabilities

Workload classes belong to immutable policy versions. A request supplies both:

- `X-Fuse-Branch`;
- `workload_class` in the completion body.

Supplying only one fails with `INCOMPLETE_WORKLOAD_SCOPE`.

The selected class must exist in the policy version and in the branch's immutable `allowedWorkloadClasses`. The authenticated agent must match the branch. The request cannot enlarge the branch's authority.

A class transition changes the class applied to the current request. It does not erase branch history. Existing observations remain immutable and can become comparable again when the branch returns to a prior class within the observation window.

## Delegation evidence and custody boundary

A mandate branch binds:

- organization;
- mandate;
- branch and parent branch;
- authenticated agent;
- policy ID and version;
- allowed workload classes;
- branch lifetime budget and expiry;
- creation time and actor;
- `authoritySource = fuse_control_plane`.

Fuse computes a canonical SHA-256 `delegationHash` over that snapshot and recomputes it on authorization and evidence reads. A mismatch fails closed. This detects accidental or disputed record changes inside Fuse's evidence chain; it is not an external authorization signature.

A finite parent expiry requires every child to have an equal-or-earlier expiry. Child lifetime budgets are reserved authority: sibling allocations may not exceed the parent maximum, and a parent request is evaluated against only the authority left after its child allocations. Parent row locking serializes concurrent child creation.

Current trust statement:

> Fuse enforces a centrally administered delegation record inside Fuse's own control-plane trust boundary.

Phase 0 custody work must decide whether a customer-held or otherwise external key signs the delegation envelope. A signature from another Fuse-held key improves separation and auditability but does not remove Fuse's unilateral authority.

## Comparable observations

Only completed, reconciled executions are eligible. A candidate observation must match:

- organization and mandate;
- parent branch;
- workload class;
- provider;
- model;
- policy ID and version;
- configured rolling window.

Reservations, denials, failures, reconciliation holds, other models, other providers, other classes, other policy versions, later completions, and other parents are excluded.

The target branch and every sibling branch must independently satisfy `targetMinimumObservations`. Sibling requests are aggregated by branch before comparison, so a chatty sibling cannot gain extra weight merely by issuing more requests.

## Small-n estimator

Let:

- `T` be target-branch window spend;
- `S` be the sibling aggregate;
- `P` be the workload-class prior window spend;
- `n` be the number of comparable sibling branches;
- `k` be the confidence constant, initially `5`.

Sibling weight:

```text
w = n / (n + k)
```

With `k = 5`:

| n | sibling evidence | class prior |
|---:|---:|---:|
| 2 | 29% | 71% |
| 3 | 38% | 62% |
| 5 | 50% | 50% |
| 10 | 67% | 33% |

Blended baseline:

```text
B = wS + (1 - w)P
```

For fewer than five comparable siblings, `S` is the arithmetic mean of sibling branch spends. At five or more, the highest and lowest branch spends are removed before calculating the mean. The aggregate strategy is evidence, not a hidden implementation detail.

Threshold classification uses exact `bigint` rational cross-multiplication. Displayed atomic baselines and basis-point ratios may be floored, but those rounded values never decide whether a signal fired.

## Independent confidence gates

The evaluator distinguishes:

1. `insufficient_target_observations` — the measured branch is not stable enough;
2. `insufficient_siblings` — the relative baseline is not stable enough;
3. `scored` — both gates passed.

`siblingMinimumForScoring` controls whether a relative score is calculated. `siblingMinimumForIntervention` is a stricter evidence flag. V1 remains shadow-only regardless of that flag.

After target confidence passes, the independent class-prior signal can be recorded even when sibling scoring is unavailable. This preserves a measurable B baseline while gating only relative sibling signals on sibling sufficiency.

## Signals

The evidence may include:

- `SIBLING_DIVERGENCE` — target spend meets or exceeds the exact blended baseline threshold;
- `CLASS_PRIOR_EXCEEDED` — target spend meets or exceeds the class prior threshold;
- `CORRELATED_COHORT_SHIFT` — the sibling cohort itself meets or exceeds the class prior threshold.

Keeping the class prior and correlated-cohort signal prevents a pure-relative comparison from declaring a correlated shift normal merely because every sibling moved together.

V1 uses exact/near-duplicate work only as a future corroborating signal. It does not incur embedding or semantic-similarity cost.

## Durable evidence

Each completed scoped execution enqueues one durable evaluation job. Successful processing writes one append-only shadow record containing:

- request, organization, mandate, branch, class, provider, and model;
- evaluation status;
- target and sibling observation counts;
- aggregate strategy and value;
- shrinkage weight;
- blended baseline;
- target, prior, and cohort ratios;
- intervention eligibility;
- fired signals;
- `wouldEmitAnySignal`, `wouldSignalTarget`, `cohortShift`, and the confidence-gated `wouldSignal`;
- evaluation time.

An exact idempotent replay returns the original decision, provider response, and shadow evidence without another provider dispatch or another shadow row.

Authoritative completion commits before shadow evaluation. A PostgreSQL savepoint inside that completion transaction attempts to lock and increment the per-cohort counter, store the immutable ordinal, and enqueue shadow work. On success those changes commit atomically with completion. On bookkeeping failure the savepoint rolls back the counter and queue work, the execution records `shadow_order_state=failed`, and authoritative completion still commits without an ordinal; that execution is explicitly absent from ordered evidence rather than causing reconciliation hold. A standalone PostgreSQL sequence is deliberately not used because sequence allocation is not rolled back and does not prove commit order.

Evaluation is an immutable as-of query: the completion transaction stores a database-assigned cohort completion time, and a target at ordinal `N` may read only completed observations in the same cohort whose ordinal is at most `N` and whose database completion time falls inside the configured window. Caller clocks do not determine ordering or the window boundary. Retries use the same cutoff and therefore reproduce the same input set even if newer completions exist.

Shadow jobs do not depend on earlier shadow jobs succeeding. If job `N` is failed awaiting retry, job `N+1` may still evaluate because execution `N` is already an authoritative completed observation. The failed job's missing evidence is explicit queue state; it does not remove its observation, reduce `N+1`'s cohort, or stall the pipeline. Retrying `N` later evaluates against its original ordinal cutoff.

A shadow query, arithmetic, or persistence failure leaves the execution completed and never moves the mandate into reconciliation hold. `npm run shadow:retry` reports queue counts and retries pending/failed work. A unique five-minute claim lease increments the attempt count before evaluation; completion and failure transitions require the same token, expired claims are reclaimable, and stale workers cannot mutate queue truth after takeover. Each item receives at most three evaluator attempts; exhausted poison work remains visible and is excluded from later batches. Deployments schedule that command externally against `DATABASE_URL_UNPOOLED`. Operator reconciliation that settles a scoped execution uses the same savepoint-isolated ordering and queue path.

## Rollout and rollback

Schema v4 introduces workload classes, branch records, and evidence. Schema v5 adds explicit branch lifetime authority, atomic cohort ordinals, and the durable shadow queue. `FUSE_WORKLOAD_SHADOW_ENABLED` defaults to `false`. While disabled, the supported HTTP surface rejects workload-policy publication, branch creation, and workload-scoped inference with `WORKLOAD_SHADOW_ROLLOUT_DISABLED`, and preserves legacy unscoped inference.

Production rollout is deliberately two-stage: first deploy the branch-aware binary with the flag disabled and `DATABASE_URL_UNPOOLED`, verify `/ready` reports `workloadShadowSchema: true`, exercise legacy unscoped inference and ceiling-only Console policy publication, and make that deployment the rollback target; only then enable the flag in a second deployment. Never roll back an activated workload-bound mandate to the pre-branch binary. If an emergency requires that rollback, pause workload-bound mandates before changing binaries.

Schema v4 was never released from `main`; the supported production upgrade is the shipped v3 schema through v4 and v5 in one advisory-locked bootstrap. Version 5 deliberately fails with `BRANCH_AUTHORITY_V5_BACKFILL_REQUIRED` if it encounters populated experimental v4 branch data because inventing lifetime budgets or expiry would silently broaden authority. Operators must remove disposable experimental branches or migrate them with an explicitly reviewed authority map before retrying bootstrap.

Emergency downgrade runbook:

1. Inventory active workload-bound mandates with `SELECT mandates.organization_id, mandates.id FROM control_mandates mandates JOIN policy_versions policies ON policies.organization_id = mandates.organization_id AND policies.policy_id = mandates.policy_id AND policies.version = mandates.policy_version WHERE mandates.state = 'active' AND jsonb_array_length(policies.workload_classes) > 0`.
2. Pause every returned mandate through the authenticated mandate-state API and repeat the query until it returns zero rows.
3. Confirm no workload-scoped inference succeeds, then promote the branch-aware flag-off rollback deployment.
4. Smoke `/health`, `/ready`, identity, ceiling-only policy publication, and legacy unscoped inference. The pre-branch binary remains prohibited while any workload-bound mandate exists.

## Evaluation contract

Compare three policies against the same immutable executions after August 9. The current instrumentation records branch-aware inputs and the existing class-prior/cohort signals; the replay harness must implement and persist the flat velocity, retry, and duplicate outputs before B-versus-C promotion evidence is claimed:

- **A — ceilings only:** deterministic limits, no behavioral signals;
- **B — flat signals:** ceilings plus class-prior, absolute velocity, retry, and duplicate signals;
- **C — branch-aware:** B plus sibling divergence.

Required cohorts include fan-out `n=2`, `n=3`, and `n=4`, because those are normal operating sizes rather than edge cases.

Required fixtures:

- legitimate lookup burst followed by an authorized document summary;
- one runaway child with healthy siblings;
- two legitimately unusual siblings;
- all siblings shifting together;
- unauthorized expensive-class escalation;
- alternating classes intended to reset history;
- sparse target with mature siblings;
- mature target with sparse siblings;
- provider/model mismatch;
- deterministic hard-budget breach.

Metrics:

- false-trip and false-warning rate;
- warning-to-trip ratio;
- dollars-through before behavioral signal;
- dollars-through before deterministic hard stop;
- runaway spend prevented versus A;
- time to detection;
- legitimate work interrupted;
- operator recovery time;
- incremental value of C over B.

If C does not materially improve dollars-through or detection time at fan-out 2–4 without worsening false interventions, sibling divergence is not treated as the product moat.

## Explicit non-goals

This slice does not add:

- behavioral enforcement;
- automatic authority reduction or decay;
- semantic embeddings;
- customer-signed delegation;
- autonomous settlement or payment signing;
- a generic anomaly plugin architecture;
- cross-provider cost normalization.

Those require separate evidence and trust-boundary decisions.
