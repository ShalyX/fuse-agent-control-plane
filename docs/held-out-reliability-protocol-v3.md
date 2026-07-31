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

## Pre-beacon byte-identity amendment

Status: amendment draft. This section becomes binding only after public merge before round `6338040` is available. The merge commit containing this exact section is the amendment commit. It resolves byte-authoritative coordinates that the original preregistration left implicit. It changes no sample size, allocation, random-consumer order, provider/model, cost, outcome, reconciliation, replay, stopping, or statistical semantics. It authorizes no beacon retrieval, provider traffic, payment, or held-out claim.

### Source and executable identity

The executable plan retains both frozen source identities:

```text
preregistrationCommit = 0a29a7e63d3659c1c374f535aeac9da2ca2d4d69
inheritedV2Commit = 6c6ef80f909998af45576baa07e03733cd5d0950
```

It also carries `amendmentCommit`, the full 40-character commit containing this publicly merged amendment. The plan must carry these exact source records:

```text
{
  path,
  commit,
  gitBlob,
  sha256
}
```

The v2 record uses path `docs/held-out-reliability-protocol-v2.md` at `inheritedV2Commit`. The v3 record uses path `docs/held-out-reliability-protocol-v3.md` at `amendmentCommit`. `gitBlob` is the lowercase object ID returned for `<commit>:<path>`. `sha256` is `sha256:` followed by lowercase SHA-256 over the exact Git blob bytes, including their committed line endings and final-newline state. No checkout normalization is permitted. Plan creation and every pre-dispatch verification reject a missing or mismatched commit, path, blob ID, or SHA-256.

### Canonical JSON and complete protocol profile

`canonicalJson` means recursively key-sorted JSON, UTF-8 encoded without BOM, insignificant whitespace, or trailing newline. Arrays retain order. Strings use JSON escaping. Integers are base-10 JSON numbers. Protocol monetary values and timestamps remain strings exactly as preregistered. A SHA-256 value is always `sha256:` followed by 64 lowercase hexadecimal characters.

The durable profile projection is exactly the following canonical JSON object, with no additional or omitted key:

```text
{
  domain: "fuse-held-out-reliability-v3-profile",
  protocolVersion: 3,
  evidenceType: "held-out-reliability-v3",
  planSchemaVersion: 2,
  reconciliationMappingVersion: 2,
  preregistrationCommit,
  inheritedV2Commit,
  amendmentCommit,
  protocolSources: [v2SourceRecord, v3SourceRecord],
  beacon: { chainHash, publicKey, scheme, round: 6338040, availableAt },
  randomnessDomain: "fuse-held-out-reliability-v3",
  requestIdDomain: "fuse-held-out-reliability-v3-request",
  requestRecipeVersion: 1,
  authorizationDecisionDomain: "fuse-reliability-v3-authorization",
  replayOperationDomain: "fuse-reliability-v3-replay-operation",
  provider: "openrouter",
  model: "nousresearch/hermes-4-405b",
  allowFallbacks: false,
  adapterRetryCount: 0,
  authorizationWindow,
  schedule,
  expiries,
  setupIdentityRecipeVersion: 1,
  reconciliationOffsetsSeconds,
  operationAndPhaseDeadlines,
  costCaps,
  artifactNamespaceVersion: 1,
  artifactCoordinates,
  finalizationRulesVersion: 1
}
```

Every named value is the exact value or ordered array preregistered in v3 or inherited from frozen v2. `artifactCoordinates` contains every path template named in both the original v3 document and this amendment. `costCaps` contains the known-cost cap, unresolved-exposure cap, all four lane caps, and each per-call maximum. `expiries` contains operator, reconciliation, policy, mandate, root, child, and hard-finalization timestamps. `operationAndPhaseDeadlines` contains every inherited admission, dispatch, authorization, reconciliation, settlement, and publication bound. The profile fingerprint is `sha256:` plus SHA-256 of the UTF-8 `canonicalJson` bytes of that exact projection.

Before any other v3 mutation, setup creates or byte-verifies one control row containing every scalar profile identity and the profile fingerprint. Retry may resume only when all fields are equal. Every setup or provisioning mutation and every state-changing admission, dispatch, authorization, reconciliation, replay, recovery, settlement, finalization, and artifact-publication transaction must lock the control row and compare the stored complete fingerprint to the expected fingerprint before any mutation. A missing field, v1/v2 profile, or different same-version v3 fingerprint is an irreversible profile conflict.

### Plan, run, and exact request bytes

