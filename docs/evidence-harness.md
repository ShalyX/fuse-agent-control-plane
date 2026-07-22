# Sibling-Divergence Evidence Harness

This harness generates a labeled execution manifest through the real authenticated Fuse HTTP path, handles a Circle x402 challenge when the target deployment presents one, then produces a report from authoritative execution rows and persisted shadow evidence.

It does **not** reconstruct cohorts, invent observations, or claim behavioral enforcement.

## Safety and trust boundaries

- `npm run evidence:fixtures:dry` performs no network or paid calls and requires no credentials.
- `npm run evidence:fixtures` performs real provider calls and Circle x402 payments. It currently plans 92 attempts across the ten fixtures.
- The administrative token is used only for setup. The one-time agent token is retained only in process memory and is never written to the manifest.
- Request IDs are headers. Strict API request bodies contain no `requestId`, `mandateId`, or other unknown fields.
- The runner registers the agent, issues the runtime credential, publishes the policy, creates the draft mandate, assigns the agent, creates **all** branches, and activates only after branch creation.
- Manifests and reports are written under `evidence/` with mode `0600`. Do not commit generated evidence blindly; inspect it first.

## Local no-spend verification

```bash
npm run evidence:fixtures:dry
npm test -- --run tests/evidenceHarness.test.ts
npm run check
```

The dry-run output must report:

```json
{
  "phase": "dry-run",
  "fixtures": ["10 scenario descriptors"],
  "paidCallsExecuted": 0
}
```

## Real fixture generation

Prerequisites:

- A running Fuse deployment with `FUSE_WORKLOAD_SHADOW_ENABLED=true`
- An active admin service-account token with `agents:write`, `credentials:issue`, `policies:write`, and `mandates:admin`
- Circle developer-controlled-wallet credentials and a funded Arc Testnet payer wallet **only if** the target deployment actually returns an x402 challenge. The current authenticated control-mode route normally executes without that challenge; Circle setup is lazy and unused in that case.
- Provider configuration for the organization and selected model

Keep values out of shell history where possible. Required environment variable names are:

```text
FUSE_ADMIN_TOKEN
CIRCLE_API_KEY
CIRCLE_ENTITY_SECRET
FUSE_PAYER_ADDRESS
FUSE_URL                  # optional; defaults to local :8787
FUSE_PROVIDER             # anthropic or openrouter; must match tenant configuration
FUSE_EVIDENCE_MODEL       # exact configured tenant model
ANTHROPIC_MODEL           # legacy fallback when FUSE_EVIDENCE_MODEL is unset
FUSE_EVIDENCE_RUN_ID       # optional; use a fresh ID per run
```

Run:

```bash
npm run evidence:fixtures
```

The runner writes incrementally to:

```text
evidence/fixtures/<run-id>.json
```

Incremental writes preserve completed attempt truth if a later paid call or expectation fails. A fixed mandate is intentionally not reused: a fresh run ID prevents stale policy, branch, budget, and idempotency state from contaminating evidence.

## Replay/report

Use the unpooled database URL and the generated manifest:

```bash
FUSE_EVIDENCE_MANIFEST="$PWD/evidence/fixtures/<run-id>.json" \
DATABASE_URL_UNPOOLED="..." \
npm run evidence:replay
```

The replay command:

1. Cross-checks persisted attempts against `inference_executions` status and exact atomic cost. Pre-execution model-binding denials, which intentionally have no execution row, are validated against the exact fixture contract and listed separately under `authoritativeCoverage.preExecutionDenials`.
2. Loads existing `shadow_evaluations.evidence` for those same request IDs.
3. Produces `evidence/replay/<run-id>.json`.

### Policy semantics

- **A — deterministic truth:** authoritative policy/ceiling outcomes already persisted in `inference_executions`. This is not counterfactual re-execution.
- **B — class-prior-only v1:** projects only persisted `CLASS_PRIOR_EXCEEDED` signals. Velocity, retry, and duplicate-output signals are not implemented and are not claimed.
- **C — branch-aware:** uses persisted `wouldSignalTarget`, `eligibleForIntervention`, signals, and immutable cohort ordinals. It does not fabricate parents, observations, or cohort membership.

The report includes coverage, hard denials, warnings, projected C interventions, false warnings from fixture labels, and spend before first signal. Missing shadow evidence is listed explicitly rather than silently treated as a negative signal.

`operatorRecoveryTime` and `actualBehavioralInterventions` are explicitly unavailable: the current evaluator is shadow-only and the harness contains no human operator timing experiment.

## Required scenarios

The call plan covers all ten spec scenarios, including real operating fan-out:

