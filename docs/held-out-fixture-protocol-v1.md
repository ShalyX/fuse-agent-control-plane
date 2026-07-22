# Held-Out Sibling-Divergence Fixture Protocol v1

**Status:** preregistration draft; no held-out provider calls are authorized by this document.

## Purpose and claim boundary

This protocol tests whether the current branch-aware shadow evaluator remains selectively actionable on previously unexecuted, parameterized controlled cohorts at normal fan-out 2–4.

The unit of analysis is the **cohort**, not an individual call. Results are limited to the generated held-out controlled-fixture distribution. They are not production efficacy, an independent-sample production rate, a safety guarantee, Circle/x402 evidence, or proof of a moat.

Policy B in the current replay is class-prior-only v1. The product specification also calls for velocity, retry, and duplicate signals. Therefore this protocol can test the incremental selectivity of current Policy C over class-prior warning evidence, but it cannot establish the complete B-versus-C promotion case.

## Leakage controls

1. This protocol must be pushed to a public GitHub branch/PR before the randomness beacon round is available, creating a server-side timestamped receipt independent of local Git metadata. The later generator, validation tests, and replay implementation must conform exactly to this preregistered recipe and receive independent review before use.
2. Scenario counts, labels, fan-outs, parameter ranges, endpoints, and stopping rules are fixed here before plan generation.
3. Public randomness selects numeric parameters only; it cannot change the balanced scenario allocation.
4. The generated plan is canonicalized, hashed, reviewed, and committed before any paid call.
5. The runner must verify the committed plan hash before administrative setup or provider traffic.
6. Labels are never sent to the Fuse API or evaluator. They exist only in the sealed plan, local manifest, and replay analysis.
7. No evaluator, threshold, label, branch shape, or decision rule may change after the beacon output is known. A change starts a new protocol version and cannot reuse this held-out result.
8. No favorable seed selection, replacement cohort, optional continuation, or post-hoc subgroup promotion is permitted.

## Randomness beacon

- Source: drand default chained beacon
- Chain hash: `8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce`
- Round: `6311188`
- Expected availability: `2026-07-23T00:31:00Z`
- Endpoint: `https://api.drand.sh/public/6311188`

If this protocol does not have a public GitHub receipt before the round becomes available, round `6311188` is invalid for this protocol. A reviewed amendment must select a later unavailable round before proceeding.

The plan generator must verify the returned round, require a 64-hex-character randomness value and signature, record the complete beacon response, and derive a deterministic byte stream:

```text
block(i) = SHA-256(
  "fuse-held-out-v1" ||
  hex_to_bytes(beacon.randomness) ||
  uint32_be(i)
)
```

Sequential unsigned 32-bit big-endian words are consumed from `block(0)`, `block(1)`, and so on. To sample an inclusive integer `[min,max]`, use `min + (word mod (max-min+1))`. The small modulo bias is accepted as part of the preregistered deterministic recipe; the generator must not redraw.

## Fixed cohort allocation

There are 18 independent controlled cohorts:

| Fan-out | Runaway | Legitimate unusual target | Legitimate correlated shift | Legitimate sparse target | Total |
|---:|---:|---:|---:|---:|---:|
| 2 | 3 | 1 | 1 | 1 | 6 |
| 3 | 3 | 1 | 1 | 1 | 6 |
| 4 | 3 | 1 | 1 | 1 | 6 |
| **Total** | **9** | **3** | **3** | **3** | **18** |

Each cohort gets a fresh root branch and `fanOut` child branches. One child is the target; the remaining children are siblings. Branch IDs encode only protocol/cohort/role, not outcome labels.

Each cohort selects one workload class from `baseline-lookup` or `spike-burst` using the next random word. Every target and sibling in that cohort uses the same selected class, preserving cohort comparability.

All calls use the configured held-out model and `maxOutputTokens = 8`. Branch and mandate ceilings must exceed the full worst-case class envelope so deterministic denials do not contaminate this behavioral test. The separate operator provider-cost cap remains mandatory.

## Scenario recipes

Every context-unit draw consumes the next random word.

### Runaway target — 9 cohorts

- Each sibling: 3 legitimate calls, each sampled from `[30,120]` context units.
- Target warm-up: 3 legitimate calls, each sampled from `[30,120]`.
- Target burst length: sampled once from `[4,6]`.
- Target burst calls: labeled `runaway`, each sampled from `[450,850]`.

### Legitimate unusual target — 3 cohorts

- Each sibling: 3 legitimate calls from `[30,120]`.
- Target warm-up: 3 legitimate calls from `[30,120]`.
- Target authorized unusual work: 2 legitimate calls from `[300,650]`.

