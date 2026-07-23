# Held-Out Provider-Path Reliability Protocol v2

**Status:** preregistration draft; this document authorizes no beacon retrieval, provider traffic, payment, reconciliation decision, or held-out selectivity claim.

## Purpose and claim boundary

Protocol v1 ended operationally incomplete after 13 completed requests. Request 14 returned HTTP 502, its authoritative execution entered `reconciliation_hold` with `PROVIDER_OUTCOME_AMBIGUOUS`, provider cost remained unresolved, and the preregistered sibling-divergence gate produced no primary result.

Protocol v2 is not a new seed for v1. It is a separate provider-path reliability qualification. It tests whether one exact Fuse deployment, the `openrouter` route, the exact `nousresearch/hermes-4-405b` model binding, and a sealed 100-request schedule can produce authoritative terminal outcomes, bounded reconciliation, durable evidence, and exact idempotency replay without duplicate dispatch authorization or Fuse execution/accounting mutation.

The fixed denominator is 100 planned fresh request IDs/admission attempts. For each ID, the protocol separately records whether admission was attempted, whether an execution row was created, whether adapter dispatch was durably authorized, and whether external invocation was possible or confirmed. The clustering unit is the preregistered execution block because requests inside an outage or burst are correlated. The gate decision is run-level and conjunctive.

A pass is not a production availability estimate, SLA, provider-wide benchmark, sibling-divergence efficacy result, safety guarantee, prevented-spend evidence, or authorization to rerun v1. The exact-binomial bounds are supportive diagnostics only because the attempts are time-blocked and correlated.

A pass permits only the next evidence step: drafting and preregistering a new sibling-divergence selectivity protocol against a later unavailable beacon. That later experiment requires disjoint calls and cohorts, a separate implementation review, and separate spend authorization.

## Relationship to protocol v1

- Protocol v1 remains permanently `incomplete`; its seed, plan, cohorts, thresholds, partial calls, and partial behavior are not reused or pooled.
- Protocol v2 has no runaway or legitimate labels and does not score v1 selectivity endpoints.
- Protocol v2 uses a new evidence type, domain separator, beacon, plan fingerprint, run IDs, mandates, branches, request IDs, manifests, replay report, and cost cap.
- Passing v2 cannot retroactively validate v1.
- Policy B remains incomplete. Protocol v2 cannot support a B-versus-C promotion claim.

## Leakage controls

1. This complete protocol, including schedule, allocation, reconciliation semantics, endpoints, and stopping rules, must be publicly merged before the selected beacon is available.
2. The generator, runner, replay reducer, fault matrix, schemas, and tests must conform to this document and be merged before beacon retrieval.
3. Randomness selects context sizes and exact replay targets only. It cannot change sample size, blocks, profiles, provider/model, endpoints, thresholds, schedule, or continuation.
4. The beacon response and plan are published as an exact-content recoverable write-once pair. The canonical plan is hashed, reviewed, and committed before setup or provider traffic.
5. The paid runner verifies the committed plan bytes and authoritative PostgreSQL setup before dispatch.
6. No favorable seed selection, replacement call or block, optional continuation, provider/model substitution, router fallback, extra diagnostic paid call, or post-hoc threshold change is allowed.
7. Any change to the allocation, schedule, retry behavior, endpoint semantics, reconciliation rules, or decision rule starts a new protocol version.
8. Protocol-v1, fixed-fixture, calibration, replication, and future selectivity artifacts cannot enter protocol-v2 numerators or denominators.
9. Protocol-v2 reports expose only shadow queue/evidence existence, ordinals, settlement, and retry state. Evaluator signals, thresholds, eligibility, baselines, and would-signal fields remain embargoed until a future selectivity protocol's scenarios, labels, endpoints, thresholds, and allocation are publicly frozen.
10. Future selectivity uses a dedicated organization ID that was not used by protocol v2, plus fresh mandates, roots, branches, requests, beacon, and plan. Its authoritative cohort query rejects every protocol-v2 mandate/request ID. Its first provider call occurs no earlier than 24 hours after protocol-v2 finalization to avoid immediate router quota/rate-limit carryover.
11. Protocol-v2 outcomes cannot justify evaluator code, threshold, or scenario changes. Any reliability-motivated transport/lifecycle change receives independent review and cannot alter frozen selectivity semantics.

## Randomness beacon

- Source: drand default chained mainnet beacon
- Chain hash: `8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce`
- Public key: `868f005eb8e6e4ca0a47c8a77ceaa5309a47978a7c71bc5cce96366b5d7a569937c529eeda66c7293784a9402801af31`
- Scheme: `pedersen-bls-chained`
- Period: 30 seconds
- Genesis time: `1595431050`
- Round: `6315000`
- Expected availability: `2026-07-24T08:17:00Z`
- Endpoint: `https://api.drand.sh/public/6315000`

The expected time is `genesis + (round - 1) × 30 seconds`. If this protocol is not publicly merged before that time, round `6315000` is invalid. A reviewed public amendment must select a later unavailable round before proceeding. No relay may be queried early.

The implementation must verify the BLS signature and chained-beacon relation against the pinned chain information. Format checks and `SHA-256(signature) == randomness` alone are insufficient.

The deterministic stream is:

```text
block(i) = SHA-256(
  "fuse-held-out-reliability-v2" ||
  hex_to_bytes(beacon.randomness) ||
  uint32_be(i)
)
```

Sequential unsigned 32-bit big-endian words are consumed. The stream is exactly:

```text
counter = 0
words = []
next_word():
  if words is empty:
    digest = block(counter)
    counter = counter + 1
    words = [
      uint32_be(digest[0:4]), uint32_be(digest[4:8]),
      uint32_be(digest[8:12]), uint32_be(digest[12:16]),
      uint32_be(digest[16:20]), uint32_be(digest[20:24]),
      uint32_be(digest[24:28]), uint32_be(digest[28:32])
    ]
  return remove_first(words)

draw(min, max):
  m = max - min + 1
  limit = floor(2^32 / m) * m
  repeat:
    word = next_word()
  until word < limit
  return min + (word mod m)

for block in [1,2,3,4,5]:
  for lane in [normal-paced, high-envelope, bounded-burst, restart-resume]:
    for call in [1,2,3,4,5]:
      context[block,lane,call] = draw(lane.min, lane.max)

for block in [1,2,3,4,5]:
  for lane in [normal-paced, high-envelope, bounded-burst, restart-resume]:
    replayTarget[block,lane] = draw(1, 5)
```

Counters start at zero; block, lane, call, and replay-target ordinals start at one. Rejected words are discarded inline and do not alter consumer order. No other plan field consumes randomness.

## Fixed schedule

There are five blocks of 20 fresh dispatches. Their opening times are fixed relative to the beacon, not selected by an operator:

| Block | Orchestrator opens at | Launch deadline |
|---:|---|---|
| 1 | `2026-07-25T08:17:00Z` | `2026-07-25T08:22:00Z` |
| 2 | `2026-07-25T20:17:00Z` | `2026-07-25T20:22:00Z` |
| 3 | `2026-07-26T08:17:00Z` | `2026-07-26T08:22:00Z` |
| 4 | `2026-07-26T20:17:00Z` | `2026-07-26T20:22:00Z` |
| 5 | `2026-07-27T08:17:00Z` | `2026-07-27T08:22:00Z` |

