# Phase 9 operations runbook

Status: validated for invite-only control mode

## Detection

1. Run `curl -fsS https://fuse-agent-control-plane.vercel.app/health`.
2. Run `FUSE_BASE_URL=<https-url> FUSE_ADMIN_TOKEN=<protected-token> npm run ops:check`; any nonzero exit is release-blocking.
3. Check `/ready`, the receipt endpoint, operational audit events, invite rejection rate, and source-credential session probes for the request.
4. Treat audit unavailability, rollback failure, limiter failure, cross-tenant denial, or reconciliation hold as an incident.

## Impact classification

- P0: credential or derived session accepted after revocation, cross-tenant read, or executable payment behavior in control mode.
- P1: provider ambiguity, durable store outage, repeated 5xx/503, or stale reconciliation hold.
- P2: elevated latency, 429 surge, onboarding failure, or browser-only regression.

## Containment

- Do not retry an ambiguous provider request with a new idempotency key.
- Preserve the original request ID, provider evidence, and durable audit events.
- Pause the affected mandate or workspace when continued execution could increase exposure.
- Revoke a compromised credential and issue a replacement through the one-time recovery path.
- If the durable limiter is unavailable, fail closed for authenticated product routes.

## Evidence collection

Record deployment/revision, request ID, workspace ID, agent and mandate IDs, HTTP status, durable receipt state, provider response, limiter decision, onboarding state, audit event ID, and operator timestamp. Never record tokens, invites, recovery codes, or API keys.

## Safe remediation

- Credential incident: consume the recovery code once, verify old credential 401, verify replacement 200 and workspace scope.
- Provider failure: preserve the request, inspect the receipt, and route `reconciliation_hold` to reconciliation.
- Rate-limit incident: verify the Postgres limiter table and key dimensions, then restore service only after durable writes succeed.
- Invite incident: disable onboarding, inspect durable invite redemptions and audit events, and rotate only affected unused invites.
- Session incident: revoke the source credential, verify the derived session returns 401, and inspect session audit events.
- Onboarding rollback incident: stop onboarding and do not reuse the invite until database cleanup and operation state agree.

## Rollback

Rollback only to a previously verified candidate. Confirm database schema compatibility, receipt integrity, mandate state, credential revocation state, and reconciliation cases after restart. Do not roll back by deleting evidence or resetting counters.

## Communication

The incident update must state impact, affected workspace scope, current containment, evidence IDs, whether provider execution occurred, and the next verification time. Control mode performs no x402 or customer-to-Fuse payment. Never claim provider billing without provider-side evidence.

## Closure

Close only after the durable readback agrees with the operator record, the relevant alert is clear, the old credential remains revoked where applicable, and a follow-up prevention item is recorded.

The authenticated `/api/v1/admin/readiness` response is safe to retain as redacted evidence. It reports booleans, counts, and the oldest onboarding timestamp only. It does not return credentials, invite hashes, recovery codes, database URLs, or customer content.
