# @fuse/fuse-client

Typed client for the Fuse product API.

The package does not contain provider credentials, Circle keys, signer secrets, or server internals. It sends a workspace or agent credential to an already deployed Fuse API.

## Build

```bash
npm run build
```

## OpenRouter integration quickstart

Fuse control mode keeps the provider key in your workspace and gives the runtime a scoped agent credential. Your application uses the `fuse_sk_…` or derived agent credential; it never needs a Fuse wallet or settlement key.

```bash
npm install @fuse/fuse-client
```

```ts
import { createFuseClient } from "@fuse/fuse-client";

const fuse = createFuseClient({
  baseUrl: process.env.FUSE_BASE_URL ?? "https://fuse-agent-control-plane.vercel.app",
  credential: process.env.FUSE_AGENT_CREDENTIAL!,
});

const workspace = await fuse.workspaceContext();
const requestId = crypto.randomUUID();
const { result, receipt } = await fuse.inferenceWithReceipt({
  mandateId: workspace.mandateId,
  requestId,
  model: workspace.model!,
  maxTokens: 256,
  messages: [{ role: "user", content: "Summarize this task in one sentence." }],
});

console.log(result.response);
console.log({
  requestId: receipt.requestId,
  status: receipt.executionStatus,
  reserved: receipt.reservedCostAtomic,
  actual: receipt.actualCostAtomic,
});
```

The helper performs one inference request and then reads the durable receipt. It does not retry an uncertain execution. Keep the `requestId` if you need to inspect the same run later with `fuse.getReceipt(workspace.mandateId, requestId)`.

Required environment variables:

```bash
FUSE_BASE_URL=https://fuse-agent-control-plane.vercel.app
FUSE_AGENT_CREDENTIAL=fuse_sk_...
```

The agent credential needs `inference:invoke`, `mandates:read`, and `receipts:read`. Provider API keys remain configured in the Fuse workspace and are never returned to the client.

## Usage

```ts
import { createFuseClient } from "@fuse/fuse-client";

const fuse = createFuseClient({
  baseUrl: process.env.FUSE_BASE_URL!,
  credential: process.env.FUSE_CREDENTIAL!,
});

const run = await fuse.runSandbox("golden-path");
console.log(run.scout.circuitState, run.reviewer.status);

const receipt = await fuse.getReceipt("mandate-1", "request-1");
```

For a copyable version of this flow, see [`docs/integration-quickstart.md`](../../docs/integration-quickstart.md).

## Safety

- `inference()` preserves the caller's idempotency key.
- The client does not automatically retry uncertain executions.
- Cursors are passed through as opaque values.
- Sandbox responses are explicitly marked `mode: "sandbox"`.
- API failures throw `FuseClientError` with `status`, `code`, and structured details.

The first integration mode is the authenticated product API. Real provider and payment configuration remain server-side concerns.

## Middleware integration

Use `executeWithFuseMiddleware` when an application needs to map product outcomes into its provider loop:

```ts
import { executeWithFuseMiddleware } from "@fuse/fuse-client";

const outcome = await executeWithFuseMiddleware(fuse, input, {
  onUncertain: async (error) => {
    console.error("hold for review", error.code);
  },
});

if (outcome.kind === "completed") {
  console.log(outcome.result.response);
} else {
  // authorization_denied, payment_required, idempotency_conflict,
  // and uncertain are explicit non-success outcomes.
  console.error(outcome.kind, outcome.error.code);
}
```

The middleware never retries an uncertain execution. `REQUEST_IN_PROGRESS` and idempotency conflicts are returned to the caller. HTTP 402 and `PAYMENT_REQUIRED` are returned as `payment_required`. Authorization failures are returned as `authorization_denied`.

Runnable examples are in `examples/sandbox.ts` and `examples/live.ts`.