The launch interval is half-open: database `clock_timestamp() >= opensAt AND < launchDeadline`. Launch is the commit of one create-only `block_claimed` row containing run, block, plan fingerprint, and database timestamp. The scheduler must commit it in that interval; any boundary-equal `launchDeadline` claim is late and irreversibly fails the gate. The first scheduled admission time in every unheld lane is `blockClaimedAt + 1 second`.

The block orchestrator starts four independent lane workers concurrently. Each scheduled `admission_started` event must commit in the half-open interval `[scheduledAt, scheduledAt + 1 second)` or trigger mandatory failure stopping. Once claimed, a conforming block may finish after the five-minute launch window but remains subject to its 30-minute deadline. A held lane only appends FIFO work as defined below.

No provider traffic may occur until the sealed plan/cost cap has valid operator authorization and the reconciler has valid separate authorization. The authorization-readiness operation starts in `[2026-07-25T08:16:00Z, 2026-07-25T08:16:01Z)` and has a 55-second whole-operation deadline: at most 5 seconds for signature/field validation, 15 seconds for the decision transaction, 30 seconds for complete publication of both receipts, and 5 seconds for all remaining transitions. One database transaction locks the protocol-control and operator-nonce rows and commits one create-only authorization-decision row containing the artifact-validity pair, exact table-row verdict, nonce disposition, canonical bytes and SHA-256 digest of both receipts, and either continued `active` control or the irreversible failure transition. Only a valid/valid verdict consumes the nonce. The two receipt files are an idempotent outbox projection of that committed row; recovery publishes only its byte-identical payloads and never recomputes a verdict. A crash before decision commit rolls the transaction back and may retry only inside the applicable 5-second validation and 15-second transaction phases. Failure to complete either predecision phase irreversibly fails readiness; the first successful recovery transaction creates a separate `readiness_predecision_failed` decision under the same locks, consumes no nonce, binds two `readiness_failed` receipt payloads with exact `validation_phase_deadline` or `decision_phase_deadline` reason codes, and sets or preserves failed control. A crash or publication failure after a committed valid/valid decision cannot undo nonce consumption; failure to publish both matching files within the 30-second phase, or to complete remaining transitions within their 5-second phase, irreversibly fails the run, and recovery still completes byte-identical receipt publication from the row. At block 1 `opensAt`, admission requires active protocol control, a committed valid/valid decision, and two byte-identical success receipts; otherwise no block claim is permitted and the schedule never moves. For an on-time decision, pair handling is exact:

| Operator artifact | Reconciliation artifact | Operator receipt / nonce | Reconciliation receipt |
|---|---|---|---|
| valid | valid | `consumed`; nonce consumed | `validated` |
| valid | absent/invalid | `valid_not_consumed_peer_invalid`; nonce remains unused | `absent_or_invalid` |
| absent/invalid | valid | `absent_or_invalid`; no nonce consumed | `valid_not_activated_peer_invalid` |
| absent/invalid | absent/invalid | `absent_or_invalid`; no nonce consumed | `absent_or_invalid` |

No on-time verdict outside this table is valid, and only the first row can authorize a block claim. `readiness_predecision_failed` is the sole non-table decision and always binds two `readiness_failed` receipts, an unused nonce, and failed control.

## Fixed allocation and lanes

The provider/model are pinned above. Four isolated lanes use separate mandates so one reconciliation hold cannot freeze the others. Each lane contributes five fresh dispatches per block and 25 total:

| Lane | Workload class | Context units | Dispatch mode | Fresh per block | Total |
|---|---|---:|---|---:|---:|
| normal-paced | `baseline-lookup` | 30–120 | sequential, one in flight | 5 | 25 |
| high-envelope | `spike-burst` | 450–850 | sequential, one in flight | 5 | 25 |
| bounded-burst | `spike-burst` | 30–120 | one concurrent group of five | 5 | 25 |
| restart-resume | `baseline-lookup` | 30–120 | separate runner process per call | 5 | 25 |
| **Total** | | | | **20** | **100** |

The OpenRouter request sets `provider.allow_fallbacks = false`; the adapter retry count is zero. The claim is limited to the requested model ID and returned OpenRouter generation metadata. It does not attest an unobservable upstream implementation or absence of provider-side aliasing. Every lane receives a fresh root and two balanced child branches under its own mandate. Define one-based `laneCallOrdinal = (block - 1) × 5 + callOrdinal`, yielding 1–25 continuously across blocks. Odd-numbered lanes send odd lane-call ordinals to child 1 and even ordinals to child 2; even-numbered lanes reverse that mapping. Thus each 25-call lane is near-balanced 13/12 and all four lanes are exactly balanced 50/50. Lane and call ordinals are one-based. There are no behavioral labels. Every request uses `maxOutputTokens = 8` and the ordinary evidence-runner prompt/body construction.

For blocks 1 through 5 and lanes in table order, first consume one accepted random integer per canonical call to select all 100 context sizes. Then consume exactly 20 replay-selection integers in block order and lane table order as defined below. No other plan field consumes randomness. The block/lane/call order is not randomized because pacing and concurrency are protocol treatments. Request IDs derive only from protocol version, immutable run ID, block, lane, and canonical call ordinal.

Within a block, the four lane workers run concurrently:

1. `normal-paced` and `high-envelope` are single-flight. Call 1 uses `blockClaimedAt + 1 second`; call `k > 1` uses `previousTerminalDatabaseTime + 5 seconds`.
2. `bounded-burst` durably prepares all five IDs and begins all five admissions at `blockClaimedAt + 1 second`. Each successful ALLOW admission atomically creates its token and waits at a dispatch barrier. The barrier decision transaction locks the protocol control row after all five admissions terminate. If all five tokens exist and control is `active`, it appends immutable `barrier_released` events for all five before unlocking; only those released owners may enter adapter code. Otherwise it performs the global `active → failed` transition if still needed and appends `barrier_canceled_before_dispatch` for every existing unreleased burst token while holding the same lock. Independently, any global-failure transaction must append that cancellation event for every existing unreleased burst token before unlocking; each canceled owner becomes token-owning `not_dispatched`. `barrier_released` and `barrier_canceled_before_dispatch` are mutually exclusive. All five `admission_started` events must satisfy the one-second start interval; at most five are in flight after release.
3. `restart-resume` is single-flight with the same five-second cadence, but a newly started process must claim each scheduled call before admission. The prior process exits only after authoritative terminal state and manifest fsync.

After all 100 planned fresh IDs have terminal gate classifications and every lane FIFO is empty, the active run performs the 20 replay probes serially in block order and lane table order. No replay runs while any fresh admission, held lane, or resume group remains. If mandatory global failure occurs first, every unstarted replay probe is durably `canceled_gate_failure`; replay cancellation cannot restore a pass.

Separate lane mandates, class/policy limits, branch ceilings, and the global cost cap use exact least-authority values sealed in the plan:

