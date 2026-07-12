# Fuse — Encode / Arc Programmable Money Submission

## One-liner

Fuse gives autonomous agent branches scoped USDC allowances, meters actual inference usage, settles exact payments through Circle Gateway, and trips only the branch whose cost pattern runs away.

## Track

Agentic Economy

## Problem

Agent workflows increasingly purchase inference and services autonomously, but existing API billing is account-level and retrospective. A retry storm in one branch can consume a shared budget, while a root-level kill switch stops useful sibling agents too.

## Solution

Fuse introduces branch-local financial containment:

- parent-funded root mandate
- delegated child allowances
- exact pricing from provider-reported usage
- HTTP `402` response holding
- Circle Gateway EIP-3009 authorization
- repeated-cost-acceleration circuit
- automatic reclaim of unused child authority
- deterministic final receipt commitment on Arc

## Why Arc

Arc anchors the session cap and final aggregate commitment while Circle Gateway handles exact per-call authorizations. Fuse uses exactly two mandate transactions per session—open and close—so it does not negate Nanopayment batching with per-completion gas.

## Technical architecture

- Express / TypeScript gateway
- Official Anthropic Messages API adapter staged for production access
- Circle Developer-Controlled Wallet signer
- Circle Gateway x402 batching
- Neon Postgres durable state
- Solidity `FuseSpendMandate` on Arc Testnet
- Vercel public desk and evidence API

## Public links

- Product: https://fuse-agent-control-plane.vercel.app
- Control desk: https://fuse-agent-control-plane.vercel.app/desk
- Persisted run: https://fuse-agent-control-plane.vercel.app/api/runs/demo-mandate
- Repository: https://github.com/ShalyX/fuse-agent-control-plane
- Arc contract: https://testnet.arcscan.app/address/0xf736609aa15b255322df4d5dfe6ea66b59b7c663
- Open transaction: https://testnet.arcscan.app/tx/0xe92bb389d8b05c6121274c2bc7e1edf4a2ecd150afd18dc339eec8aa2aecab9b
- Close transaction: https://testnet.arcscan.app/tx/0x03a9f53dc180865a7168cf44f6f0ed2da03fe246aa7f68ddb286abe6cd27d772

## Verified results

- Scout: `$0.000180 → $0.001050 → $0.005874`
- Measured accelerations: `5.83×`, then `5.59×`
- Circuit: `HEALTHY → ELEVATED → TRIPPED`
- Reclaimed Scout authority: `$0.052896`
- Reviewer continued and paid `$0.000198`
- Golden aggregate committed on Arc: `$0.007302`
- Cold-start Builder payment: `$0.000192`
- Tests: 24 core tests plus official-Anthropic adapter tests

## Honest limitations

- The historical paid receipts were produced with the previous provider backend.
- The official Anthropic adapter is implemented and tested but awaits funded API access for new live evidence.
- This is a testnet control plane, not production custody or audited financial infrastructure.
- Gateway receipts report `pending_batch`; Fuse does not claim finalized batch membership where Circle does not expose it.

## Roadmap

- live official-Anthropic proof
- multi-provider routing by price and quality threshold
- policy templates
- per-agent delegated wallets
- finalized batch reconciliation
- authenticated team controls and historical run explorer