A v3 run ID must match `^hov3-[A-Za-z0-9._:-]{1,97}$` and must be create-only across all reliability control rows. This caps the complete run ID at 102 characters and every setup identifier below at 128 characters. Every v3 CLI, path, and database validator uses this exact grammar, including `:`. Historical v1/v2 validators do not change.

The request-ID digest is exactly SHA-256 of the UTF-8 canonical JSON bytes of:

```text
{
  domain: "fuse-held-out-reliability-v3-request",
  protocolVersion: 3,
  runId,
  block,
  lane,
  callOrdinal
}
```

The request ID is `hov3_` followed by the first 48 lowercase hexadecimal digest characters. The full digest remains in the sealed call.

For each sealed call, the plan contains `requestRecipeVersion = 1`, `fuseRequestBodySha256`, `providerRequestBodySha256`, and `requestCommitment`. The Fuse request body bytes are the UTF-8 bytes of this exact no-whitespace JSON member order and no trailing newline:

```text
{"model":"nousresearch/hermes-4-405b","max_tokens":8,"workload_class":"<workload-class>","messages":[{"role":"user","content":"Reliability context <context-units>: <x repeated context-units times>"}]}
```

`<workload-class>` and `<context-units>` are the sealed call values. The request uses method `POST`, route `/v1/chat/completions`, and exact normalized authoritative headers:

```text
content-type: application/json
idempotency-key: <request-id>
x-fuse-mandate: <lane-mandate-id>
x-fuse-branch: <selected-child-branch-id>
x-fuse-reliability-run: <run-id>
x-fuse-reliability-lane: <lane>
x-fuse-reliability-block: <base-10-block>
```

The bearer token bytes are secret and excluded from artifact digests; the server-authenticated lane credential ID and ownership are included in `requestCommitment`. No other header may affect organization, credential, policy, mandate, branch, workload class, idempotency, reliability context, routing, or accounting.

The provider-facing request uses `POST` to `https://openrouter.ai/api/v1/chat/completions`, has `content-type: application/json`, has no `HTTP-Referer` or `X-OpenRouter-Title`, and uses these exact UTF-8 body bytes with no trailing newline:

```text
{"model":"nousresearch/hermes-4-405b","max_tokens":8,"messages":[{"role":"user","content":"Reliability context <context-units>: <x repeated context-units times>"}],"provider":{"allow_fallbacks":false}}
```

The provider bearer secret is excluded from artifact digests; the exact provider configuration ID, credential owner ID, credential version, and encryption-key ID are included in the setup and profile-bound request projection. `fuseRequestBodySha256` and `providerRequestBodySha256` hash the exact corresponding bytes. `requestCommitment` is SHA-256 of canonical JSON containing domain `fuse-reliability-request-v2`, method, route, organization ID, authenticated credential ID, mandate ID, branch ID, workload class, idempotency key, parsed Fuse body, Fuse body SHA-256, provider method/URL/body SHA-256, provider configuration/credential identities, request ID full digest, plan fingerprint, and profile fingerprint. This inherits the v2 commitment domain while making every previously implicit v3 byte coordinate explicit.

The plan binds `requestRecipeVersion = 1` and SHA-256 of the exact canonical request-recipe projection above. Any byte, header projection, route, credential binding, recipe, source identity, or digest mismatch fails before token creation.

### Complete setup and authority identity

The organization ID is exactly the v3 run ID. Setup identities are exactly:

```text
setup admin actor: <run-id>-setup-admin
setup admin credential: <run-id>-setup-admin-credential
provider credential owner: <run-id>-provider-owner
provider credential: <run-id>-openrouter-credential
provider configuration: <run-id>-openrouter
operator service account: <run-id>-operator
operator credential: <run-id>-operator-credential
runner service account: <run-id>-runner
runner orchestration credential: <run-id>-runner-credential
reconciler service account: <run-id>-reconciler
reconciler credential: <run-id>-reconciler-credential
lane agent: <run-id>-agent-<lane>
lane credential: <run-id>-credential-<lane>
policy: <run-id>-policy-<lane>, version 1
mandate: <run-id>-mandate-<lane>
root branch: <run-id>-root-<lane>
child branch: <run-id>-child-<lane>-<1-or-2>
```