- runaway child with healthy siblings: `n=3`
- two legitimately unusual siblings: `n=2`
- correlated cohort shift: `n=4`
- sparse target with mature siblings: `n=4`
- mature target with sparse siblings: `n=3`

Fixture 10 uses a 15,000-atomic branch ceiling and larger requests so the deterministic budget should be reached after some spend within its ten attempts for the calibrated testnet model. The exact stopping attempt remains provider-price and tokenizer dependent, so the manifest records actual authoritative outcomes instead of hard-coding a fabricated call count.

## Decision boundary

This harness can generate controlled fixture evidence. It does not establish production efficacy or a moat. The decision remains:

> If C does not materially improve detection time or dollars-through at fan-out 2–4 without worsening false interventions, sibling divergence is not treated as the product moat.

Controlled fixture results and later held-out live-shadow results must be labeled separately.

## Controlled testnet run — 2026-07-22

The calibrated run `testnet-20260721-hermes4-v6` executed against the deployed Fuse HTTP control path with OpenRouter model `nousresearch/hermes-4-405b`:

- 92 authenticated attempts: 87 completed, 5 denied
- authoritative coverage: 91 persisted `inference_executions`; the model-binding denial occurred before execution persistence and is listed separately
- persisted shadow coverage: 87/87 completed attempts, with no missing evidence
- final-run provider cost: 32,441 USD-micros (`$0.032441`)
- cumulative cost across calibration and transient-failure runs: 196,701 USD-micros (`$0.196701`)
- no x402 challenge was returned on this authenticated control-mode route, so no Circle payment occurred

### Claim boundary

This run validates the authenticated policy/anomaly path, real provider-billed inference, provider-cost persistence, and authoritative replay. It did **not** exercise x402 challenge handling, Circle payment authorization/transfer, or the combined metered-payment-plus-policy path end to end. It is therefore evidence for the policy engine and provider-cost accounting—not evidence that the full Circle-backed payment integration behaves this way.

The deterministic gates behaved as intended: one unauthorized-class denial, one pre-execution model-binding denial, and three branch-budget denials after seven Fixture 10 completions.

In the controlled A/B/C replay, B and C each emitted 14 warnings with four false warnings. C additionally projected four interventions, all on the labeled Fixture 2 runaway child, and projected no intervention on legitimate fixtures. The first sibling-divergence signal arrived after 1,308 USD-micros of labeled runaway spend. This is controlled-fixture evidence of incremental intervention selectivity; it is not held-out live efficacy and does not by itself establish a moat.

### Why v3 and v5 are calibration, not pooled v6 replicates

Both were complete, real, paid 92-attempt runs, and they are retained in the calibration ledger rather than treated as nonexistent:

- `v3`: Fixture 2's healthy siblings used a different workload class from the runaway target, so persisted evaluation found zero comparable siblings. Its three-sibling intervention threshold was also unreachable at fan-out three.
- `v5`: workload class and threshold were corrected, but each healthy sibling still had only one observation, below cohort maturity. Persisted evaluation again found zero comparable siblings.
- `v4`: stopped after 82 attempts on a provider HTTP 502 and has no complete replay.
- `v6`: is the first run where the target and siblings share a class, both healthy siblings are mature, and the intervention threshold is reachable.

Accordingly, v3 and v5 are useful negative calibration findings, but pooling their intervention counts with v6 would mix materially different test configurations. A second comparison of deployed policy rows, branch rows, executions, and persisted signals found that the nine non-Fixture-2 scenarios had identical branch and execution shapes across v3/v5/v6. One global setting did change: `siblingMinimumForIntervention` was 3 in v3 and 2 in v5/v6. That setting only controls intervention eligibility; it does not enter `wouldSignalTarget`, and every false warning in these runs was an `insufficient_siblings` `CLASS_PRIOR_EXCEEDED` signal with `eligibleForIntervention: false`.

For the clean descriptive comparison, Fixture 2 is now excluded from both numerator and denominator. The same four false-warning positions recurred in each run—two in Fixture 3 and two in Fixture 8—yielding 12 false warnings across 192 identically shaped, labeled legitimate non-Fixture-2 completed evaluations (6.25%). This is still **not** an independent-sample estimate because the runs reused fixed scenarios. The prior 12/202 denominator included differently configured Fixture 2 healthy-sibling evaluations and is not used. The final v6 intervention result remains one calibrated run and should not be presented as a stable rate until the exact v6 configuration is repeated on fresh/held-out fixtures.

Committed evidence:

- `evidence/fixtures/testnet-20260721-hermes4-v6.json`
- `evidence/replay/testnet-20260721-hermes4-v6.json`
- `evidence/calibration/testnet-20260721-run-ledger.json`
