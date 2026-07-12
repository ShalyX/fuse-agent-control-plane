# Fuse — Pitch Deck

## 1. Autonomous agents need programmable spending controls

Agents increasingly purchase inference and services without a human approving every call. Existing API billing is account-level and retrospective: by the time a runaway loop is visible, the spend has already happened.

**Fuse gives each agent branch an allowance, meters actual usage, settles exact USDC, and cuts off only the branch that violates policy.**

---

## 2. The failure mode

A multi-agent workflow has a shared treasury:

- Scout researches.
- Builder executes.
- Reviewer verifies.

Scout enters a retry storm. A root-level kill switch stops the entire workflow. No kill switch allows Scout to consume the shared budget.

The missing primitive is **branch-local financial containment**.

---

## 3. The product

Fuse sits between calling agents and paid inference:

1. Reserve against an agent-specific allowance.
2. Call the provider once.
3. Read provider-reported token usage.
4. Price the exact completion in micro-USDC.
5. Hold the response behind HTTP `402`.
6. Accept Circle Gateway authorization.
7. Reconcile payment and release the held response.

---

## 4. The containment policy

Fuse evaluates cost after real usage is known.

- Hard ceiling: the child cannot exceed its delegated allowance.
- Acceleration circuit: two consecutive calls at least 4× the previous cost trip that branch.
- Reclaim: unused authority returns to the parent reserve.
- Isolation: sibling branches continue independently.

---

## 5. Why Arc

Arc is the session authorization and commitment layer.

- USDC-native programmable money environment.
- One on-chain transaction opens the spending mandate.
- Circle Gateway handles exact per-call payment authorizations off-chain.
- One on-chain transaction closes the mandate with aggregate spend and a receipt-bundle hash.

This preserves Nanopayment economics instead of reintroducing per-call gas.

---

## 6. Verified run

| Branch | Usage | Paid | Result |
|---|---:|---:|---|
| Scout 01 | 30 / 6 tokens | $0.000180 | HEALTHY |
| Scout 02 | 320 / 6 tokens | $0.001050 | ELEVATED |
| Scout 03 | 1,928 / 6 tokens | $0.005874 | TRIPPED |
| Reviewer | 36 / 6 tokens | $0.000198 | HEALTHY |

Scout's unused `$0.052896` allowance was reclaimed. Reviewer continued. A later Scout request was rejected before another provider call or payment.

---

## 7. Durable payment state

Neon Postgres persists:

- root and child budgets
- reservations
- circuit state
- held provider responses
- idempotency results
- payment receipts
- reclaim events

A live proof split one request across two Node processes: process A returned `402`, was terminated, and process B released the same persisted response after payment without repeating inference.

---

## 8. On-chain proof

**Arc Testnet contract**

`0xf736609aa15b255322df4d5dfe6ea66b59b7c663`

**Golden run**

- Cap: `250000` atomic USDC
- Final paid: `7302` atomic USDC
- Receipt commitment: `0x91391b64514c0b4ec350b864dc1f8ad34b51d69180746e818c8420a75f70325c`

Exactly two mandate transactions: open and close.

---

## 9. What comes next

- Official Anthropic production traffic when API access is funded
- Multi-provider price and quality routing
- Reusable policy templates
- Per-agent delegated wallets
- Finalized Gateway batch reconciliation
- Historical run explorer and team controls

---

## 10. Close

**Fuse turns a shared agent treasury into scoped, observable, programmable authority.**

One runaway agent trips. The rest of the system keeps working.

- Product: https://fuse-agent-control-plane.vercel.app
- Run record: https://fuse-agent-control-plane.vercel.app/api/runs/demo-mandate
- Source: https://github.com/ShalyX/fuse-agent-control-plane