- workload-class per-call maxima are pinned to `baseline-lookup = 10000` and `spike-burst = 50000` USD-micros;
- `normal-paced` child maxima are `130001` and `120001`; root/mandate/policy aggregate/hourly/daily maximum is `250002`;
- `high-envelope` child maxima are `600001` and `650001`; root/mandate/policy aggregate/hourly/daily maximum is `1250002`;
- `bounded-burst` child maxima are `650001` and `600001`; root/mandate/policy aggregate/hourly/daily maximum is `1250002`;
- `restart-resume` child maxima are `120001` and `130001`; root/mandate/policy aggregate/hourly/daily maximum is `250002`;
- the global known-cost cap is exactly `3000000` USD-micros and the maximum simultaneously unresolved reservation exposure is exactly `320000` USD-micros: one normal, one high, five burst, and one restart token;
- `maxRequestsPerMinute = 5` per lane; backlog group cadence is exactly the prior-group-terminal plus 60-second rule below;
- every mandate/policy expires at `2026-07-28T10:30:00Z`, one hour after hard finalization;
- per-call reservation remains the existing sealed workload-class maximum; no wildcard class or unplanned branch is authorized.

The operator authorization is canonical key-sorted JSON signed with Ed25519 by the named issuer holding capability `evidence:authorize-spend`; its public verification key and issuer credential ID must be merged in the reviewed implementation before beacon availability. Signed fields are run ID, organization ID, plan/configuration/setup/executable fingerprints, exact provider/model, all four policy/mandate/root/child IDs and maxima, `3000000` known-cost cap, `320000` unresolved-exposure cap, schedule, one-shot nonce, issued-at, and expiry `2026-07-25T08:22:00Z`. The authorization-readiness verifier checks signature, issuer capability, exact field equality, unused nonce, and unexpired database time, then applies the shared crash-atomic decision/outbox procedure above; no operator-only path may consume the nonce or publish either receipt independently. The issuer cannot be the runner, admin setup credential, provider credential, payer, or reconciler. No unsigned or partially matching artifact has authority.

## Exact idempotency replay probes

After the condition in the execution-schedule section is met, the runner performs 20 replay probes serially in block order and lane table order. The sealed plan already contains one-based `replayTarget[block,lane]` in `[1,5]` generated only after all 100 context draws. The selected request is that lane/block's fresh call with the matching one-based call ordinal. Runtime execution consumes no randomness.

The replay authenticates with the current protocol credential and reproduces the committed non-secret request projection, including original mandate/branch/class/idempotency/body. Secret authorization, trace, timestamp, connection, and hop-by-hop headers may differ and are not part of the claim. It is never a retry of an unresolved or failed request. It must return the persisted response commitment and produce:

- no new Fuse execution or decision row;
- no new reservation or ledger mutation;
- no provider-cost delta;
- no mandate, branch, class, hourly, or daily accounting delta;
- no changed response commitment.

The database does not independently prove what packets reached the upstream provider. Accordingly, the protocol claims at most one durable dispatch authorization and no code path permitted to invoke the adapter twice; it claims no packet-level or crash-window invocation count without provider-side evidence.

If the selected request is not `completed_verified` or `reconciled_billed_with_response`, that replay endpoint fails. It is not replaced by another request.

Each replay obtains a protocol-wide database advisory mutex before its HTTP request. While held, no protocol fresh admission, completion, reconciliation, or accounting transition may start in any lane. Shadow-worker writes may continue but are outside the accounting assertion. The replay receives a unique operation ID, and database audit instrumentation records every insert/update/delete under that ID across `inference_executions`, `policy_decisions`, reservations, financial ledger, mandate/branch/class/hourly/daily accounting, dispatch tokens, and response commitments. Endpoint 5 requires an empty audited write set. Aggregate before/after counters alone are insufficient.

## Machine-checkable request and response contract

A fresh usable response is exactly HTTP 200 with JSON satisfying all of:

- non-empty string `id`, `object === "chat.completion"`, and `model === "nousresearch/hermes-4-405b"`;
- exactly one choice at index 0, `finish_reason === "stop"`, assistant role, and string content;
- non-negative safe-integer `prompt_tokens`, `completion_tokens`, and their exact sum in `total_tokens`;
- Fuse decision outcome/would-outcome `ALLOW`, `enforced === true`, no reason codes, matching branch/class scope, decimal reservation and actual cost, and actual cost not above reservation.

For each usable planned fresh request ID, authoritative replay requires exactly one execution row, one decision row, one `shadow_evaluation_queue` row with `state = 'completed'`, `attempts` in `[1,3]`, and exactly one `shadow_evaluations` row. The execution must have `status = 'completed'`, `shadow_order_state = 'queued'`, non-null cohort key/ordinal/completion time, non-null actual cost, and every sealed provider/model/mandate/branch/class/token/agent/policy/request-fingerprint dimension. Query scope is the exact sealed set of 100 request IDs and four mandate IDs; prefix or time-range matching is prohibited. Any missing, duplicate, extra, or differently scoped row fails.

The implementation persists `requestCommitment` before token creation and persists `responseCommitment` create-once on direct success or accepted state-5 recovery. Both use recursively key-sorted UTF-8 JSON with no insignificant whitespace:

1. `requestCommitment`: method, route, organization ID, credential ID, mandate ID, branch ID, workload class, idempotency key, and parsed request body. Authorization secrets and raw headers are excluded.
2. `responseCommitment`: the stable successful API projection defined above: `id`, `object`, `model`, choice, usage, decision, workload scope, reservation, and actual cost. The asynchronous `fuse.shadowEvaluation` field is excluded and is verified separately by settlement replay.

The replay invocation must present the same committed non-secret request projection. It need not prove byte-identical secret authorization headers. Replay success requires equality to the originally persisted response commitment; comparing a response only with itself is invalid.

## Operation deadlines

All deadlines use server/database `clock_timestamp()` for persisted observations and monotonic process timers for cancellation:

- provider adapter request, including response body: 60 seconds;
- runner-to-Fuse fresh HTTP operation, including complete body: 75 seconds;
- idempotency replay HTTP operation, including body: 15 seconds;
- each reconciliation GET, including headers and complete body: 30 seconds;
- each PostgreSQL connect/query/transaction and artifact operation: 30 seconds;
- every HTTP response body limit, including reconciliation: 1 MiB;
- ordinary block orchestrator excluding an ambiguity hold: 30 minutes;
- hard protocol finalization: `2026-07-28T09:30:00Z`.

HTTP and PostgreSQL timeouts must cancel or destroy the underlying stream/socket before terminal persistence. A reconciliation GET timeout destroys its stream/socket, appends a failed evidence attempt, leaves the request `reconciliation_pending`, and proceeds only at the next sealed lookup offset or, after the final offset, to cutoff classification; it is not a missed-window failure when its transaction started on time. An artifact-operation timeout must abort the runner without publishing `complete`, preserve the claim and write lock as a crash marker, and require operator inspection; it cannot be reported as a handled successful cancellation. A timeout after possible adapter dispatch enters `reconciliation_pending`; it is never redispatched. A timeout before durable dispatch proof is `not_dispatched`. Any operation still nonterminal at the hard finalization time fails the gate and produces an immutable incident.

