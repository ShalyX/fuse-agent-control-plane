# Fuse

**Programmable money controls for autonomous AI.**

Fuse is a financial control plane for metered AI inference: a parent agent delegates scoped allowances to logical child agents, Fuse reserves worst-case request cost, reconciles real provider token usage, and isolates a runaway branch without stopping the rest.

## Verified locally

- Hierarchical root/child budget accounting in integer micro-USDC
- Atomic-in-process reservation semantics and idempotency conflicts
- Exact token pricing and worst-case reservation pricing
- Deterministic `HEALTHY → ELEVATED → TRIPPED` circuit behavior
- Held-response flow that produces an exact x402 quote and releases only after payment acceptance
- Executable three-child isolation demo

```bash
npm install
npm run check
npm run demo
```

## Circle Phase 0 status

The live Circle flow is deliberately not mocked. It requires:

- `CIRCLE_API_KEY`
- `CIRCLE_ENTITY_SECRET`
- `CIRCLE_WALLET_SET_ID`
- Arc Testnet USDC

The integration must prove, against current Circle documentation and SDKs:

1. Create/use a Developer-Controlled Wallet on Arc Testnet.
2. Deposit USDC into Circle Gateway.
3. Produce the exact EIP-3009 authorization required by Gateway Nanopayments.
4. Complete an x402 paid retry.
5. Verify buyer/seller Gateway balances and settlement evidence.

Until this succeeds, Fuse reports its Circle adapter as **blocked by credentials**, not simulated or complete.

## Architecture boundary

Children are logical Fuse identities. The parent Circle wallet is the payer and owns the shared Gateway balance. Fuse checks each child capability and root mandate before requesting a parent-wallet signature. The Arc mandate contract, when added, is an audit/revocation commitment—not the enforcement point.

## Current implementation note

The current ledger is in-memory and suitable only for the executable spine. Before deploying the multi-child API, reservations must move to transactional SQLite/PostgreSQL so concurrent workers cannot overspend through races.