There is authoritatively no payer principal, payer credential, payment configuration, or payment capability. Provider credential `<run-id>-openrouter-credential` is owned by `<run-id>-provider-owner`, has version 1 and capability `provider:invoke:openrouter`, and is the sole credential bound to provider configuration `<run-id>-openrouter`. The setup profile binds its active encryption-key ID and ciphertext-envelope SHA-256, never plaintext secret bytes. Setup admin has only `reliability:setup`; provider owner has only `provider:configure`; operator has only `reliability:operate`; runner orchestration has only `reliability:orchestrate`; reconciler has only `reliability:reconcile`; each lane credential has only `inference:execute`; the two issuers have only their separately named authorization capabilities. Every credential belongs to the run organization and is owned by its named principal. Setup admin, provider owner, operator, runner, reconciler, lane agents, and both issuers are mutually unequal. Payer absence is verified as an absence predicate, not as an identity comparison. Existing resources are accepted only after exact authoritative readback of all IDs, ownership, capabilities, policy/configuration versions, and immutable fingerprints.

Protocol v3 uses these fresh authorization issuers and raw public keys:

```text
operator issuer ID: ed25519:1007ec41b6df02fd9e4992be9cc1549e77fb0b5d959f45613197129b480aad1c
operator public key: db5fd4c3900a02def5c34e0a02a510eb77ae2aee76e6a688faaf1d16d81cfc53
reconciliation issuer ID: ed25519:5e5049801e5fa957138c17aba1c74008d87dc14614dd2c2250402159ea52d68e
reconciliation public key: 07f9910b83c6833c71943db6de672f9cdd8d03dff3eb4f03afa17761d079bb8e
```

The signed operator actor, service-account principal, and credential owner are `<run-id>-operator`; its credential is `<run-id>-operator-credential`. The signed reconciliation actor, service-account principal, and credential owner are `<run-id>-reconciler`; its credential is `<run-id>-reconciler-credential`. Each verifier requires exact equality of actor, service account, credential ownership, organization/run, capability, issuer, plan fingerprint, executable identity, and immutable profile fingerprint. The inherited separation rules remain mandatory.

An operator nonce is generated from 32 CSPRNG bytes only after plan sealing and encoded exactly `hov3:<run-id>:<64-lowercase-hex>`. It is create-only and globally unique; any reuse, including byte-equal reuse, fails. Reconciliation authorization has a null nonce. Expiries remain the exact preregistered values.

The authorization decision ID is a UUID-shaped value derived from SHA-256 of canonical JSON containing domain `fuse-reliability-v3-authorization`, protocol version, run ID, plan fingerprint, profile fingerprint, operator authorization SHA-256, and reconciliation authorization SHA-256. Let `h` be its first 32 lowercase digest characters. The ID is `h[0:8]-h[8:12]-5h[13:16]-ah[17:20]-h[20:32]`. It is create-only and unique per exact authorization pair; a different preimage for an existing ID is an irreversible conflict.

Each replay operation ID is `replay-` plus lowercase SHA-256 of canonical JSON containing domain `fuse-reliability-v3-replay-operation`, protocol version, run ID, plan fingerprint, profile fingerprint, replay authorization SHA-256, replay ordinal, and sealed request ID. It is create-only and unique across the run; retry may return only a byte-equal completed result.

### Complete artifact coordinates and recoverable publication

In addition to the original v3 paths, the four lane claims, preliminary replay, and scheduler manifests use:

```text
evidence/.run-claims/held-out-reliability-v3/<run-id>/<lane>.claim
evidence/held-out-reliability-v3/replay-preliminary/<run-id>.json
evidence/held-out-reliability-v3/scheduler-manifests/<run-id>/<request-id>.json
```

Create-only lock files are adjacent to the destination and use `<destination>.write-lock`. The beacon/plan pair has a create-only recovery intent at:

```text
evidence/held-out-reliability-v3/publication-intents/beacon-plan/<run-id>.json
```

Its canonical schema is exactly `{schemaVersion:1,evidenceType,protocolVersion,runId,profileFingerprint,transactionId,members}`, where `members` is ordered beacon then plan and each member is `{kind,destination,sha256,bytesBase64}`. `transactionId` is SHA-256 of canonical JSON over the same object without `transactionId`. The intent is durably synced and create-only before either member destination is published. Recovery may only decode and publish those exact bytes to those exact create-only destinations, accept an existing byte-equal member, and then remove operational locks after directory sync. A missing intent, conflicting intent/member, wrong profile, wrong transaction ID, or cross-version path fails irreversibly. This intent is the byte authority and crash-recovery linearization point; the replay report remains the sole final pass/fail commit marker.

The plan destination is derived from its computed fingerprint. The protocol artifact is canonical JSON binding the complete profile, both source records, implementation identity, and artifact schema version. No arbitrary output coordinate is accepted.

Byte-equal transaction recovery applies only to genuinely create-only destinations. Inherited incremental lane and scheduler manifest replacement semantics remain unchanged. A stale or orphaned manifest lock triggers irreversible failure, incident creation, and no further dispatch, exactly as inherited.

