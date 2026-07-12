# Fuse — Three-Minute Demo Script

## 0:00–0:20 — The problem

“Autonomous agents can spend money faster than a human can supervise them. Most billing controls are account-wide and retrospective. Fuse gives each branch its own allowance, meters actual inference usage, and isolates runaway cost without killing the whole workflow.”

Open:

https://fuse-agent-control-plane.vercel.app

## 0:20–0:45 — The system

Point to the root authorization and the three branches:

- Scout: research
- Builder: execution
- Reviewer: verification

“Each branch shares one parent-funded mandate, but Fuse enforces independent authority and circuit state.”

## 0:45–1:25 — The failure and containment

Open the control desk:

https://fuse-agent-control-plane.vercel.app/desk

Run the clearly labeled local policy replay.

Narrate:

1. Scout starts healthy.
2. The first 4× cost acceleration elevates the branch.
3. The second acceleration trips Scout.
4. Fuse reclaims the unused allowance.
5. Reviewer remains healthy and continues.

Say explicitly: “This animation is a deterministic policy replay. The paid network evidence is separate on the right.”

## 1:25–2:05 — Persisted paid evidence

Open:

https://fuse-agent-control-plane.vercel.app/api/runs/demo-mandate

Show:

- `persistence: postgres`
- five receipts
- provider-reported token usage
- Circle authorization hashes
- Scout `HEALTHY → ELEVATED → TRIPPED`
- Builder cold-start receipt

“The Builder receipt crossed a real process restart. The first process called the provider and returned HTTP 402. The second process loaded the held response from Postgres and released it after payment without another inference call.”

## 2:05–2:35 — Arc commitment

Open the contract:

https://testnet.arcscan.app/address/0xf736609aa15b255322df4d5dfe6ea66b59b7c663

Then the close transaction:

https://testnet.arcscan.app/tx/0x03a9f53dc180865a7168cf44f6f0ed2da03fe246aa7f68ddb286abe6cd27d772

“Fuse does not write every completion on-chain. Circle Gateway authorizes exact micro-payments off-chain. Arc sees one open and one close transaction, with aggregate spend and a deterministic receipt-bundle hash.”

## 2:35–3:00 — Close

“Fuse is a programmable spending control plane for the agentic economy. It turns one shared treasury into branch-scoped authority: measurable, reclaimable, and independently stoppable.”

End on the landing page proof section.

## Accuracy boundary

The committed paid run used the previous provider backend. The official Anthropic Messages API integration is implemented and tested, but live official-Anthropic evidence is pending funded API access. Do not describe the historical receipts as official Anthropic traffic.