## Provider outcome classification

HTTP status does not establish billing certainty. In particular, HTTP 502 is not evidence of no dispatch or no charge.

Every request appends immutable lifecycle events: `planned`, optional `admission_started`, optional `dispatch_authorized`, optional mutually exclusive `barrier_released` or `barrier_canceled_before_dispatch`, optional `dispatch_primitive_entered`, optional `ambiguity_entered`, optional `provider_evidence_attached`, and exactly one `gate_classified`. The current state is a projection of those events. States 1–7 below are terminal gate classifications. An ambiguous request instead enters nonterminal current state `reconciliation_pending`; it is not yet gate-classified. Its evidence cutoff is `ambiguity_entered_at + 86400 seconds`: accepted provider retrieval must begin before that instant. The cutoff-classification operation must start in `[ambiguity_entered_at + 86400 seconds, ambiguity_entered_at + 86401 seconds)` and complete within its 30-second database-operation deadline, hence before `ambiguity_entered_at + 86431 seconds`. `reconciliation_pending` may transition exactly once to terminal state 4, 5, or 6 through accepted post-ambiguity evidence; terminal state 3 is reachable only through the pre-ambiguity operation below; otherwise cutoff finalization assigns terminal state 7, `unresolved_provider_outcome`. Later provider-cost evidence updates a separate reconciliation ledger but cannot rewrite the protocol classification, replay report, or pass/fail result.

1. `not_dispatched` — durable local evidence proves the adapter never crossed dispatch.
2. `completed_verified` — response, exact model, usage/cost, response commitment, and available provider reference are authoritative.
3. `terminal_rejected_not_billed` — provider evidence proves rejection before billable execution.
4. `reconciled_not_billed` — immutable provider-side evidence proves no charge.
5. `reconciled_billed_with_response` — provider evidence, response, and cost permit normal completion and shadow evaluation.
6. `reconciled_billed_no_response` — cost is known but no behavioral observation exists.
7. `unresolved_provider_outcome` — neither billing nor response truth is established.

Any exception after possible dispatch defaults to `reconciliation_pending` regardless of 429/500/502/timeout text. Reconciliation requires immutable provider-side evidence and an external reference, not operator belief. Fast reconciliation does not erase ambiguity incidence. State 6 is never a completed behavioral observation.

Before adapter code can run, a compare-and-set creates one durable `dispatch_authorized` token for that planned request. No code path may invoke the adapter without owning that token, and the token can never be reacquired. The token proves authorization/intention, not whether a crash-window network invocation crossed the process boundary. Such a crash remains ambiguous unless provider evidence resolves it; the protocol makes no stronger invocation-count claim.

For the matrix's token-owning `not_dispatched` subtype, pre-dispatch proof is exactly one of: (a) a handled connector failure emitted before the instrumented adapter calls the HTTP dispatch primitive, or (b) for a burst token only, immutable `barrier_canceled_before_dispatch` written under the control-row lock by either the barrier decision or global-failure transaction. Both require no `dispatch_primitive_entered`; case (b) additionally requires no `barrier_released`. Mere absence after crash is not proof and remains `reconciliation_pending`. No unresolved request is redispatched. Reusing a Fuse idempotency key is insufficient without a provider-side idempotency or authoritative lookup contract.

### Outcome-to-evidence matrix

Every planned ID has one protocol-attempt ledger row, even if mandatory global stop prevents admission. The exact authoritative mapping is:

| Final state | Required execution / decision | Cost | Shadow order / queue / evidence | Replay treatment |
|---|---|---|---|---|
| `not_dispatched` before admission or canceled after gate failure | 0 execution, 0 decision | 0 | null / 0 / 0 | ineligible |
| `not_dispatched` admission denial | 1 `denied` execution, 1 matching `DENY` decision | actual 0 | null / 0 / 0 | ineligible |
| `not_dispatched` after ALLOW but before adapter token | 1 `failed` execution, 1 matching `ALLOW` decision, 0 dispatch token | actual 0 | null / 0 / 0 | ineligible |
| `not_dispatched` after token but provably before network write | 1 `failed` execution, 1 matching `ALLOW` decision, 1 dispatch token plus exact pre-dispatch proof | actual 0 | null / 0 / 0 | ineligible |
| `completed_verified` | 1 `completed` execution, 1 matching `ALLOW` decision, 1 dispatch token | non-null actual | `queued` / 1 `completed` / 1 evidence | eligible |
| `terminal_rejected_not_billed` | 1 `failed` execution, 1 matching `ALLOW` decision, 1 dispatch token | actual 0 | null / 0 / 0 | ineligible |
| `reconciled_not_billed` | 1 `failed` execution, 1 matching `ALLOW` decision, 1 dispatch token | actual 0 | null / 0 / 0 | ineligible |
| `reconciled_billed_with_response` | 1 `completed` execution, 1 matching `ALLOW` decision, 1 dispatch token | non-null actual | `queued` / 1 `completed` / 1 evidence | eligible |
| `reconciled_billed_no_response` | 1 `failed` execution, 1 matching `ALLOW` decision, 1 dispatch token | non-null actual | null / 0 / 0 | ineligible |
| `unresolved_provider_outcome` at cutoff | 1 `reconciliation_hold` execution, 1 matching `ALLOW` decision, 1 dispatch token | nullable; full reservation remains exposure | null / 0 / 0 | ineligible |

Queue state means `shadow_evaluation_queue.state`; shadow order means `inference_executions.shadow_order_state`. `null` is required, not interchangeable with `not_applicable` or `failed`. Any unknown state, cardinality mismatch, evidence on a non-behavioral outcome, absent evidence on a usable outcome, or subtype inconsistent with immutable lifecycle events fails replay.

## Falsifiable co-primary endpoints

All endpoints are conjunctive:

1. **Usable outcomes:** at least 99 of the 100 planned fresh request IDs end as `completed_verified` or `reconciled_billed_with_response`, and each has the exact machine contract and known actual cost. Zero IDs end as state 1 `not_dispatched`.
2. **No unresolved outcome:** an ID with `dispatch_authorized` and no `ambiguity_entered` must leave `executing` by `admission_started_at + 75 seconds`; an ID with `ambiguity_entered` must leave `reconciliation_pending` through exactly one terminal gate classification by `ambiguity_entered_at + 86431 seconds`, using only retrieval initiated before the `+86400` evidence cutoff, and terminal state 7 always fails this endpoint. IDs without a token must already be terminal `not_dispatched` by their admission-operation or scheduled-start deadline.
3. **Ambiguity incidence:** the reported count must equal the number of distinct planned IDs with an immutable `ambiguity_entered` event. Reconciliation cannot delete or decrement it.
4. **Exactly-once Fuse truth:** all 100 planned IDs have exactly one protocol-attempt row and one gate classification. Execution/decision/token cardinality must match the outcome matrix; each ID has at most one dispatch-authorization token and no code path may invoke the adapter twice. There are no unplanned or duplicate IDs. Crash-window external invocation remains explicitly unknowable.
5. **Replay integrity:** all 20 selected idempotency probes match the originally persisted stable response commitment and have an empty request-scoped replay write set as defined below.
6. **Evidence durability:** every final classification exactly matches the outcome-to-evidence matrix; no `where applicable`, unknown, or operator-selected non-applicability exists.
7. **Artifact terminalization:** the exact artifact inventory below exists, all terminal artifacts are immutable, and the create-only overall replay report is bound to exact plan, setup, execution, schedule, snapshot, manifest, and replay fingerprints.
8. **Cost boundary:** effective exposure never exceeds the separately authorized cap. A pass report requires no unresolved provider cost. A failure report is still published after cutoff classification with unresolved reservation exposure retained in the separate reconciliation ledger.