No v1/v2 artifact, claim, lock, intent, database row, nonce, identifier, or same-version mismatched profile may satisfy a v3 inventory or recovery check.

### Finalization, reports, and separate financial reconciliation

Hard-finalization classification starts in `[2026-08-05T09:30:00Z, 2026-08-05T09:30:01Z)`. The transaction atomically persists terminal classification and a create-only report publication intent within the inherited 30-second database-operation deadline. A report intent uses:

```text
evidence/held-out-reliability-v3/publication-intents/reports/<run-id>.json
```

Its canonical schema is exactly `{schemaVersion:1,evidenceType,protocolVersion,runId,profileFingerprint,reportKind,destination,reportSha256,reportBytesBase64,artifactInventorySha256,acceptedSnapshotSha256,committedAt}`. Every field and the exact canonical report bytes are committed before transaction completion. Recovery may publish only the decoded byte-identical report to the exact create-only destination. Hard-finalization publication completes by `2026-08-05T09:31:00Z`.

A failure occurring before hard finalization must still atomically commit its exact failure-report intent at the irreversible event and attempt publication within 60 seconds of that event. A successful settlement commits its exact pass-report intent atomically with settlement acceptance and attempts publication within 60 seconds. Hard finalization does not extend either earlier window. After hard finalization, the sole permitted v3 protocol operation is byte-identical create-only report publication from a previously committed valid intent; it cannot dispatch, reconcile, reclassify, settle the v3 gate, replace evidence, alter protocol cost, or recompute report bytes.

Ordinary separate-ledger provider-cost reconciliation and reservation settlement remain permitted after v3 finalization when inherited production rules require them. They cannot change v3 control state, classifications, artifacts, commitments, evidence, cost gates, claims, or pass/fail authority.

### Normative literal projections and golden vectors

This section replaces every symbolic profile, request-recipe, request-commitment, authorization-ID, replay-ID, and report-intent shorthand above. Production objects use the identical keys, types, nulls, and array order shown here. The profile golden substitutes all-zero amendment source values only to make the vector immutable; production replaces exactly top-level `amendmentCommit` and the second source record's `commit`, `gitBlob`, and `sha256` with the publicly merged amendment values. No other key may be added, omitted, renamed, reordered within an array, or encoded with a different type.

Profile golden canonical bytes:

