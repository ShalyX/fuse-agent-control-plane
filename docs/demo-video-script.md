# Fuse demo video script

Target length: 105–107 seconds
Format: 16:9 desktop capture
Tone: calm, direct, proof-first
Primary URL: https://fuse-agent-control-plane.vercel.app/desk

## Core message

One runaway agent branch should not stop every useful agent. Fuse gives each branch a bounded USDC allowance, detects accelerating spend, trips only the runaway branch, and preserves sibling work.

## Recording rules

- Record the real control desk and live evidence routes.
- Do not show secrets, browser notifications, terminal credentials, or private dashboards.
- Use the existing persisted run. Do not attempt a new paid Base request during recording.
- Do not claim that the Base mainnet payment path is settled.
- Keep the cursor movement slow and pause for one second after each state change.
- Use large browser text or a 1440px-plus viewport so the figures are readable.
- Keep captions anchored in a reserved lower-third safe zone. Never place a large centered label over a metric, state badge, transaction link, or chart.
- Use short two-to-six-word captions only when the UI does not already make the point.
- Prefer small inline callouts beside the relevant evidence. Let the live UI remain the dominant visual layer.

## Shot-by-shot script

### 0:00–0:08 — Hook

Screen:
Open the Fuse control desk. Keep the full dashboard visible for two seconds.

Voiceover:
"Fuse is a spending control plane for autonomous agents. It gives every agent branch a bounded USDC allowance, then trips only the branch whose costs start running away."

On-screen caption:
"Branch-local spending containment"

### 0:08–0:18 — Establish the system

Screen:
Show the root mandate, the branch list, and the Scout and Reviewer cards. Do not click yet.

Voiceover:
"A parent mandate funds delegated agent branches. Each branch has its own USDC allowance, durable receipts, and circuit state, so one runaway worker does not consume the whole workflow's budget."

On-screen caption:
"One mandate. Isolated branch allowances."

### 0:18–0:31 — Show the cost pattern

Screen:
Scroll or move to the persisted run evidence. Highlight Scout's cost progression.

Voiceover:
"Each provider request reserves against the branch allowance. After execution, Fuse reconciles that reservation against actual usage. In this verified run, Scout's cost moves from eighteen hundredths of a mill to one thousand fifty micro-USDC, then to five thousand eight hundred seventy-four micro-USDC."

On-screen caption:
"$0.000180 → $0.001050 → $0.005874"

### 0:31–0:43 — Show acceleration detection

Screen:
Highlight the acceleration values and the Scout state indicator.

Voiceover:
"Fuse measures the acceleration, not just the current balance. The measured jumps are five point eight three times and five point five nine times."

On-screen caption:
"5.83× acceleration · 5.59× acceleration"

### 0:43–0:55 — Show the circuit trip

Screen:
Focus on Scout's state transition or persisted evidence showing HEALTHY, ELEVATED, and TRIPPED.

Voiceover:
"Scout moves from healthy to elevated and then tripped. Fuse stops that branch before it can consume the remaining shared authority."

On-screen caption:
"HEALTHY → ELEVATED → TRIPPED"

### 0:55–1:05 — Show reclaim

Screen:
Highlight the reclaimed authority figure.

Voiceover:
"The frozen Scout allowance is returned to the parent reserve. The violating branch closes, while Reviewer remains authorized."

On-screen caption:
"Frozen allowance returned"

### 1:05–1:16 — Show sibling continuity

Screen:
Highlight Reviewer remaining healthy and its paid completion.

Voiceover:
"The important part is what does not happen. Reviewer continues operating and completes its paid request while Scout is isolated. Circle handles the per-call authorization and payment path."

On-screen caption:
"Reviewer continues · $0.000198 paid"

### 1:16–1:25 — Show Arc proof

Screen:
Open the persisted evidence route, then show the Arc contract or the open and close transaction links.

Voiceover:
"Arc anchors the session boundary and final aggregate, so the control decision has durable, inspectable evidence instead of a simulated success screen."

On-screen caption:
"Arc Testnet commitment · $0.007302 aggregate"

### 1:25–1:30 — Close

Screen:
Return to the control desk's main state view. Hold the final frame.

Voiceover:
"Fuse gives autonomous agents room to work, while making runaway spending local, visible, and containable."

On-screen caption:
"Let useful agents continue. Trip the runaway branch."

## Full voiceover copy

"Fuse is a spending control plane for autonomous agents. It gives every agent branch a bounded USDC allowance, then trips only the branch whose costs start running away.

A parent mandate funds delegated agent branches. Each branch has its own USDC allowance, durable receipts, and circuit state, so one runaway worker does not consume the whole workflow's budget.

Each provider request reserves against the branch allowance. After execution, Fuse reconciles that reservation against actual usage. In this verified run, Scout's cost moves from eighteen hundredths of a mill to one thousand fifty micro-USDC, then to five thousand eight hundred seventy-four micro-USDC.

Fuse measures the acceleration, not just the current balance. The measured jumps are five point eight three times and five point five nine times.

Scout moves from healthy to elevated and then tripped. Fuse stops that branch before it can consume the remaining shared authority.

The frozen Scout allowance is returned to the parent reserve. The violating branch closes, while Reviewer remains authorized.

The important part is what does not happen. Reviewer continues operating and completes its paid request while Scout is isolated. Circle handles the per-call authorization and payment path.

Arc anchors the session boundary and final aggregate, so the control decision has durable, inspectable evidence instead of a simulated success screen.

Fuse gives autonomous agents room to work, while making runaway spending local, visible, and containable."

## Upload metadata

Suggested title:

Fuse — Branch-local spending control for autonomous agents

Suggested description:

Fuse gives autonomous agent branches bounded USDC allowances and isolates runaway spending without stopping healthy sibling agents. This demo shows a live Scout cost acceleration, the HEALTHY → ELEVATED → TRIPPED circuit transition, frozen allowance returned to the parent reserve, Reviewer continuation, Circle Gateway payment authorization, and the final Arc Testnet commitment.

## Claims to avoid

- Do not say the Base mainnet payment path settled successfully.
- Do not call the testnet control plane audited financial infrastructure.
- Do not claim finalized Gateway batch membership where the receipt only says `pending_batch`.
- Do not describe the persisted run as a newly generated live payment if it is the historical verified run.
- Do not narrate `$0.052896` while recording the current replay. The current live replay displays `$0.028500` reclaimed.

## Caption and label layout

Captions are annotations, not title cards.

- Use a compact lower-left or lower-right caption block with a maximum width of 28% of the frame.
- Keep the block outside the primary dashboard content whenever possible.
- Use 30–36px text at 1920×1080, with a maximum of two lines.
- Use a translucent `#08090a` panel at approximately 82% opacity, a thin `#1a1c1e` border, and 16px internal padding.
- Use white for explanatory text and Fuse indigo, amber, or green only for the specific value or state being called out.
- Never cover the Scout cost figures, acceleration values, circuit badge, Reviewer card, reclaimed amount, or Arc transaction links.
- Do not repeat a UI label as a giant overlay. If the dashboard already says `TRIPPED`, use a small pointer or a quiet caption such as `Runaway branch isolated`.
- Fade captions in and out over 180–240ms. Do not animate them across the interface.
- If a caption would cover evidence, move it to the empty margin or omit it.

Suggested compact captions:

- `Branch-local spending containment`
- `Actual usage reconciliation`
- `Cost acceleration detected`
- `Runaway branch isolated`
- `Frozen allowance returned`
- `Reviewer continues`
- `Arc commitment evidence`
