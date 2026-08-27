# Fuse final submission pack

Prepared for the Encode / Arc Agentic Economy submission.

## Project name

Fuse

## One-line description

Fuse gives autonomous agent branches scoped USDC allowances, meters actual inference usage, settles exact payments through Circle Gateway, and trips only the branch whose cost pattern runs away.

## Short description

Agent workflows increasingly purchase inference and services autonomously, but ordinary API billing is account-level and retrospective. A retry storm in one branch can consume a shared budget, while a root-level kill switch stops useful sibling agents too.

Fuse introduces branch-local financial containment. A parent mandate funds delegated child branches. Each branch receives a bounded allowance, exact inference usage is priced from provider-reported usage, and HTTP 402 payment requirements are held until an authorized Circle Gateway payment is available. Fuse watches repeated cost acceleration and trips only the runaway branch, reclaiming unused authority while healthy siblings continue.

## What is novel

Fuse treats agent spending as an isolation problem rather than a single account balance problem. The key invariant is branch-local failure containment: one agent can become expensive or unstable without taking down the rest of the workflow.

The system combines:

- Parent-funded root mandates
- Delegated child allowances
- Exact pricing from provider-reported usage
- HTTP 402 response holding
- Circle Gateway EIP-3009 authorization
- Repeated-cost-acceleration circuit breaking
- Automatic reclaim of unused child authority
- Deterministic final receipt commitment on Arc

## How the demo works

1. A root mandate funds multiple agent branches.
2. Scout executes increasingly expensive work.
3. Fuse measures the actual cost progression.
4. Scout moves from healthy to elevated to tripped after repeated acceleration.
5. Unused Scout authority is reclaimed.
6. Reviewer continues operating and completes a paid request.
7. The final aggregate commitment is anchored on Arc Testnet.

## Verified demo results

- Scout cost progression: `$0.000180 → $0.001050 → $0.005874`
- Measured accelerations: `5.83×`, then `5.59×`
- Circuit state: `HEALTHY → ELEVATED → TRIPPED`
- Reclaimed Scout authority: `$0.052896`
- Reviewer continued and paid `$0.000198`
- Golden aggregate committed on Arc: `$0.007302`
- Cold-start Builder payment: `$0.000192`

## Sponsor and ecosystem usage

Fuse uses Circle and Arc as load-bearing parts of the control loop:

- Circle Developer-Controlled Wallets provide the signer boundary.
- Circle Gateway provides batched x402 payment authorization.
- USDC is the accounting and settlement asset.
- Arc Testnet anchors the session opening and closing mandate transactions and the final aggregate commitment.
- Neon Postgres stores durable mandates, reservations, receipts, circuit state, and reconciliation evidence.

## Technical architecture

- Express and TypeScript control-plane gateway
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

## Judge walkthrough

Open the control desk first. Show the persisted run and the Scout state transition from healthy to elevated to tripped. Point to the reclaimed allowance and the Reviewer continuation. Then open the Arc contract and the open and close transactions to show the session-level commitment boundary.

The important distinction is that Fuse does not globally stop the agent system when one branch misbehaves. It isolates the cost runaway and preserves useful sibling work.

## Honest limitations

- Historical paid receipts were produced with the previous provider backend.
- The official Anthropic adapter is implemented and tested but awaits funded API access for new live evidence.
- This is a testnet control plane, not production custody or audited financial infrastructure.
- Gateway receipts report `pending_batch`; Fuse does not claim finalized batch membership where Circle does not expose it.
- The latest V4 reliability fixes are verified locally but are not yet published to the public repository.

## Submission checklist

### Required artifacts

- [x] Project name and track selected
- [x] Public GitHub repository exists
- [x] Live product URL exists
- [x] Live control desk URL exists
- [x] Persisted evidence route exists
- [x] Arc contract link included
- [x] Open and close transaction links included
- [x] Demo video recorded and rendered locally
- [ ] Demo video uploaded to a public host
- [ ] Final video URL inserted into the submission form
- [ ] Final public commit published to GitHub

### Final verification before submitting