```json
{"adapterRetryCount":0,"amendmentCommit":"0000000000000000000000000000000000000000","artifactCoordinates":["evidence/held-out-reliability-v3/protocols/held-out-reliability-v3.json","evidence/held-out-reliability-v3/beacons/drand-6338040.json","evidence/held-out-reliability-v3/plans/<plan-fingerprint>.json","evidence/held-out-reliability-v3/authorizations/operator/<run-id>.json","evidence/held-out-reliability-v3/authorizations/reconciliation/<run-id>.json","evidence/held-out-reliability-v3/authorization-receipts/operator/<run-id>.json","evidence/held-out-reliability-v3/authorization-receipts/reconciliation/<run-id>.json","evidence/held-out-reliability-v3/manifests/<run-id>/<lane>-<block>.json","evidence/held-out-reliability-v3/replay/<run-id>.json","evidence/held-out-reliability-v3/incidents/<run-id>/<event-sequence>-<event-type>.json","evidence/.run-claims/held-out-reliability-v3/<run-id>/<lane>.claim","evidence/held-out-reliability-v3/replay-preliminary/<run-id>.json","evidence/held-out-reliability-v3/scheduler-manifests/<run-id>/<request-id>.json","evidence/held-out-reliability-v3/publication-intents/beacon-plan/<run-id>.json","database:reliability_report_publication_outbox/<run-id>/<intent-sequence>","evidence/held-out-reliability-v3/publication-intents/reports/<run-id>.json"],"artifactNamespaceVersion":1,"authorizationDecisionDomain":"fuse-reliability-v3-authorization","authorizationIssuers":{"operator":{"capability":"evidence:authorize-spend","id":"ed25519:1007ec41b6df02fd9e4992be9cc1549e77fb0b5d959f45613197129b480aad1c","publicKey":"db5fd4c3900a02def5c34e0a02a510eb77ae2aee76e6a688faaf1d16d81cfc53"},"reconciliation":{"capability":"evidence:authorize-reconciliation","id":"ed25519:5e5049801e5fa957138c17aba1c74008d87dc14614dd2c2250402159ea52d68e","publicKey":"07f9910b83c6833c71943db6de672f9cdd8d03dff3eb4f03afa17761d079bb8e"}},"authorizationWindow":{"operationDeadlineMs":55000,"startsAt":"2026-08-02T08:16:00.000Z","startsBefore":"2026-08-02T08:16:01.000Z"},"beacon":{"availableAt":"2026-08-01T08:17:00.000Z","chainHash":"8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce","publicKey":"868f005eb8e6e4ca0a47c8a77ceaa5309a47978a7c71bc5cce96366b5d7a569937c529eeda66c7293784a9402801af31","round":6338040,"scheme":"pedersen-bls-chained"},"costCaps":{"knownCostCapUsdMicros":"3000000","lanes":[{"lane":"normal-paced","mandateMaximumUsdMicros":"250002","perCallMaximumUsdMicros":"10000"},{"lane":"high-envelope","mandateMaximumUsdMicros":"1250002","perCallMaximumUsdMicros":"50000"},{"lane":"bounded-burst","mandateMaximumUsdMicros":"1250002","perCallMaximumUsdMicros":"50000"},{"lane":"restart-resume","mandateMaximumUsdMicros":"250002","perCallMaximumUsdMicros":"10000"}],"unresolvedExposureCapUsdMicros":"320000"},"domain":"fuse-held-out-reliability-v3-profile","evidenceType":"held-out-reliability-v3","expiries":{"hardFinalizationAt":"2026-08-05T09:30:00.000Z","operatorAuthorizationExpiresAt":"2026-08-02T08:22:00.000Z","policyMandateAndBranchExpiresAt":"2026-08-05T10:30:00.000Z","reconciliationAuthorizationExpiresAt":"2026-08-05T09:30:00.000Z"},"finalizationRules":{"hardFinalizationClassificationStartsAt":"2026-08-05T09:30:00.000Z","hardFinalizationClassificationStartsBefore":"2026-08-05T09:30:01.000Z","outboxTable":"reliability_report_publication_outbox","passAndFailurePublicationDeadlineMs":60000,"rulesVersion":1},"finalizationRulesVersion":1,"inheritedV2Commit":"6c6ef80f909998af45576baa07e03733cd5d0950","mappingVersion":2,"model":"nousresearch/hermes-4-405b","operationAndPhaseDeadlines":{"admissionStartWindowMs":1000,"authorizationOperationMs":55000,"authorizationPhasesMs":{"decisionTransaction":15000,"receiptPublication":30000,"remaining":5000,"signatureAndFieldValidation":5000},"blockOrchestratorMs":1800000,"dispatchTerminalMs":75000,"finalizationDatabaseOperationMs":30000,"freshBlockLaunchWindowMs":300000,"postgresAndArtifactOperationMs":30000,"providerAdapterMs":60000,"reconciliationClassificationAfterAmbiguitySeconds":86431,"reconciliationEvidenceCutoffAfterAmbiguitySeconds":86400,"reconciliationOperationMs":55000,"reconciliationPhasesMs":{"body":30000,"parseCanonicalizeHash":5000,"persist":15000,"remaining":5000},"replayHttpMs":15000,"reportPublicationMs":60000,"responseBodyMaxBytes":1048576,"settlementOperationMs":120000},"planSchemaVersion":2,"preregistrationCommit":"0a29a7e63d3659c1c374f535aeac9da2ca2d4d69","protocolSources":[{"commit":"6c6ef80f909998af45576baa07e03733cd5d0950","gitBlob":"a0c750c4826cf838ad338e7f135a0622d34f4cca","path":"docs/held-out-reliability-protocol-v2.md","sha256":"sha256:841909a2a99ba29eb6b80179cd2bf267ef1f73dab4f1af1870680e6cc20d4c96"},{"commit":"0000000000000000000000000000000000000000","gitBlob":"0000000000000000000000000000000000000000","path":"docs/held-out-reliability-protocol-v3.md","sha256":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}],"protocolVersion":3,"provider":{"allowFallbacks":false,"baseUrl":"https://openrouter.ai/api/v1","credentialVersion":1,"httpReferer":null,"name":"openrouter","xOpenRouterTitle":null},"randomnessDomain":"fuse-held-out-reliability-v3","reconciliationOffsetsSeconds":[0,60,300,900,1800,3600,7200,14400,28800,43200,64800,86300],"replayOperationDomain":"fuse-reliability-v3-replay-operation","requestIdDomain":"fuse-held-out-reliability-v3-request","requestRecipeFingerprint":"sha256:8c1f93cee52535ecc3568970e8a52b1efeb2e78f44cf46ae5aa440a067b64fa2","requestRecipeVersion":1,"schedule":[{"block":1,"launchDeadline":"2026-08-02T08:22:00.000Z","opensAt":"2026-08-02T08:17:00.000Z"},{"block":2,"launchDeadline":"2026-08-02T20:22:00.000Z","opensAt":"2026-08-02T20:17:00.000Z"},{"block":3,"launchDeadline":"2026-08-03T08:22:00.000Z","opensAt":"2026-08-03T08:17:00.000Z"},{"block":4,"launchDeadline":"2026-08-03T20:22:00.000Z","opensAt":"2026-08-03T20:17:00.000Z"},{"block":5,"launchDeadline":"2026-08-04T08:22:00.000Z","opensAt":"2026-08-04T08:17:00.000Z"}],"setupIdentityRecipe":{"capabilities":{"laneCredential":"inference:execute","operatorCredential":"reliability:operate","providerCredential":"provider:invoke:openrouter","providerOwner":"provider:configure","reconcilerCredential":"reliability:reconcile","runnerCredential":"reliability:orchestrate","setupAdminCredential":"reliability:setup"},"childBranch":"<run-id>-child-<lane>-<1-or-2>","expiresAt":"2026-08-05T10:30:00.000Z","laneAgent":"<run-id>-agent-<lane>","laneAuthority":[{"children":[{"branch":1,"maximumUsdMicros":"130001"},{"branch":2,"maximumUsdMicros":"120001"}],"lane":"normal-paced","mandateMaximumUsdMicros":"250002","perCallUsdMicros":"10000","policyAggregateUsdMicros":"250002","policyDailyUsdMicros":"250002","policyHourlyUsdMicros":"250002","rootMaximumUsdMicros":"250002","workloadClass":"baseline-lookup"},{"children":[{"branch":1,"maximumUsdMicros":"600001"},{"branch":2,"maximumUsdMicros":"650001"}],"lane":"high-envelope","mandateMaximumUsdMicros":"1250002","perCallUsdMicros":"50000","policyAggregateUsdMicros":"1250002","policyDailyUsdMicros":"1250002","policyHourlyUsdMicros":"1250002","rootMaximumUsdMicros":"1250002","workloadClass":"spike-burst"},{"children":[{"branch":1,"maximumUsdMicros":"650001"},{"branch":2,"maximumUsdMicros":"600001"}],"lane":"bounded-burst","mandateMaximumUsdMicros":"1250002","perCallUsdMicros":"50000","policyAggregateUsdMicros":"1250002","policyDailyUsdMicros":"1250002","policyHourlyUsdMicros":"1250002","rootMaximumUsdMicros":"1250002","workloadClass":"spike-burst"},{"children":[{"branch":1,"maximumUsdMicros":"120001"},{"branch":2,"maximumUsdMicros":"130001"}],"lane":"restart-resume","mandateMaximumUsdMicros":"250002","perCallUsdMicros":"10000","policyAggregateUsdMicros":"250002","policyDailyUsdMicros":"250002","policyHourlyUsdMicros":"250002","rootMaximumUsdMicros":"250002","workloadClass":"baseline-lookup"}],"laneCredential":"<run-id>-credential-<lane>","mandate":"<run-id>-mandate-<lane>","maxInputTokens":850,"maxOutputTokens":8,"maxRequestsPerMinute":5,"operatorCredential":"<run-id>-operator-credential","operatorServiceAccount":"<run-id>-operator","payerAbsent":true,"policy":"<run-id>-policy-<lane>","policyMode":"enforce","policyVersion":1,"providerConfiguration":"<run-id>-openrouter","providerCredential":"<run-id>-openrouter-credential","providerCredentialOwner":"<run-id>-provider-owner","reconcilerCredential":"<run-id>-reconciler-credential","reconcilerServiceAccount":"<run-id>-reconciler","rootBranch":"<run-id>-root-<lane>","runnerCredential":"<run-id>-runner-credential","runnerServiceAccount":"<run-id>-runner","setupAdminActor":"<run-id>-setup-admin","setupAdminCredential":"<run-id>-setup-admin-credential","version":1}}
```

