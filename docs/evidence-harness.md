# Sibling-Divergence Evidence Harness

This harness generates a labeled execution manifest through the real authenticated Fuse HTTP path, handles a Circle x402 challenge when the target deployment presents one, then produces a report from authoritative execution rows and persisted shadow evidence.

It does **not** reconstruct cohorts, invent observations, or claim behavioral enforcement.

## Safety and trust boundaries

- `npm run evidence:fixtures:dry` performs no network or paid calls and requires no credentials.
- `npm run evidence:fixtures` performs real provider calls and makes a Circle x402 payment only when the target route actually returns a valid 402 challenge. It currently plans 92 attempts across the ten fixtures.
- Set `FUSE_EVIDENCE_PROVIDER_COST_CAP_ATOMIC` to a positive USD-micros ceiling for an operator-authorized run. Before every attempt, the runner reserves the configured workload class's maximum per-call cost against cumulative persisted provider cost and aborts before the call if the ceiling could be exceeded. This operational cap is recorded in the manifest but intentionally excluded from the fixture configuration fingerprint; a binding cap leaves the run incomplete.
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
FUSE_EVIDENCE_BASELINE_MANIFEST # optional; required for fingerprint-guarded replication
FUSE_EVIDENCE_PROVIDER_COST_CAP_ATOMIC # optional operator ceiling in USD micros
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

## Exact-configuration replication

Manifest schema v2 includes a SHA-256 configuration fingerprint over the run-independent provider/model binding, runtime capabilities, policy and shadow settings, mandate ceiling, complete branch authority tree, scenario descriptors, and all 92 call specifications. Run IDs, request IDs, mandate IDs, agent IDs, and timestamps are excluded.

The v6 baseline fingerprint is:

```text
sha256:797af3ef88a718744628f35b1a13bf64edb69caa7f7b868a01a075179c9a933d
```

Because v6 predates fingerprint support, its manifest labels this anchor `post-hoc-db-verified`: the canonical configuration was reconstructed from the exact harness revision and checked against the deployed policy, branch, execution, and shadow-evidence rows. Future manifests are labeled `pre-run-generated`. These provenance classes remain explicit and are never pooled silently.

Guard a dry run before any paid setup:

```bash
export FUSE_EVIDENCE_BASELINE_MANIFEST="$PWD/evidence/fixtures/testnet-20260721-hermes4-v6.json"
export FUSE_EVIDENCE_RUN_ID="<fresh-replication-id>"
npm run evidence:fixtures:dry
```

The command exits with `EVIDENCE_REPLICATION_CONFIGURATION_MISMATCH` before setup or provider traffic if any fingerprinted configuration differs. The v6 fingerprint is also frozen by a regression test; an intentional configuration change starts a new baseline series rather than rewriting v6. After reviewing the dry-run output, run `npm run evidence:fixtures`, replay the new manifest, then compare reports:

```bash
npm run evidence:compare -- \
  evidence/replay/testnet-20260721-hermes4-v6.json \
  evidence/replay/<fresh-replication-id>.json
```

The comparator requires a complete candidate report, complete persisted shadow coverage, the exact baseline fingerprint, and `replicationBaselineRunId` pointing to v6. It reports exact agreement separately for hard denials, C warnings, C false warnings, and projected C interventions; disagreement is evidence, not an automatic failure to hide.

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

## Controlled testnet baseline and exact replication — 2026-07-22

The calibrated baseline `testnet-20260721-hermes4-v6` and fresh exact-configuration replication `testnet-20260722-hermes4-v7` executed against the deployed Fuse HTTP control path with OpenRouter model `nousresearch/hermes-4-405b` and fingerprint `sha256:797af3ef88a718744628f35b1a13bf64edb69caa7f7b868a01a075179c9a933d`:

