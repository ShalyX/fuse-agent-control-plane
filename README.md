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

The official integration packages are installed and their current TypeScript declarations compile in this repository:

- `@circle-fin/x402-batching`
- `@x402/core`
- `@x402/evm`
- `@circle-fin/developer-controlled-wallets`
- `viem`

Fuse now includes a tested adapter from Circle Developer-Controlled Wallet `client.signTypedData(...)` to the signer interface required by `BatchEvmScheme`. The adapter enforces the `GatewayWalletBatched` EIP-712 domain and serializes bigint payment fields safely.

The live Circle flow is deliberately not mocked. It uses:

- `CIRCLE_API_KEY`
- `CIRCLE_ENTITY_SECRET`
- A live Arc Testnet Developer-Controlled EOA
- Arc Testnet USDC

Phase 0 proves, against current Circle documentation and SDKs:

1. Use a Developer-Controlled Wallet on Arc Testnet.
2. Deposit USDC into Circle Gateway.
3. Produce the exact EIP-3009 authorization required by Gateway Nanopayments.
4. Complete an x402 paid retry.
5. Verify payer balance movement and Gateway settlement evidence.

**Phase 0 is complete.** Final seller balance credit remains asynchronous because Gateway batches settlement; its settlement reference is recorded below.

### Live Phase 0 evidence

- Circle API authentication succeeded.
- Ten live Arc Testnet Developer-Controlled EOA wallets were discovered.
- A funded Arc Testnet EOA was selected and its wallet balance was verified.
- ERC-20 approval completed on Arc Testnet: `0x7e42dab5bf341e328546bbfee0507d2e8c75bc5068da97c59af0e9fff47c994a`.
- Gateway deposit completed on Arc Testnet: `0x06a89c672cddac713ad3de55a5727b53fbc36aa797cfa5b2b2bbe79f382616b2`.
- Gateway balance was verified at `0.001` USDC after deposit.
- A real protected endpoint returned HTTP `402 Payment Required`.
- The parent Developer-Controlled EOA signed the real `GatewayWalletBatched` EIP-712 payload through Circle `signTypedData`.
- Circle Gateway accepted and settled the paid retry; the endpoint returned HTTP `200`.
- Gateway settlement reference: `d6ceaae5-6a63-42f6-9630-78af396d18fa` on `eip155:5042002`.
- Buyer Gateway available balance decreased from `0.001` to `0.000999` USDC.
- Seller credit was not yet visible during the first minute of balance polling, consistent with the payment remaining in Gateway's batch-settlement lifecycle; do not claim final seller credit until observed.

## Architecture boundary

Children are logical Fuse identities. The parent Circle wallet is the payer and owns the shared Gateway balance. Fuse checks each child capability and root mandate before requesting a parent-wallet signature. The Arc mandate contract, when added, is an audit/revocation commitment—not the enforcement point.

## Current implementation note

The current ledger is in-memory and suitable only for the executable spine. Before deploying the multi-child API, reservations must move to transactional SQLite/PostgreSQL so concurrent workers cannot overspend through races.
