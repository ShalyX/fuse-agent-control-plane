# External beta incident runbook

## Scope

This runbook covers the Daemon / Caraxes external beta workspace and any subsequent customer workspace.

## First response

1. Check control-plane health:
   `curl -fsS https://fuse-agent-control-plane.vercel.app/health`
2. Check `/ready`, durable limiter state, onboarding operation state, and operational audit events.
3. Do not retry an ambiguous provider request with a new idempotency key. Preserve the original request ID and provider evidence.
4. Read the customer receipt with the customer agent credential and mandate header.
5. If the receipt is `reconciliation_hold`, stop retries and route it to reconciliation.

## Credential compromise or loss

1. Revoke the source credential immediately and verify all derived human sessions return HTTP 401.
2. Use the customer recovery code only through the verified recovery path.
3. Verify the old credential returns HTTP 401 and the replacement can read only the customer workspace receipt.
4. Inspect durable credential and human-session audit events.
5. Never paste tokens or recovery codes into chat, logs, tickets, or screenshots.

## Provider failure

1. Preserve the original request ID, mandate ID, and provider response status.
2. Confirm the persisted receipt state and failure code.
3. For `reconciliation_hold`, do not mark `confirm_not_billed` without provider-side evidence.
4. Resolve only with a durable external reference and operator note.
5. Re-run the original readback after resolution and confirm the ledger and receipt agree.

## Alert thresholds

Alert on two consecutive readiness failures, audit or limiter unavailability, invite rejection surges, onboarding rollback failure, onboarding operations in progress for more than 15 minutes, a derived session accepted after source revocation, or a reconciliation hold older than 15 minutes.

Control mode has no signer, wallet, x402, or customer-to-Fuse payment authority. Any such runtime configuration or behavior is a release blocker.

## Evidence requirements

A beta incident is not closed until the final response includes the request ID, durable receipt state, operational audit events, limiter/onboarding state where applicable, reconciliation resolution, and credential/session status. Do not claim provider billing outcomes without provider-side evidence.