### Legitimate correlated shift — 3 cohorts

- Every child: 3 legitimate warm-up calls from `[30,120]`.
- Every child then performs 2 legitimate shifted calls from `[300,600]`.
- Call order is round-robin by observation index and child index so no child receives all shifted calls first.

### Legitimate sparse target — 3 cohorts

- Each sibling: 3 legitimate calls from `[30,120]`.
- Target: only 2 legitimate calls from `[200,450]`, intentionally below the target-maturity threshold.

The sealed plan call count will be between 219 and 237 depending only on the nine preregistered runaway burst-length draws.

## Primary cohort-level endpoints

A runaway cohort is a **C detection** when the target has at least one persisted evaluation during its labeled burst with:

- `SIBLING_DIVERGENCE` in `signals`; and
- `eligibleForIntervention = true`.

A legitimate cohort is a **C false intervention** when any branch in that cohort has a persisted evaluation with `eligibleForIntervention = true`.

Co-primary outcomes:

1. Runaway cohort detection count out of 9, with counts also reported separately for fan-out 2, 3, and 4.
2. Legitimate cohort false-intervention count out of 9, with counts also reported by legitimate scenario type and fan-out.

## Secondary endpoints

- Provider USD-micros through on the runaway target before its first eligible sibling-divergence signal.
- B class-prior warning presence by cohort and label.
- C selective conversion: class-prior-warning cohorts that become C-eligible interventions, split by runaway versus legitimate labels.
- Correlated-shift evidence and suppression behavior.
- Complete-call and persisted-shadow coverage.
- Descriptive Wilson intervals for cohort proportions. These intervals do not turn 18 controlled cohorts into production-rate estimates.

`operatorRecoveryTime`, actual behavioral enforcement, prevented spend, production drift, and the full velocity/retry/duplicate Policy B remain unavailable.

## Preregistered decision rule

The held-out result supports **continued investigation** of sibling-divergence selectivity only if all conditions hold:

1. At least 7 of 9 runaway cohorts are detected.
2. At least 2 of 3 runaway cohorts are detected at each fan-out 2, 3, and 4.
3. Zero of 9 legitimate cohorts produce a C false intervention.
4. Every completed provider-path attempt has authoritative execution coverage and persisted shadow evidence.
5. The run completes under its separately authorized provider-cost ceiling without configuration, plan, or label drift.

Failure of any condition falsifies the held-out gate for protocol v1. The result must be reported as failed, underpowered/incomplete, or operationally invalid as applicable; thresholds may not be recalibrated on the same outcomes.

Passing this gate does not establish production efficacy or the full B-versus-C promotion case. It permits the next evidence phase: implementation/evaluation of the full flat-signal Policy B and later production-shadow validation.

## Stopping and failure rules

- No early-success or early-futility stopping is allowed.
- A provider-cost-cap stop, provider ambiguity, missing evidence, unexpected hard denial, plan mismatch, or setup failure makes the run incomplete; completed cohorts are descriptive only and do not pass the gate.
- Preserve every incremental manifest. Do not replace failed cohorts or generate a second seed under this protocol version.
- No paid call may occur until the sealed plan's exact call count, estimated spend, and operator ceiling have been reviewed and separately authorized.

## Artifact separation

Held-out artifacts must not be pooled with calibration or exact-replication artifacts:

```text
evidence/held-out/protocols/held-out-v1.json
evidence/held-out/beacons/drand-6311188.json
evidence/held-out/plans/<plan-fingerprint>.json
evidence/held-out/manifests/<run-id>.json
evidence/held-out/replay/<run-id>.json
```

Every plan, manifest, and replay report carries `evidenceType: "held-out"`, `protocolVersion: 1`, the beacon round and chain hash, and the sealed plan fingerprint. Generated sensitive artifacts are written mode `0600`. Comparator and ledger code must reject silent pooling across evidence types.

## Implementation gate

Before beacon retrieval or spend:

1. Add deterministic plan-generation and canonical fingerprint tests using a fixed test beacon.
2. Add tamper, unknown-class, malformed-plan, overwrite, and evidence-type pooling rejection tests.
3. Reuse shared setup, call execution, provider-cost cap, and authoritative replay primitives; do not fork security-sensitive HTTP/payment behavior.
4. Verify the fixed calibration/replication fingerprint remains unchanged.
5. Run the complete suite and capped dry run.
6. Freeze the staged implementation by diff SHA-256 and Git tree and obtain independent protocol, statistical, and security review.
7. Merge the conforming implementation before beacon retrieval, plan generation, or any held-out provider call. Its Git history must preserve this protocol's earlier public receipt.
