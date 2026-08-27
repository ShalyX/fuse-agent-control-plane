# Fuse product contract

## User

A developer or platform team operating autonomous agents that call paid inference or service APIs.

## Core job

Connect an agent workflow, assign each logical branch a bounded USDC allowance, observe actual usage, and contain a runaway branch without stopping healthy siblings.

## Golden path

Create workspace → connect provider → create sandbox mandate → add Scout and Reviewer branches → run sandbox → trip Scout → observe Reviewer continue → inspect receipt.

## Product objects

- Workspace: organization-scoped operator boundary.
- Environment: sandbox, testnet, or mainnet.
- Provider connection: tenant-owned provider metadata and an indirect credential reference.
- Root mandate: the top-level spending authority governed by existing ledger and policy rules.
- Agent branch: a child authority with its own allowance and circuit state.
- Execution: one admitted or denied workload attempt.
- Receipt: durable evidence of the execution outcome and financial state.
- Circuit event: a durable state transition explaining why a branch was elevated, tripped, or disabled.

## Product-facing states

- Workspace: active or suspended.
- Environment: sandbox, testnet, or mainnet.
- Branch: healthy, elevated, tripped, or disabled.
- Execution: admitted, denied, executing, completed, held, or failed.

## Invariants

The product layer is an interface and read-model layer around the existing control plane. It does not create a second ledger, bypass policy admission, mutate balances directly, or authorize signing. Root and child authority remain bounded by the existing financial and lifecycle rules.

## MVP non-goals

Consumer wallet UX, marketplace workflows, arbitrary DeFi, broad multi-chain support, arbitrary provider routing, independent custody wallets per agent, finalized Gateway claims when settlement evidence is unavailable, enterprise SSO, and replacement of the existing payment abstraction.