Profile golden fingerprint: `sha256:d3d63847f08f7d9dec19de48037314375f329473e523747799bfab8c0b15b214`.

Request-recipe canonical bytes:

```json
{"domain":"fuse-held-out-reliability-v3-request-recipe","fuse":{"authorization":{"authenticatedCredentialId":"<lane-credential-id>","scheme":"Bearer","secretBytes":"excluded"},"bodyEncoding":"utf8","bodyMemberOrder":["model","max_tokens","workload_class","messages"],"bodyTemplate":"{\"model\":\"nousresearch/hermes-4-405b\",\"max_tokens\":8,\"workload_class\":\"<workload-class>\",\"messages\":[{\"role\":\"user\",\"content\":\"Reliability context <context-units>: <x repeated context-units times>\"}]}","bodyTrailingNewline":false,"headers":[{"name":"content-type","value":"application/json"},{"name":"idempotency-key","valueSource":"requestId"},{"name":"x-fuse-mandate","valueSource":"mandateId"},{"name":"x-fuse-branch","valueSource":"branchId"},{"name":"x-fuse-reliability-run","valueSource":"runId"},{"name":"x-fuse-reliability-lane","valueSource":"lane"},{"name":"x-fuse-reliability-block","valueSource":"base10Block"}],"method":"POST","route":"/v1/chat/completions"},"protocolVersion":3,"provider":{"authorization":{"credentialId":"<provider-credential-id>","scheme":"Bearer","secretBytes":"excluded"},"bodyEncoding":"utf8","bodyMemberOrder":["model","max_tokens","messages","provider"],"bodyTemplate":"{\"model\":\"nousresearch/hermes-4-405b\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"Reliability context <context-units>: <x repeated context-units times>\"}],\"provider\":{\"allow_fallbacks\":false}}","bodyTrailingNewline":false,"headers":[{"name":"content-type","value":"application/json"}],"method":"POST","url":"https://openrouter.ai/api/v1/chat/completions"},"version":1}
```