One terminal state 3, 4, or 6 consumes the sole non-usable allowance. A second such outcome makes endpoint 1 impossible and triggers mandatory global failure stopping. State 1 is never covered by that allowance and triggers immediate failure. Any request terminally classified as state 7 fails endpoint 2 regardless of usable count.

## Accepted reconciliation evidence and mapping

The only accepted provider evidence is account-authenticated OpenRouter JSON fetched by the protocol reconciler from both `GET /api/v1/generation?id=<generation-id>` and `GET /api/v1/generation/content?id=<generation-id>` on every scheduled attempt and on the explicitly triggered pre-ambiguity attempt below. The reconciler persists exact response bytes, SHA-256, HTTP status, retrieval database timestamp, generation ID, and the credential ID used.

Lookup offsets from immutable `ambiguity_entered_at` are `0, 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 64800, 86300` seconds. Each scheduled attempt operation starts in `[ambiguity_entered_at + offset, ambiguity_entered_at + offset + 1 second)` and has a 55-second whole-operation deadline through durable classification-or-attempt persistence. Inside that bound it launches both authorized GETs concurrently with 30-second complete-body deadlines, allows at most 5 seconds total for parsing, schema validation, canonicalization, and hashing, at most 15 seconds for the evidence-persistence transaction, and at most 5 seconds total for all remaining transitions and scheduling overhead. Missing any phase or whole-operation deadline is an irreversible reconciliation-schedule failure. Thus the last retrieval and persistence complete before `ambiguity_entered_at + 86356 seconds`, leaving more than 44 seconds before the `+86400` evidence cutoff. Polling stops after terminal classification; each later planned offset is durably marked `canceled_terminal`, never silently omitted.

Required metadata paths are `data.id`, `data.request_id`, `data.model`, `data.provider_name`, `data.created_at`, `data.cancelled`, `data.finish_reason`, `data.native_finish_reason`, `data.native_tokens_prompt`, `data.native_tokens_completion`, `data.tokens_prompt`, `data.tokens_completion`, `data.total_cost`, `data.usage`, `data.upstream_id`, `data.router`, and `data.provider_responses`; nullable paths must be present. Predicates are: `data.id` equals the pre-bound generation ID; `data.request_id` equals the pre-bound OpenRouter request ID when one was returned and otherwise is a non-empty string made immutable on first evidence; `data.model` equals `nousresearch/hermes-4-405b`; `data.provider_name` and `data.upstream_id` are non-empty strings; `data.router` is null or a non-empty string; `data.provider_responses` is null or an array; those last four values are byte-equal across all evidence; `data.cancelled` is boolean; finish-reason fields are null or strings; token counts are non-negative integers or null and native/non-native pairs agree when both non-null; `data.total_cost` and `data.usage` are finite non-negative decimals with equal USD-micros conversion; and `data.created_at` is within 300 seconds before dispatch-token time through 300 seconds after ambiguity time. Any failed predicate is conflicting evidence.

For state-5 response recovery, content must have exact paths `data.input.messages`, `data.output.completion`, and `data.output.reasoning`; prompt-form input is rejected, `data.input.messages` must recursively canonicalize byte-equal to the immutable original parsed request body's `messages`, `data.output.completion` must be a string, and `data.output.reasoning` must be null. The reconciler first rebuilds `requestCommitment` from the immutable pre-token local method, route, organization, credential, mandate, branch, class, idempotency key, and original parsed body, then requires its SHA-256 to equal the sealed request commitment. It then constructs exactly one recovered stable response projection: provider fields are `id = metadata.data.id`, `object = "chat.completion"`, `model = metadata.data.model`, choice index 0 with assistant role, `content = content.data.output.completion`, and `finish_reason = metadata.data.finish_reason`; usage is `prompt_tokens = metadata.data.tokens_prompt`, `completion_tokens = metadata.data.tokens_completion`, and their integer sum; Fuse decision, workload scope, and reservation come from the single immutable local ALLOW decision bound to that dispatch token; actual cost is the USD-micros conversion of `metadata.data.total_cost`. Every field must satisfy the fresh-response contract. The recursively canonical SHA-256 of that exact projection becomes the create-once recovered `responseCommitment`; any preexisting different response commitment is conflicting evidence. No provider-content field is treated as supplying a Fuse-only field.

The generation ID must already be bound to the Fuse request by the original provider response or a durable pre-error provider reference. Evidence discovered only by time-range searching is insufficient. HTTP error text, operator notes, dashboard screenshots, aggregate activity, or support belief never classify an outcome.

A pre-ambiguity state-3 attempt is triggered only by a synchronous non-2xx envelope carrying that pre-bound generation ID. If `errorReceivedAt <= admission_started_at + 19 seconds`, the reconciler starts both authorized GETs in `[errorReceivedAt, errorReceivedAt + 1 second)` under the same reconciliation authorization and applies the same 55-second whole-operation and 30/5/15/5-second phase bounds above; the operation durably ends with either terminal state 3 or `ambiguity_entered` before `admission_started_at + 75 seconds`. If the envelope arrives later, the pre-ambiguity attempt is skipped and `ambiguity_entered` is persisted directly before that 75-second deadline. This is the only lookup permitted before ambiguity; it consumes no scheduled offset.

For valid positive-cost metadata, content disposition is exact. HTTP 200 with valid input, null reasoning, and string completion satisfying reconstruction classifies state 5 immediately. Before the final offset, HTTP 200 with valid input and null completion, or HTTP 404 with a JSON object containing non-empty string `error.message` and no `data`, remains `reconciliation_pending`. At the final offset only, either of those two forms classifies state 6. A GET timeout, network failure, HTTP 408/429/5xx, non-JSON body, oversized body, any other status, malformed schema, non-null reasoning, or input mismatch remains `reconciliation_pending` and becomes terminal state 7 at cutoff absent later accepted evidence. HTTP 401 or 403 is reconciliation-credential drift and triggers immediate global failure rather than an outcome classification. These rules take precedence over generic HTTP or content wording elsewhere.

Deterministic mapping is:

- state 3 only when the synchronous non-2xx OpenRouter error envelope carries the pre-bound generation ID, both authorized GETs complete without timeout or credential-drift status, and metadata has `data.cancelled = true` and `data.total_cost = data.usage = 0`, all inside that same 75-second fresh operation before any `ambiguity_entered` event;
- prior ambiguity plus that same completed-GET canceled zero-cost evidence → state 4;
- matching metadata with `data.cancelled = false`, positive equal cost fields, non-null native/non-native token pairs, `data.finish_reason = "stop"`, exact pinned model/route, and content satisfying the complete reconstruction algorithm above → state 5;
- metadata satisfying every positive-cost metadata predicate in the state-5 bullet plus either exact state-6 content form at the final scheduled offset → state 6;
- missing ID, missing required field, contradictory cost/cancellation/status/model, mismatched input messages, conflicting evidence responses, malformed present content, or unavailable metadata leaves the request `reconciliation_pending`; if no later accepted evidence resolves it, cutoff finalization assigns terminal state 7.

