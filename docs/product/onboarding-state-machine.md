# Fuse onboarding state machine

## States

- `created` — workspace exists but identity setup is incomplete.
- `identity_ready` — authenticated workspace identity is available.
- `provider_pending` — provider configuration was submitted and is awaiting verification.
- `provider_verified` — one supported provider configuration has passed verification.
- `payment_pending` — the selected payment path is being checked or reconciled.
- `payment_ready` — payment prerequisites are verified for the selected product mode.
- `agent_pending` — agent identity or scoped credential setup is incomplete.
- `mandate_pending` — policy, root mandate, or branch binding is incomplete.
- `ready_to_run` — required prerequisites are verified and a bounded run may begin.
- `first_run_completed` — at least one bounded run produced a durable receipt.
- `blocked` — the workspace is suspended or requires operator action.

## Legal transitions

```text
created → identity_ready
identity_ready → provider_pending | provider_verified
provider_pending → provider_verified
provider_verified → payment_pending | payment_ready
payment_pending → payment_ready
payment_ready → agent_pending
agent_pending → mandate_pending
mandate_pending → ready_to_run
ready_to_run → first_run_completed

Any non-blocked state → blocked
blocked → created
```

The implementation may use an abbreviated transition when a prerequisite is already verified, but it must not skip a required invariant. For example, a workspace creation flow may establish identity, provider, payment, agent, and mandate state atomically, but the resulting state must still be explainable through the same state vocabulary.

## Transition record

Every transition records:

- Workspace ID
- Previous state
- New state
- Event type
- Actor ID
- Request ID
- Timestamp
- Block reason when entering `blocked`

## Rules

- Invalid transitions fail closed with `ONBOARDING_INVALID_TRANSITION`.
- A blocked workspace cannot advance until explicitly unblocked.
- A state transition does not itself prove payment settlement.
- `ready_to_run` requires the product mode’s actual prerequisites, not merely configuration presence.
- `first_run_completed` requires durable receipt readback.
- Recovery and replay must not duplicate workspace, credential, provider, mandate, or payment side effects.