Request-recipe fingerprint: `sha256:8c1f93cee52535ecc3568970e8a52b1efeb2e78f44cf46ae5aa440a067b64fa2`. The plan stores this exact fingerprint.

Request-commitment golden canonical bytes:

```json
{"domain":"fuse-reliability-request-v2","fuse":{"authorization":{"authenticatedCredentialId":"hov3-golden-credential-normal-paced","credentialOwnerId":"hov3-golden-agent-normal-paced","scheme":"Bearer","secretBytes":"excluded"},"body":{"max_tokens":8,"messages":[{"content":"Reliability context 1: x","role":"user"}],"model":"nousresearch/hermes-4-405b","workload_class":"baseline-lookup"},"bodySha256":"sha256:0000000000000000000000000000000000000000000000000000000000000000","headers":{"content-type":"application/json","idempotency-key":"hov3_000000000000000000000000000000000000000000000000","x-fuse-branch":"hov3-golden-child-normal-paced-1","x-fuse-mandate":"hov3-golden-mandate-normal-paced","x-fuse-reliability-block":"1","x-fuse-reliability-lane":"normal-paced","x-fuse-reliability-run":"hov3-golden"},"method":"POST","route":"/v1/chat/completions"},"idempotencyKey":"hov3_000000000000000000000000000000000000000000000000","organizationId":"hov3-golden","planFingerprint":"sha256:0000000000000000000000000000000000000000000000000000000000000000","profileFingerprint":"sha256:0000000000000000000000000000000000000000000000000000000000000000","protocolVersion":3,"provider":{"authorization":{"credentialId":"hov3-golden-openrouter-credential","scheme":"Bearer","secretBytes":"excluded"},"bodySha256":"sha256:0000000000000000000000000000000000000000000000000000000000000000","configurationId":"hov3-golden-openrouter","credentialCiphertextEnvelopeSha256":"sha256:0000000000000000000000000000000000000000000000000000000000000000","credentialEncryptionKeyId":"golden-key","credentialOwnerId":"hov3-golden-provider-owner","credentialVersion":1,"headers":{"content-type":"application/json","http-referer":null,"x-openrouter-title":null},"method":"POST","url":"https://openrouter.ai/api/v1/chat/completions"},"requestId":"hov3_000000000000000000000000000000000000000000000000","requestIdFullDigest":"0000000000000000000000000000000000000000000000000000000000000000","requestRecipeFingerprint":"sha256:8c1f93cee52535ecc3568970e8a52b1efeb2e78f44cf46ae5aa440a067b64fa2","workload":{"branchId":"hov3-golden-child-normal-paced-1","class":"baseline-lookup","lane":"normal-paced","mandateId":"hov3-golden-mandate-normal-paced"}}
```

Request-commitment golden fingerprint: `sha256:4837489bdb7807c708e80aaa5cf83df15fbb51e2b15d5adc2e39778cd4eaed59`. Production uses the identical schema and replaces every fixture leaf with its sealed authoritative value. All shown fields are required. No field is nullable except `provider.headers.http-referer` and `provider.headers.x-openrouter-title`, which must both be JSON null. Authorization secrets are absent from the preimage; the literal `secretBytes: "excluded"` and authenticated credential identities are mandatory.

