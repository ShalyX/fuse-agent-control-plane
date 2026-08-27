# Fuse product-layer threat model

## Trust boundaries

- Workspace operator: authenticated human or service-account principal. Organization scope comes from the credential, never from a request body.
- Agent credential: separate from operator credentials and limited to declared capabilities.
- Provider credential: accepted once through administration, stored only through the existing provider credential boundary, and never returned by read APIs.
- Control plane: authoritative for admission, reservation, idempotency, lifecycle, receipts, and circuit state.
- Payment guard and Gateway: external payment evidence boundary. Configuration is not settlement evidence.
- Signer service: isolated signing boundary. Control-plane credentials must not contain signer secrets.
- Arc or Base: external chain evidence boundary. A signature or request intent is not proof of finalized settlement.

## Abuse cases and required controls

### Cross-workspace read

An attacker supplies another organization ID. The API must derive organization scope from the authenticated principal and return the same safe authorization error for missing or unauthorized scope.

### Branch escalation

A child requests more authority than its root mandate. Existing root and child accounting, policy checks, and lifecycle transitions must reject the request before any provider or payment action.

### Replay or duplicate payment

A request is retried with the same idempotency key or a changed payload. Existing idempotency semantics must replay the completed result or reject the changed payload. Payment evidence must not be duplicated.

### Leaked provider credential

Logs, receipts, readiness responses, and list APIs must expose metadata only. Provider secrets are never included in product read models or error responses.

### Untrusted receipt or webhook data

External data is treated as evidence input, not authority. Reconciliation remains explicit and idempotent. A missing, delayed, or conflicting Gateway index result produces a discrepancy, never an automatic repeated deposit.

### Suspended workspace

Suspended workspaces may be read according to role policy but cannot initiate provider configuration, mandate mutation, or paid execution.

## Release gates

- Cross-tenant authorization tests pass.
- Readiness never claims payment readiness from configuration alone.
- Provider mismatch fails before provider invocation.
- Denial never calls the provider or payment guard.
- Signer secrets are absent from control-plane configuration and logs.
- Mainnet success requires facilitator settlement evidence.
