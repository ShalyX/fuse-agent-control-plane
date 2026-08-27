# Fuse customer journey

## Primary customer

A developer or platform team operating autonomous agents that call paid inference or service APIs.

## Customer outcome

Fuse gives the team a bounded, inspectable path from workspace setup to an accountable inference receipt. The product makes branch-local financial exposure visible and contains a runaway branch without stopping healthy siblings.

## Golden path

1. Create or authenticate a workspace.
2. Confirm the setup checklist and environment mode.
3. Connect one supported provider and verify the configuration.
4. Confirm the payment/custody boundary for the selected mode.
5. Create an agent and issue a scoped credential.
6. Publish or select a bounded spending policy.
7. Create a root mandate and bind an agent branch.
8. Activate the mandate only after prerequisites are verified.
9. Run the deterministic sandbox first.
10. Run one bounded inference when the supported provider/payment path is ready.
11. Inspect the decision, reserved cost, reported cost, payment state, circuit state, and receipt.
12. Retry only with documented idempotency semantics.
13. Pause a branch, revoke a credential, or place an uncertain execution into reconciliation.
14. Return later and recover the same workspace state.

## Product modes

### Sandbox

No real provider, payment, wallet, or chain calls. The sandbox exercises the real ledger, reservation, circuit, reclaim, and sibling-continuation primitives with injected usage. Every result is labeled `mode: sandbox` and payment/Arc evidence is `not_applicable`.

### Control mode

The customer pays the supported provider directly. Fuse enforces policy, reservation, metering, circuit containment, and evidence. This is the recommended first external product boundary until a settlement authority model is approved.

### Settlement mode

A separately approved path may authorize payment through the configured rail. Configuration is not settlement evidence. Pending Gateway state stays `pending_batch`; unknown outcomes enter reconciliation; finalized claims require authoritative evidence.

## Success definition

A customer journey is complete only when the customer can reach a durable receipt and later read it back without an engineer editing the database. A passing HTTP status or a dashboard screenshot alone is not sufficient.

## Explicit non-goals

Consumer wallet UX, a marketplace, arbitrary DeFi, broad multi-chain support, unbounded provider routing, independent custody wallets per agent, enterprise SSO, and automatic mainnet signing are outside the first product release.
