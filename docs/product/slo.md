# Fuse invite-only alpha SLO and alert ownership

Status: operational baseline for invite-only control mode

## Service objectives

| Surface | Objective | Measurement | Owner | Alert |
|---|---|---|---|---|
| Control plane | `/health` returns 200 | hosted probe, 1 minute | on-call operator | any failed probe |
| Readiness | `/ready` returns 200 when dependencies are ready and authenticated `/api/v1/admin/readiness` reports every control invariant true | `npm run ops:check`, 1 minute | on-call operator | any failed invariant or 2 consecutive dependency failures |
| First-run path | 99% of valid sandbox/first-run requests reach a terminal receipt | request logger plus receipt store | product operator | terminal rate below 99% over 15 minutes |
| Provider latency | p95 below 30 seconds | request duration and provider evidence | provider operator | p95 above threshold for 10 minutes |
| Reconciliation | no unresolved hold older than 15 minutes without an operator note | reconciliation queue | reconciliation operator | oldest hold above threshold |
| Abuse control | no authenticated principal exceeds configured per-minute allowance | durable limiter decisions and 429 rate | platform operator | limiter unavailable or cross-tenant key collision |
| Credential lifecycle | revoked credentials receive 401 | credential status/readback probe | security operator | any revoked credential accepted |
| Invite gate | only allowlisted, unconsumed invites create workspaces | durable invite redemption and operational audit | security operator | missing audit, replay accepted, or rejection surge |
| Onboarding recovery | no failed onboarding remains partially provisioned | onboarding operation status and rollback audit | platform operator | rollback failure or `in_progress` older than 15 minutes |
| Human sessions | source credential revocation invalidates derived sessions | session audit plus revoked-source probe | security operator | any derived session accepted after source revocation |

## Ownership and escalation

- Primary: the operator running the hosted deployment.
- Secondary: the provider/reconciliation operator for provider outcomes and holds.
- Security escalation: credential compromise, invite abuse, derived-session revocation failure, or cross-tenant access.
- Product escalation: repeated first-run failures, policy mismatch, or customer-facing copy that claims settlement.

Control mode has no signer, wallet, x402, or customer-to-Fuse settlement path. Any payment configuration accepted by the hosted runtime is a release-blocking boundary violation.

`npm run ops:check` and `npm run ops:beta-alerts` require `FUSE_BASE_URL` plus a protected `FUSE_ADMIN_TOKEN`. They fail with exit code 2 when health, control mode, settlement disablement, durable invite enforcement, durable admin limiting, source-credential revalidation, stale onboarding, or reconciliation visibility is unsafe. Output contains only redacted status and timestamps, never tokens or invite material.

## Evidence required for closure

Every incident record must include request ID, workspace ID, status code, durable receipt state, provider evidence status, limiter decision where applicable, operational audit event, operator action, and final readback. An ambiguous provider result remains in reconciliation until authoritative provider billing evidence exists.
