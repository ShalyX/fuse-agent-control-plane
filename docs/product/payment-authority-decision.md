# Fuse payment authority decision

Status: approved for invite-only alpha

Decision: launch Fuse in control mode.

## Boundary

The customer pays the supported inference provider directly. Fuse does not custody customer funds, hold provider settlement authority, sign Gateway payments, operate agent wallets, or claim finalized payment settlement.

Fuse is responsible for:

- tenant-scoped provider configuration
- immutable policy and bounded mandate authority
- admission, reservation, and spend ceilings
- branch-local containment and circuit decisions
- provider usage reconciliation
- receipts, audit evidence, and idempotent retries
- fail-closed handling for ambiguous provider outcomes

## First release constraints

- Invite-only workspaces
- One canonical hosted provider path: OpenRouter with an explicitly configured model and tariff
- Control mode only
- Deterministic sandbox available before live inference
- No wallet connection or automatic chain signing in the customer path
- No claim of Gateway settlement, custody, or mainnet execution
- Provider credentials are write-only inputs and are never returned after save
- Live execution remains unavailable until provider configuration, policy, mandate, and agent readiness are verified

## Payment state language

The product may report provider configuration and Fuse accounting state. It must not label a provider call as paid, settled, finalized, or Gateway-authorized unless authoritative payment evidence exists.

Sandbox runs report payment and chain evidence as `not_applicable`.

Unknown provider or payment outcomes enter reconciliation and must not be automatically redispatched.

## Authentication boundary

The initial alpha uses an invite-only workspace credential/session path. Raw service credentials are an implementation boundary for the private alpha, not the intended broader-beta login experience. A managed identity or magic-link path is required before broad public onboarding.

## Exit criteria for changing this decision

A settlement-mode proposal requires separate approval covering signer authority, custody, withdrawal, reconciliation, incident response, legal/product copy, and hosted end-to-end evidence. This document must be updated before enabling any settlement authority.
