# Held-Out Provider-Path Reliability Protocol v3

Status: preregistration draft. This document authorizes no beacon retrieval, provider traffic, payment, reconciliation decision, or held-out claim. It becomes a valid preregistration only after public merge before the beacon availability time below.

## Replacement scope

Protocol v2 missed its preregistered beacon and launch windows without beginning a paid run. Protocol v3 is a new experiment, not a reschedule or continuation of v2.

Protocol v3 freezes the complete statistical, operational, evidence, reconciliation, replay, stopping, and cost semantics of `docs/held-out-reliability-protocol-v2.md` at commit `6c6ef80f909998af45576baa07e03733cd5d0950`, except for the explicit replacements in this document. If an inherited v2 field conflicts with this document, this document controls. No v2 beacon, plan, run ID, request ID, authorization, mandate, branch, artifact, or observation may be reused.

The replacement fields are:

- protocol version: `3`
- evidence type: `held-out-reliability-v3`
- randomness domain: `fuse-held-out-reliability-v3`
- request-ID domain: `fuse-held-out-reliability-v3-request`
- beacon round and availability
- authorization window
- five block launch windows
- authorization expiries
- mandate, policy, and branch expiries
- hard-finalization deadline
- artifact namespace

All sample sizes, lane order, context ranges, allocation, replay-target count, provider/model, no-fallback rule, cost caps, reconciliation offsets, endpoint definitions, outcome matrix, co-primary gates, no-spend fault matrix, and mandatory-stop semantics remain byte-for-byte equivalent to the inherited v2 specification.

## Randomness beacon

- source: drand default chained mainnet beacon
- chain hash: `8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce`
- public key: `868f005eb8e6e4ca0a47c8a77ceaa5309a47978a7c71bc5cce96366b5d7a569937c529eeda66c7293784a9402801af31`
- scheme: `pedersen-bls-chained`
- period: 30 seconds
- genesis time: `1595431050`
- round: `6338040`
- expected availability: `2026-08-01T08:17:00Z`
- endpoint: `https://api.drand.sh/public/6338040`

The expected availability is exactly `genesis + (round - 1) × 30 seconds`. No actor may query this round, a relay, cache, mirror, derived feed, or prediction service before this document is publicly merged. If public merge does not precede `2026-08-01T08:17:00Z`, this round is permanently invalid and protocol v3 cannot run. A later schedule requires protocol v4.

The deterministic stream is inherited from v2 with only the domain replacement:

```text
block(i) = SHA-256(
  "fuse-held-out-reliability-v3" ||
  hex_to_bytes(beacon.randomness) ||
  uint32_be(i)
)
```

The consumer order, rejection sampling, 100 context draws, and 20 replay-target draws are unchanged.

## Fixed authorization and launch schedule

Authorization readiness starts in the half-open interval:

```text
[2026-08-02T08:16:00Z, 2026-08-02T08:16:01Z)
```

Its inherited 55-second whole-operation deadline and phase limits are unchanged.

| Block | Orchestrator opens at | Launch deadline |
|---:|---|---|
| 1 | `2026-08-02T08:17:00Z` | `2026-08-02T08:22:00Z` |
| 2 | `2026-08-02T20:17:00Z` | `2026-08-02T20:22:00Z` |
| 3 | `2026-08-03T08:17:00Z` | `2026-08-03T08:22:00Z` |
| 4 | `2026-08-03T20:17:00Z` | `2026-08-03T20:22:00Z` |
| 5 | `2026-08-04T08:17:00Z` | `2026-08-04T08:22:00Z` |

Every interval remains half-open and database-time authoritative. There is no late claim, replacement block, favorable reschedule, or operator-selected continuation.

## Expiries and finalization

- operator authorization expiry: `2026-08-02T08:22:00Z`
- reconciliation authorization expiry: `2026-08-05T09:30:00Z`
- hard protocol finalization: `2026-08-05T09:30:00Z`
- every lane policy, mandate, root, and child expiry: `2026-08-05T10:30:00Z`

The finalization deadline preserves the inherited allowance for the final block, ambiguity evidence cutoff, cutoff classification, and report publication. The authority resources expire one hour after hard finalization.

## Isolation and artifacts

Protocol-v3 identifiers derive from protocol version 3 and a fresh immutable run ID. They must be disjoint from protocols v1 and v2. The implementation must reject any v1/v2 organization, request, credential, policy, mandate, branch, authorization nonce, plan, beacon, claim, manifest, settlement, replay, or incident coordinate.

Protocol-v3 artifacts use:

```text
evidence/held-out-reliability-v3/protocols/held-out-reliability-v3.json
evidence/held-out-reliability-v3/beacons/drand-6338040.json
evidence/held-out-reliability-v3/plans/<plan-fingerprint>.json
evidence/held-out-reliability-v3/authorizations/operator/<run-id>.json
evidence/held-out-reliability-v3/authorizations/reconciliation/<run-id>.json
evidence/held-out-reliability-v3/authorization-receipts/operator/<run-id>.json
evidence/held-out-reliability-v3/authorization-receipts/reconciliation/<run-id>.json
evidence/held-out-reliability-v3/manifests/<run-id>/<lane>-<block>.json
evidence/held-out-reliability-v3/replay/<run-id>.json
evidence/held-out-reliability-v3/incidents/<run-id>/<event-sequence>-<event-type>.json
```

No protocol-v2 artifact path may satisfy a protocol-v3 inventory requirement.

## Implementation and release gate

Before beacon retrieval or provider traffic:

1. Publicly merge this document before round `6338040` is available.
2. Implement protocol-v3 constants, types, validators, domains, artifact paths, setup identities, and golden tests without mutating protocol-v2 historical parsing.
3. Complete and pass every inherited v2 no-spend fault-matrix requirement against the v3 production path.
4. Run the guarded real unpooled PostgreSQL concurrency suite. A skipped guard is a blocker.
5. Freeze one exact staged candidate and obtain independent protocol/statistical, security, and fail-closed lifecycle approval.
6. Merge the reviewed implementation before beacon availability.
7. Only after all prior gates pass, retrieve and cryptographically verify round `6338040`, then seal one create-only beacon/plan pair.
8. Review the exact 100-dispatch estimate, unresolved-exposure bound, and operator cap.
9. Require separate explicit paid authorization. This preregistration does not supply it.

Any semantic implementation change beyond the explicit timing/version/namespace replacements above requires a public protocol amendment before beacon availability or a new protocol version. No item in this document authorizes spend.
