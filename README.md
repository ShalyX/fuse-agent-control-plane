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

## Phase 1 API spine

The OpenAI-compatible `POST /v1/chat/completions` route is implemented and tested end-to-end with an injected provider and payment guard:

1. Requires `Idempotency-Key` and `X-Fuse-Child` headers.
2. Reserves worst-case token cost against child and root budgets.
3. Calls the provider only once and holds the response.
4. Computes an exact micro-USDC quote from provider-reported usage.
5. Dynamically invokes Circle Gateway x402 middleware for that exact price.
6. Reuses the cached inference on the paid retry.
7. Reconciles the reservation and returns an OpenAI-compatible response with a Fuse receipt.

The production server is wired to AgentRouter's OpenAI-compatible endpoint with its mandatory exact User-Agent and real Circle Gateway middleware.

### Live metered inference evidence

A live `claude-opus-4-8` request completed through the entire Fuse path:

- AgentRouter returned real usage: 27 input tokens and 15 output tokens.
- Fuse calculated an exact charge of `0.000306` USDC using the configured demo price schedule.
- The first Fuse response was HTTP `402`.
- The Circle Developer-Controlled parent EOA signed the exact EIP-3009 authorization.
- Circle Gateway accepted settlement reference `8b9f04db-4d52-44d4-b12e-d932c8315bfb` on `eip155:5042002`.
- The paid retry returned HTTP `200` with `FUSE LIVE PAID OK`.
- The receipt identifies the real parent payer, logical child `scout`, exact token usage, exact charge, and Gateway settlement reference.

The `3.00` input / `15.00` output USDC-per-million values are Fuse's current configurable demo schedule; they are not represented as AgentRouter's underlying provider price.

```bash
npm run dev
```

## Public demo

- Control desk: [fuse-agent-control-plane.vercel.app/desk](https://fuse-agent-control-plane.vercel.app/desk)
- State API: [fuse-agent-control-plane.vercel.app/api/state](https://fuse-agent-control-plane.vercel.app/api/state)
- Source and evidence: [github.com/ShalyX/fuse-agent-control-plane](https://github.com/ShalyX/fuse-agent-control-plane)

The public deployment makes the desk and initial state independently inspectable. The current ledger and held-response cache are still in memory; the committed golden run was executed against one persistent local process. Do not present the serverless deployment as durable payment infrastructure until the ledger moves to transactional storage.

## Golden combined run

The live combined run now exercises the full system in one process:

1. Three real AgentRouter calls from Scout with provider-reported token usage.
2. One real Circle Gateway Nanopayment per completed call.
3. Genuine cost acceleration from growing prompt context: `$0.000180 → $0.001050 → $0.004350`.
4. `HEALTHY → ELEVATED → TRIPPED` after two consecutive increases above 4×.
5. Automatic reclaim of Scout's remaining `$0.054420` allowance to the parent pool.
6. A subsequent Scout request blocked with HTTP `409 BRANCH_TRIPPED` before inference.
7. A real Reviewer inference and `$0.000198` payment succeeding while Scout remains tripped.

The resulting parent reserve increased from `$0.020000` to `$0.074420`. The complete receipt set is committed at [`evidence/golden-run-2026-07-12.json`](evidence/golden-run-2026-07-12.json).

Run it with:

```bash
npm run dev
node --env-file=.env --import tsx scripts/golden-run.ts
```

## Control desk

`GET /desk` serves the browser-tested control plane for the hackathon demo. It includes:

- Root and child budget tree for Scout, Builder, and Reviewer.
- A clearly labeled deterministic isolation replay that does not incur provider or payment charges.
- `HEALTHY → ELEVATED → TRIPPED` Scout progression.
- Reviewer continuation after Scout isolation.
- The real live AgentRouter/Circle settlement reference as payment evidence.
- Responsive layout and reduced-motion handling.

`GET /api/state` exposes the current in-memory ledger and circuit state without serializing bigint values directly.

## Current implementation note

The current ledger is in-memory and suitable only for the executable spine. Before deploying the multi-child API, reservations must move to transactional SQLite/PostgreSQL so concurrent workers cannot overspend through races.