The reconciler uses a named service credential with only `reliability:reconcile`. Its create-only authorization is canonical key-sorted JSON signed by a separate Ed25519 issuer holding `evidence:authorize-reconciliation` whose public key and credential ID are merged in the reviewed implementation. Signed fields bind reconciler credential/actor, run/plan/executable identities, exact two OpenRouter endpoints, required schema fields and mapping version, lookup offsets, and expiry `2026-07-28T09:30:00Z`. The verifier checks signature, issuer capability, actor separation, field equality, and database time before each lookup. Operator, runner, admin, provider, payer, and spend-authorizer identities cannot issue or act as reconciler. Classification is automated from the mapping above; no actor chooses a state. Every attempt/conflict is append-only audited. Evidence outside the matrix remains unresolved. This authorization permits evidence retrieval/classification only, never dispatch, payment, or gate-result rewriting.

## Ambiguity pause and mechanical resume

Every lifecycle transaction for an active single-flight member or released burst member that can enter ambiguity or terminal state first locks protocol control and then that lane's row, re-reads the member projection and current hold membership after both locks, and performs the transition before unlocking. The first such transaction that enters ambiguity and finds no hold creates `held_unresolved` while holding both locks. For a single-flight lane, the set contains that execution. For a burst lane, it snapshots every released member in the current five-request group whose re-read projection is nonterminal, keyed and sorted by sealed `(block, call ordinal)`; members already terminal before lock acquisition are excluded. A concurrent first ambiguity waits, re-reads the existing hold, and transitions its already-snapshotted member in place. A concurrent state-2/state-3 terminalization either commits first and is excluded by the creator's re-read, or commits second and removes its snapshotted member in the same locked transaction. Thus no stale or omitted member and exactly one hold creator are possible. Each member records `ordinary_inflight` or `reconciliation_pending`; an ambiguous member also carries its evidence cutoff and classification deadline. The lane is held while this set is non-empty. Every nominal block orchestrator still launches in its fixed window and appends that lane's not-yet-started planned IDs to a separate durable FIFO keyed by `(block, call ordinal)`. Unheld lanes execute normally. A held lane performs no fresh dispatch or replay.

An `ordinary_inflight` held member leaves the set through an accepted state-2 terminal classification, or through pre-ambiguity state 3 using the allowance transaction described here, or changes in place to `reconciliation_pending` on ambiguity. The reconciler classifies each ambiguous held member independently under the evidence matrix and authorization above. State 5 removes that member as usable. State 4 or 6 claims the run-level non-usable allowance if unclaimed and removes that member; if the allowance was already claimed by any state 3, 4, or 6, the same transaction persists the new terminal classification, removes that member, and triggers global failure. Pre-ambiguity state 3 uses that same control lock and either claims the allowance or persists state 3 while triggering global failure when already claimed. State 7 is persisted and triggers global failure in the same transaction. State 3 is unreachable after a request's own ambiguity and is never a `reconciliation_pending` resolution. These updates lock protocol control before lane state, so concurrent resolutions have one database commit order, one exact allowance owner, and no premature resume. The lane remains held until every member has left `held_unresolved` or global failure occurs.

When the transaction removing the final held member commits before all applicable cutoffs/deadlines:

- define `r` as the integer Unix epoch second of that final-removal database timestamp; resume time is `300 × (floor(r / 300) + 1)`, so resolution exactly on a five-minute boundary waits until the next boundary;
- one exclusive resumed worker drains the FIFO oldest block first. Group 0 starts at `resumeTime`; each later group's scheduled start is exactly `previousGroupTerminalDatabaseTime + 60 seconds`. A nominal block opening at the same instant only appends and cannot bypass backlog;
- within each resumed group, the lane applies its original mode: sequential/restart call 1 starts at group start and later calls at prior terminal +5 seconds; burst admissions/barrier start at group start. Every admission retains the one-second half-open start interval;
- remaining calls retain original IDs, order, block membership, and parameters;
- the report records each held member, nominal time, actual time, pause duration, evidence reference, classification commit order, allowance disposition, and resolution actor.

This is a preregistered mechanical resume, not a replacement block. If any held member has no accepted resolution persisted by its `ambiguity_entered_at + 86431 seconds` deadline from retrieval initiated before its `+86400` evidence cutoff, endpoint 2 is irreversibly failed and the mandatory global-stop rule applies. No unresolved call is resent.

## Shadow settlement rule

After each usable call, only the product's normal bounded shadow worker may retry. After the last planned fresh call and replay probe are terminal, replay opens a database transaction and records `settlementStartedAt = clock_timestamp()`; `settlementDeadline = settlementStartedAt + interval '120 seconds'`. It schedules 25 read-only polls at offsets `0, 5, 10, …, 120` seconds using a monotonic timer. Each poll starts one `REPEATABLE READ, READ ONLY` transaction, records scheduled offset plus database query start/end timestamps, and evaluates a snapshot fixed at transaction start.

A poll is deadline-eligible only when its database transaction starts at or before `settlementDeadline`; the final offset-120 snapshot is inclusive. A query that starts after the deadline cannot pass even if it sees complete evidence. Each poll retains the 30-second database-operation deadline, but its snapshot answers only whether coverage existed by its recorded start time.

The gate accepts the first eligible snapshot with the exact row cardinalities and states defined above. Otherwise settlement fails. The report records every poll, queue state/count, retry count, cohort ordinal, and evidence count. The protocol runner cannot manually retry, mutate, or repair a shadow job.

## Statistical diagnostics

These diagnostics do not control the gate:

- usable, ambiguous, resolved, unresolved, and non-usable counts by lane and block;
- provider/HTTP latency and actual cost by lane and block;
- pause and reconciliation durations;
- shadow settlement and retry counts;
- idempotency replay latency and accounting deltas;
- shadow queue/evidence existence and timing only; evaluator signal values remain embargoed as defined above.

For `s` usable outcomes in `n = 100`, report the one-sided 95% Clopper–Pearson lower bound: `0` when `s = 0`, otherwise `BetaInv(0.05; s, n-s+1)`. For `u` outcomes unresolved at their cutoff-classification deadline, report the upper bound: `1` when `u = n`, otherwise `BetaInv(0.95; u+1, n-u)`. Full precision controls computation; six-decimal display rounding controls nothing.

These bounds are emitted only if all 100 planned IDs have immutable `admission_started` events and none is `canceled_after_gate_failure`. Final classifications assigned to unstarted IDs after mandatory stop do not make them observed trials. Every early-stop report emits counts and block/lane positions but no binomial bound.

Under an exchangeable-binomial interpretation only, 99/100 gives an approximately 95.34% usable lower bound and 0/100 gives an approximately 2.95% unresolved upper bound. Block correlation prevents provider-wide rate claims.

