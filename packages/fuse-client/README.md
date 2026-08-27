# @fuse/fuse-client

Typed client for the Fuse product API.

The package does not contain provider credentials, Circle keys, signer secrets, or server internals. It sends a workspace or agent credential to an already deployed Fuse API.

## Build

```bash
npm run build
```

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
