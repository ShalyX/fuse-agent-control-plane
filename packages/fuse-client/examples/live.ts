import { createFuseClient, executeWithFuseMiddleware } from "../src/index.js";

const fuse = createFuseClient({
  baseUrl: process.env.FUSE_BASE_URL ?? "http://localhost:3000",
  credential: process.env.FUSE_CREDENTIAL ?? "replace-me",
});

const outcome = await executeWithFuseMiddleware(
  fuse,
  {
    mandateId: process.env.FUSE_MANDATE_ID ?? "mandate-1",
    requestId: crypto.randomUUID(),
    model: "configured-model",
    maxTokens: 128,
    messages: [{ role: "user", content: "hello" }],
  },
  {
    onUncertain: async (error) => {
      console.error("execution requires review; do not retry automatically", error.code);
    },
  },
);

switch (outcome.kind) {
  case "completed":
    console.log(outcome.result.response);
    break;
  case "authorization_denied":
  case "payment_required":
  case "idempotency_conflict":
  case "uncertain":
    console.error(outcome.kind, outcome.error.code);
    process.exitCode = 1;
}