## Cost authorization boundary

Before provider initialization, separate explicit authorization must pin:

- `openrouter`, requested model `nousresearch/hermes-4-405b`, `provider.allow_fallbacks = false`, and the bounded returned-metadata claim above;
- exactly 100 planned fresh IDs, at most 100 dispatch tokens, and 20 expected no-dispatch replays;
- a durable pre-adapter hard fence that rejects any token which would make the protocol token count exceed 100; replay code has no authority to consume that fence;
- the four exact context ranges, `maxOutputTokens = 8`, and per-call maxima `10000`/`50000` USD-micros;
- known-cost cap `3000000` and simultaneous unresolved-exposure cap `320000` USD-micros;
- the five fixed block windows and four isolated mandates;
- deliberate paid fault injection is prohibited and cannot be added by operator authorization; it requires a separately preregistered protocol.

Effective exposure is:

```text
completed actual cost
+ reconciled billed-no-response cost
+ other known terminal billed cost
+ sum(reserved maximum for every unresolved dispatch)
```

Known completed cost alone is insufficient while unresolved exposure exists. Any provider fallback, model substitution, extra diagnostic call, or later selectivity run requires a new protocol version and separate authorization.

## Stopping and failure rules

- No early success and no operator-selectable continuation.
- Before an irreversible gate failure, every unheld lane must continue every sealed call at its fixed or mechanical-resume time.
- At the first irreversible failure, one transaction locks the protocol control row and compare-and-sets `active → failed`, assigning a one-based failure sequence and database timestamp. Every dispatch-token transaction locks the same row before token creation. A non-burst token committed before failure, or a burst token with `barrier_released` committed before failure, remains authorized and its owner may finish or cross the adapter boundary. A burst token lacking `barrier_released` is atomically marked `barrier_canceled_before_dispatch` by that global-failure transaction before it unlocks and becomes token-owning `not_dispatched`; no token can commit after failure. Prepared/admitted calls without a token become `not_dispatched`, all future block claims are rejected, and no additional authorization occurs. This lock order is the mandatory stop boundary; wall-clock ordering outside it is not used.
- Irreversible triggers are: a second terminal outcome among states 3, 4, and 6; any terminal state-7 classification; `not_dispatched`; missed admission/block/reconciliation schedule; plan/setup/provider/model/executable drift; replay-integrity failure; cost/exposure breach; artifact conflict; or hard-finalization deadline.
- No replacement call/block, seed change, provider reroute, model switch, favorable reschedule, or paid diagnostic continuation is permitted.
- One terminal state 3, 4, or 6 is not yet irreversible; all remaining sealed calls continue. A second triggers mandatory global stop.
- Ambiguity follows the fixed `+86400` evidence cutoff and `+86431` classification deadline. Unheld lanes continue only while aggregate effective exposure remains within the sealed cap; exceeding it is an irreversible cost failure.
- Crash recovery resumes the same plan, request IDs, and durable lane state. A new run ID is a new experiment.
- HTTP 402 is an irreversible fail-closed outcome. There is no payment execution path.
- Preserve claims, locks, manifests, attempts, executions, queue records, accounting, and incident evidence. Partial counts after mandatory stop are descriptive only and receive no binomial interval.

## Mandatory no-spend fault matrix

Before beacon retrieval or paid authorization, deterministic provider-stub/database tests must prove 100% expected state, dispatch count, cost treatment, mandate isolation, and artifact recovery for:

- connect failure before dispatch;
- timeout after possible dispatch but before headers;
- provider/intermediary 429, 500, and 502;
- truncated, oversized, malformed, and model-mismatched responses;
- valid response with missing or invalid provider cost;
- database failure after provider response;
- interruption after admission, after dispatch receipt, after hold persistence, during attempt persistence, and during terminal publication;
- duplicate/concurrent submission of one request ID plus a second run proving run-ID-derived IDs cannot collide with the first run's 100 sealed IDs;
- every content disposition case: HTTP 200 string/null, exact HTTP 404 error form, 401/403, 408/429/5xx, timeout/network failure, malformed/non-JSON/oversized body, input mismatch, and final-offset versus earlier-offset precedence;
- an exhaustive generated bounded-burst model over all 32 identity-specific token subsets of the five planned IDs and every feasible serialization of token commits, admission failure, barrier-lock acquisition/release, and global-failure-lock acquisition consistent with transaction dependencies. For every serialization it must assert: no token commits after `active → failed`; adapter entry occurs iff that ID has `barrier_released`; every existing unreleased token receives exactly one `barrier_canceled_before_dispatch`; every ID reaches the exact matrix classification and execution/decision/token cardinality; released reservations and retained unresolved exposure are exact; and no state, event, token, cost, or exposure row is omitted or duplicated;
- all seven terminal outcome classifications, nonterminal `reconciliation_pending`, the early/late synchronous-error pre-ambiguity branch, every reconciliation resolution, every 55-second phase/whole-operation timeout, and the `+86400`/`+86431` cutoff boundary;
- all four valid/invalid operator × reconciliation authorization table rows plus absent, mismatched, and expired variants, asserting exact decision/receipt statuses, signed-artifact inventory, nonce consumed only in the valid/valid row, and zero block claims/provider calls on every failure;
- authorization crash injection before decision commit, after verdict/nonce commit, before and after each receipt publication, at every phase deadline, and during recovery, asserting one immutable decision, byte-identical outbox receipts, exact nonce disposition, active/failed control, and no admission before the complete valid pair;
- every subset of the five released burst requests entering `reconciliation_pending` and every feasible classification commit ordering over ambiguous states 4, 5, 6, and 7 interleaved with ordinary sibling state 2 and pre-ambiguity state 3, both with and without a prior state-3 allowance owner, asserting exact held-set membership, no resume while non-empty, final-member resume timing, FIFO preservation, allowance ownership, exposure, and global failure;
- barrier-controlled first-hold races that pause the creator after its candidate-member re-read while a sibling attempts state 2, state 3, or ambiguity entry, with creator-first and sibling-first acquisition scenarios; assert the mandated control→lane lock order, blocked conflicting commit, post-lock re-read, no stale/omitted member, exactly one hold creation, and deterministic resume/failure;
- unresolved exposure at the cap;
- one held lane while independent mandates continue;
- exact mechanical resume after resolution;
- shadow queue failure, bounded retry, and settlement timeout;
- exact idempotency replay with zero execution/accounting delta;
- preexisting artifact, orphan lock, and concurrent terminal writer.

The live run may observe no ambiguity, so passing live calls cannot substitute for this matrix.

## Artifact separation and lifecycle

Protocol-v2 artifacts use:

```text
evidence/held-out-reliability/protocols/held-out-reliability-v2.json
evidence/held-out-reliability/beacons/drand-6315000.json
evidence/held-out-reliability/plans/<plan-fingerprint>.json
evidence/held-out-reliability/authorizations/operator/<run-id>.json
evidence/held-out-reliability/authorizations/reconciliation/<run-id>.json
evidence/held-out-reliability/authorization-receipts/operator/<run-id>.json
evidence/held-out-reliability/authorization-receipts/reconciliation/<run-id>.json
evidence/held-out-reliability/manifests/<run-id>/<lane>-<block>.json
evidence/held-out-reliability/replay/<run-id>.json
evidence/held-out-reliability/incidents/<run-id>/<event-sequence>-<event-type>.json
```