- [x] `npm run check` passes locally
- [x] TypeScript build passes
- [x] No placeholder URLs in judge-facing Markdown
- [x] No secrets included in the submission copy
- [x] Live product `/health` responds successfully
- [x] Live product `/ready` reports database, provider configuration, and workload-shadow readiness
- [ ] Verify the submitted GitHub commit matches the intended final candidate
- [x] Verify the rendered video is under the organizer's time limit
- [ ] Watch the uploaded video from the public URL
- [ ] Open every submitted link in an incognito window
- [ ] Submit the form
- [ ] Save the confirmation URL or screenshot

## Video brief

Target length: 90 seconds.

- 0:00–0:10: State the problem: account-level billing cannot isolate a runaway agent branch.
- 0:10–0:25: Show the root mandate and delegated branches.
- 0:25–0:50: Run Scout and show the cost acceleration and circuit transition.
- 0:50–1:05: Show reclaimed authority and Reviewer continuation.
- 1:05–1:20: Show the persisted evidence and Arc commitment.
- 1:20–1:30: State the invariant: one runaway branch trips without stopping useful siblings.

Avoid claiming that the Base mainnet payment path is settled. The submission proof is the verified Arc Testnet control-plane run and its linked evidence.

## Form paste block

Fuse is a branch-local spending control plane for autonomous agents. A parent mandate funds delegated branches with scoped USDC allowances. Fuse meters provider-reported inference usage, holds HTTP 402 payment responses until authorization is available, and detects repeated cost acceleration. When one branch runs away, Fuse trips that branch, reclaims unused authority, and lets healthy sibling agents continue. Circle Developer-Controlled Wallets and Circle Gateway provide the signing and batched x402 payment path. Arc Testnet anchors the session mandate and final aggregate commitment. The demo shows a real Scout transition from HEALTHY to ELEVATED to TRIPPED, `$0.052896` reclaimed authority, Reviewer continuation, and a `$0.007302` aggregate committed on Arc.

## Checkpoint 3 form fields

### Submission details

Fuse is a branch-local spending control plane for autonomous agents. It addresses a specific failure mode in agentic systems: ordinary API billing is account-level and retrospective, so a retry storm or runaway worker can consume a shared budget and force an operator to stop every useful sibling agent.

The project starts with a parent-funded mandate and delegates bounded USDC allowances to child branches. Each branch reserves against its own allowance, executes real provider work, and reconciles against provider-reported usage. Payment requirements are held through HTTP 402 until the authorized Circle Gateway payment path is available. Fuse records durable reservations, receipts, circuit state, and reconciliation evidence in Neon Postgres.

The central control is repeated-cost-acceleration detection. In the verified run, Scout progressed from `$0.000180` to `$0.001050` to `$0.005874`, with measured accelerations of `5.83×` and `5.59×`. Fuse moved Scout from `HEALTHY` to `ELEVATED` to `TRIPPED`, reclaimed `$0.052896` of unused authority, and allowed Reviewer to continue and complete a `$0.000198` paid request. The final aggregate commitment was anchored on Arc Testnet at `$0.007302`.

Circle Developer-Controlled Wallets provide the signer boundary, Circle Gateway provides batched x402 authorization, USDC is the accounting asset, and Arc Testnet anchors the session opening, closing, and final commitment boundary. The live control desk and linked Arc transactions expose the run as inspectable evidence rather than a mock dashboard.

This submission is a testnet control plane, not production custody or audited financial infrastructure. Historical paid receipts were produced with the previous provider backend. The official Anthropic adapter is implemented and tested but awaits funded API access for new live evidence. Gateway receipts report `pending_batch` where Circle does not expose finalized batch membership.

### Link to Code

https://github.com/ShalyX/fuse-agent-control-plane

### Link to Demo Video

BLOCKER: insert the public demo video URL after recording and uploading the 90-second walkthrough.

### Link to Presentation

https://canva.link/mz3563xcawster5

### Live Demo Link

https://fuse-agent-control-plane.vercel.app/desk

### Team introduction video

BLOCKER: insert the public team introduction video URL. Do not submit the example or placeholder URL.

### Track selection

- Select: Agentic Economy Track
- Do not select DeFi Track unless the submission is expanded with a genuine DeFi-specific user flow and evidence.