Authorization decision derivation is total over readiness outcomes. Its canonical preimage is exactly `{domain,protocolVersion,runId,planFingerprint,profileFingerprint,decisionKind,reasonCode,operatorArtifactSha256,reconciliationArtifactSha256}`. Keys have those exact names. `decisionKind` is one of `active`, `readiness_failed`, or `readiness_predecision_failed`; `reasonCode` is the exact durable reason-code string; each artifact field is either `sha256:<64-lowercase-hex>` or the literal string `absent`. The UUID-shaped formatting rule above then applies. This creates an ID for every valid, invalid, absent, and predecision terminal row without null ambiguity.

There is no separate replay-authorization artifact. Each replay-operation canonical preimage is exactly `{"authorizationDecisionId":<committed-active-decision-id>,"domain":"fuse-reliability-v3-replay-operation","ordinal":<integer-1-through-20>,"planFingerprint":<sha256>,"profileFingerprint":<sha256>,"protocolVersion":3,"requestId":<sealed-request-id>,"runId":<run-id>}`. The operation ID is `replay-` plus lowercase SHA-256 of those canonical bytes.

Authorization-ID golden canonical bytes are `{"decisionKind":"readiness_predecision_failed","domain":"fuse-reliability-v3-authorization","operatorArtifactSha256":"absent","planFingerprint":"sha256:0000000000000000000000000000000000000000000000000000000000000000","profileFingerprint":"sha256:0000000000000000000000000000000000000000000000000000000000000000","protocolVersion":3,"reasonCode":"READINESS_PREDECISION_FAILED","reconciliationArtifactSha256":"absent","runId":"hov3-golden"}` and produce `b1b76322-a365-548d-ac1c-a0dd5e54d199`. Replay-ID golden canonical bytes are `{"authorizationDecisionId":"b1b76322-a365-548d-ac1c-a0dd5e54d199","domain":"fuse-reliability-v3-replay-operation","ordinal":1,"planFingerprint":"sha256:0000000000000000000000000000000000000000000000000000000000000000","profileFingerprint":"sha256:0000000000000000000000000000000000000000000000000000000000000000","protocolVersion":3,"requestId":"hov3_000000000000000000000000000000000000000000000000","runId":"hov3-golden"}` and produce `replay-c24e271aff281245e389c1f69ce19012c8ce8eeac0cc703122782c0d9bd2edfe`.

### Transactionally implementable report outbox

A report publication intent is not created atomically in the filesystem. It is inserted in PostgreSQL table `reliability_report_publication_outbox` in the same control-row-locked transaction as the authoritative classification or accepted settlement. Its immutable primary key is `(run_id, intent_sequence)`. The exact required columns are `run_id`, `intent_sequence`, `profile_fingerprint`, `report_kind`, `destination`, `report_sha256`, `report_bytes_base64`, `artifact_inventory_sha256`, `accepted_snapshot_sha256`, `committed_at`, `publication_deadline`, `supersedes_intent_sequence`, and `state`. `accepted_snapshot_sha256` is a SHA-256 string for pass and JSON/SQL null for a failure before accepted settlement. `supersedes_intent_sequence` is null except for a later failure intent that names a prior pass intent. Initial state is `committed`. Outbox rows and payload bytes are create-only; state transitions are append-only events, not row replacement.

The filesystem path described above is a projection of a committed outbox row. A worker first locks protocol control and the outbox row, verifies the complete profile, deadline, and current append-only state, then publishes only the stored decoded bytes create-only and records a byte-equal publication receipt. A pass report is authoritative only after its byte-equal destination exists and its publication receipt commits by its deadline.

If a pass publication has no committed receipt at its deadline, one control-row-locked database transaction marks the pass intent `publication_failed` by append-only event, persists an incident, and inserts a new immutable failure intent at the same canonical report destination with the failed pass sequence in `supersedes_intent_sequence`. The failed pass worker loses publication authority before that transaction unlocks. If the destination is absent, only the failure bytes may then be published. If byte-equal pass bytes already exist, recovery verifies them and may commit the pass receipt only when durable filesystem timing evidence proves publication completed by the deadline; otherwise the artifact conflict is authoritative non-pass and no bytes are replaced. Conflicting preexisting bytes are preserved as non-pass evidence.

A database failure that prevents classification or outbox insertion cannot be described as an atomically committed report intent. It is itself authoritative incomplete/non-pass evidence. Recovery may only resume the inherited transaction from already durable inputs under the profile lock; it may never fabricate an earlier commit time or report bytes. Earlier irreversible failures and accepted settlement retain their inherited 60-second publication deadlines. Hard-finalization classification retains the explicit start interval and database-operation bound above.
