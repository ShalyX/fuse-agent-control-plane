import { createFuseClient } from "../src/index.js";

const fuse = createFuseClient({
  baseUrl: process.env.FUSE_BASE_URL ?? "http://localhost:3000",
  credential: process.env.FUSE_CREDENTIAL ?? "replace-me",
});

const run = await fuse.runSandbox("golden-path");
if (run.mode !== "sandbox") throw new Error("sandbox response lost its mode");
console.log({ runId: run.runId, scout: run.scout.circuitState, reviewer: run.reviewer.status });
