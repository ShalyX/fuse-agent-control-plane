# Fuse OpenRouter integration quickstart

This is the supported private-alpha integration path. Fuse control mode lets your team keep paying OpenRouter directly while Fuse enforces a scoped policy, mandate, and request ceiling around each agent call.

## 1. Create the workspace

Open the [Fuse operator console](https://fuse-agent-control-plane.vercel.app/console), use your beta invite, and save the one-time service credential, agent credential, and recovery code.

The service credential restores the human operator session. The agent credential is what your runtime uses for inference. Do not put either value in a browser bundle or commit them to source control.

## 2. Configure the provider

The workspace creation form configures the first OpenRouter connection. If you are restoring an existing workspace, open `Provider`, confirm the model, and save the OpenRouter API key. The key is write-only after submission.

The initial beta supports one provider path:

```text
provider: openrouter
model:   anthropic/claude-sonnet-4.6
```

## 3. Install the client

```bash
npm install @fuse/fuse-client
```

Use the agent credential in a server-side process:

```ts
import { createFuseClient, executeWithFuseMiddleware } from "@fuse/fuse-client";

const fuse = createFuseClient({
  baseUrl: process.env.FUSE_BASE_URL ?? "https://fuse-agent-control-plane.vercel.app",
  credential: process.env.FUSE_AGENT_CREDENTIAL!,
});

const workspace = await fuse.workspaceContext();
const requestId = crypto.randomUUID();

const outcome = await executeWithFuseMiddleware(
  fuse,
  {
    mandateId: workspace.mandateId,
    requestId,
    model: workspace.model!,
    maxTokens: 256,
    messages: [{ role: "user", content: "Return a one-line status update." }],
  },
  {
    onUncertain: async (error) => {
      console.error("Fuse placed this execution into review; do not retry automatically.", error.code);
    },
  },
);

if (outcome.kind !== "completed") {
  throw new Error(`Fuse did not complete the request: ${outcome.kind}`);
}

const receipt = await fuse.getReceipt(workspace.mandateId, requestId);
console.log(outcome.result.response);
console.log(receipt.receipt.executionStatus, receipt.receipt.actualCostAtomic);
```

For the shortest path, `fuse.inferenceWithReceipt(input)` combines the inference call and durable receipt readback.

## Request rules

- Generate a new `requestId` for each logical request and persist it with your job record.
- Reusing a `requestId` with a changed payload is an idempotency conflict.
- `REQUEST_IN_PROGRESS`, `REQUEST_REQUIRES_REVIEW`, and `INFERENCE_EXECUTION_UNAVAILABLE` are not safe automatic-retry signals.
- `POLICY_DENIED` means Fuse rejected the call before provider dispatch.
- Control mode does not return HTTP 402 and does not perform wallet settlement.

## Inspect runs

The console's `Runs` view reads the same durable receipt API used by the SDK. It is scoped to the active workspace and mandate. Select a run to inspect its decision outcome, policy version, reserved cost, reported provider cost, and reconciliation state.

The API equivalents are:

```text
GET /api/v1/product/mandates/:mandateId/receipts
GET /api/v1/product/receipts/:requestId
```

Both require an authenticated credential with `receipts:read` and the receipt endpoint requires `X-Fuse-Mandate`.

## What Fuse does not do in this beta

The provider bills your OpenRouter account directly. Fuse does not custody funds, sign wallet transactions, settle Gateway payments, or claim Arc mainnet settlement evidence. Those are separate future product decisions.