The terminal inventory always contains one protocol receipt, one beacon, one plan, one operator-authorization receipt, one reconciliation-authorization receipt, four lane claims, all 20 lane/block manifests, and one overall replay report. Each receipt is create-only and contains status, database validation time, expected signed-field fingerprint, presented-artifact SHA-256 or null, credential/issuer IDs or null, and an exact reason code. A passing run requires the operator receipt status `consumed`, reconciliation receipt status `validated`, and both corresponding signed authorization artifacts. Every terminal receipt pair must match the four-row table above or the exact two-receipt `readiness_failed` case. For any authorization failure, each corresponding signed artifact is present only when bytes were actually presented before readiness start; an otherwise missing signed-artifact path is the sole permitted conditional omission. Mandatory global stop, including authorization-readiness failure before any block claim, creates terminal `canceled_after_gate_failure` lane claims and manifests for every unstarted lane/block without creating execution rows.

Every ambiguity entry, timeout, artifact conflict, orphan lock, reconciliation conflict, and overall non-pass appends one incident event under a transactionally allocated one-based sequence. Its create-only filename carries that sequence and fixed event type. Incident count and ordering must equal the immutable incident event log. A passing run with no incidents has no incident directory entries; a passing reconciled-ambiguity run has its ambiguity event records. On clean terminalization all `.write-lock` files must be absent. An orphan-lock failure requires the exact remaining lock paths in its incident/report and those locks are allowed extras. Any other missing or extra run-scoped artifact fails endpoint 7.

Every artifact carries `evidenceType: "held-out-reliability"`, `protocolVersion: 2`, protocol preregistration merge commit, implementation merge commit/tree/review digest/build digest, runtime image digest, migration/schema fingerprint, runner/adapter source digests, beacon round/chain, plan fingerprint, exact provider/model, schedule identity, configuration fingerprint/status, and authoritative setup fingerprint/source. Pooling with any other evidence type is rejected.

Beacon/plan publication uses recoverable exact-content write-once pairing. Each lane has a durable claim at `evidence/.run-claims/held-out-reliability/<run-id>/<lane>.claim`; each lane/block manifest uses the existing adjacent `.write-lock`. Manifests replace only the current incremental state while durably preserving every materialized attempt; the protocol does not claim an append-only byte history of every prior manifest version. Terminal lane/block manifests are immutable, and orphan locks remain crash markers.

Reliability-specific lane state may be `held` only while its durable `held_unresolved` set contains at least one authoritative unresolved execution. Exact membership, sealed order, and lifecycle state are mandatory manifest fields; each `reconciliation_pending` member additionally carries its own `+86400` evidence cutoff and `+86431` classification deadline. `held` is nonterminal and cannot pass replay. Terminal-classification transactions may remove members one at a time; the lane transitions to resumed only when the set is empty and protocol control remains active, or to terminal failure when control is failed.

The canonical create-only replay report is the commit marker and sole pass/fail authority. It is bound to the run ID, plan/configuration/setup fingerprints, SHA-256 digest of every terminal lane/block manifest, settlement poll journal, and a SHA-256 digest over key-sorted canonical rows from one declared final `REPEATABLE READ, READ ONLY` database snapshot. A replay report cannot be replaced or regenerated with different bytes.

Publication uses synced temporary files, file sync, exact-content hard-link/create-only destination publication, and containing-directory sync. Recovery may accept an existing byte-identical artifact and complete missing later members; any conflicting bytes fail closed. A crash before the replay report leaves the bundle uncommitted and non-passing even when individual manifests exist. The finalizer must attempt a failure report within 60 seconds of an irreversible event or cutoff-classification deadline and a pass report within 60 seconds of successful settlement; artifact timeout/orphan lock remains authoritative non-pass evidence if report publication cannot complete.

Any non-pass, incomplete schedule, ambiguity, timeout, orphan lock, or artifact conflict requires a create-only incident record bound to the same identifiers, latest manifest digests, and authoritative execution references. Incident creation cannot mutate a terminal manifest or convert failure to pass.

## Authoritative replay trust boundary

Before dispatch, the runner verifies its deployed executable identity against the sealed implementation merge commit, Git tree, staged-review diff digest, build/runtime image digest, migration/schema fingerprint, and runner/adapter source digests recorded in the plan. It then verifies provider/model binding, complete policy/class configuration, isolated mandates, policy versions, agents, root/child branches, budgets, shadow thresholds, schedule, and cost cap against the sealed setup.

Replay independently verifies setup and every request dimension, dispatch receipt/counter, provider reference when available, decision linkage, request/response commitments, outcome classification, actual/reserved cost, accounting treatment, lane/block schedule, queue state, cohort ordinal, and shadow evidence. It proves replay probes created no additional Fuse execution or accounting mutation.

Lifecycle classification occurs before database access. Pending, ready-running, held, incomplete, orphaned, or schema-mismatched artifacts cannot pass the final gate. Reconciled billed-no-response executions remain non-behavioral failures and never enter future selectivity evidence.

## Implementation gate

Before beacon retrieval or provider traffic:

1. Add protocol-v2 schemas, BLS verification, rejection-sampling stream, and fixed-beacon golden tests.
2. Add validators for allocation, schedule, context draws, replay selection, fingerprints, unknown fields, tampering, pooling, protocol drift, and executable identity.
3. Add canonical request/response commitments, create-only replay/incident authority, final snapshot digest, and exact row-cardinality checks.
4. Add an auditable durable adapter-dispatch receipt/counter and precisely bound its claim; do not imply provider packet-level exactly-once without provider support.
5. Add isolated lane mandates, held/resume lifecycle, immutable reconciliation evidence, fixed evidence-cutoff/classification deadlines, exposure accounting, least-authority setup, and one-shot operator authorization.
6. Add idempotency replay tests proving exact response commitment and zero execution/accounting delta.
7. Implement and pass the complete no-spend fault matrix above.
8. Add authoritative replay tests for row counts, dimensions, classifications, duplicate rows, unresolved cost, schedule, queue/evidence state, settlement snapshots, report immutability, and timeout boundaries.
9. Verify protocol-v1 parsing and the fixed calibration fingerprint remain unchanged.
10. Run ordinary and protocol-v2 dry paths and prove zero paid calls.
11. Freeze the staged tree/diff and build digest; obtain independent protocol/statistical, security, and fail-closed lifecycle review using gpt-5.6-sol.
12. Merge implementation before round `6315000` is available. If missed, publicly amend to a later unavailable round before merge.
13. Record the preregistration and implementation merge identities in the plan, then retrieve and seal the beacon/plan only after every prior gate passes.
14. Review the exact plan, 100-dispatch estimate, unresolved exposure, and operator cap. Paid execution requires separate explicit authorization.

No item in this implementation gate authorizes beacon retrieval, provider traffic, payment, reconciliation judgment, or selectivity spend by itself.