- each run had 92 authenticated attempts: 87 completed, 5 denied
- each replay had authoritative coverage of 91 persisted `inference_executions`; the model-binding denial occurred before execution persistence and is listed separately
- each run had persisted shadow coverage for all 87 completed attempts, with no missing evidence
- provider cost: v6 32,441 USD-micros (`$0.032441`); v7 32,609 USD-micros (`$0.032609`)
- v7 completed below its operator-authorized 100,000 USD-micros (`$0.10`) ceiling
- cumulative provider cost across calibration, transient-failure, baseline, and replication runs: 229,310 USD-micros (`$0.229310`)
- no x402 challenge was returned on this authenticated control-mode route, so no Circle payment occurred

The comparator found exact v6/v7 agreement for five hard denials, 14 Policy C warnings, four Policy C false warnings, and four projected Policy C interventions. This is one fresh repeat of the same fixed controlled fixtures—not held-out production efficacy or an independent-sample rate.

### Claim boundary

These runs validate the authenticated policy/anomaly path, real provider-billed inference, provider-cost persistence, and authoritative replay. They did **not** exercise x402 challenge handling, Circle payment authorization/transfer, or the combined metered-payment-plus-policy path end to end. They are therefore evidence for the policy engine and provider-cost accounting—not evidence that the full Circle-backed payment integration behaves this way.

The deterministic gates behaved identically in both runs: one unauthorized-class denial, one pre-execution model-binding denial, and three branch-budget denials after seven Fixture 10 completions.

In the controlled A/B/C replay, B and C each emitted 14 warnings with four false warnings. C additionally projected four interventions, all on the labeled Fixture 2 runaway child, and projected no intervention on legitimate fixtures. The first sibling-divergence signal arrived after 1,308 USD-micros of labeled runaway spend. This is controlled-fixture evidence of incremental intervention selectivity; it is not held-out live efficacy and does not by itself establish a moat.

### Why v3 and v5 are calibration, not pooled v6 replicates

Both were complete, real, paid 92-attempt runs, and they are retained in the calibration ledger rather than treated as nonexistent:

- `v3`: Fixture 2's healthy siblings used a different workload class from the runaway target, so persisted evaluation found zero comparable siblings. Its three-sibling intervention threshold was also unreachable at fan-out three.
- `v5`: workload class and threshold were corrected, but each healthy sibling still had only one observation, below cohort maturity. Persisted evaluation again found zero comparable siblings.
- `v4`: stopped after 82 attempts on a provider HTTP 502 and has no complete replay.
- `v6`: is the first run where the target and siblings share a class, both healthy siblings are mature, and the intervention threshold is reachable.

Accordingly, v3 and v5 are useful negative calibration findings, but pooling their intervention counts with v6 would mix materially different test configurations. A second comparison of deployed policy rows, branch rows, executions, and persisted signals found that the nine non-Fixture-2 scenarios had identical branch and execution shapes across v3/v5/v6. One global setting did change: `siblingMinimumForIntervention` was 3 in v3 and 2 in v5/v6. That setting only controls intervention eligibility; it does not enter `wouldSignalTarget`, and every false warning in these runs was an `insufficient_siblings` `CLASS_PRIOR_EXCEEDED` signal with `eligibleForIntervention: false`.

For the clean descriptive comparison, Fixture 2 is now excluded from both numerator and denominator. The same four false-warning positions recurred in each calibration run—two in Fixture 3 and two in Fixture 8—yielding 12 false warnings across 192 identically shaped, labeled legitimate non-Fixture-2 completed evaluations (6.25%). This is still **not** an independent-sample estimate because the runs reused fixed scenarios. The prior 12/202 denominator included differently configured Fixture 2 healthy-sibling evaluations and is not used. V7 now supplies one exact repeat of the fixed v6 configuration with the same headline outcome counts; two fixed-fixture runs still do not establish a stable production rate or held-out efficacy.

Committed evidence:

- `evidence/fixtures/testnet-20260721-hermes4-v6.json`
- `evidence/replay/testnet-20260721-hermes4-v6.json`
- `evidence/fixtures/testnet-20260722-hermes4-v7.json`
- `evidence/replay/testnet-20260722-hermes4-v7.json`
- `evidence/replication/testnet-20260721-hermes4-v6-comparison.json`
- `evidence/calibration/testnet-20260721-run-ledger.json`
