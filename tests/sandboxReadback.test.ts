import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createFuseApp } from "../src/http/app.js";
import type { CredentialAuthenticator } from "../src/http/auth.js";
import type { SandboxRun } from "../src/product/sandboxRuns.js";
import type { SandboxRunStore } from "../src/product/sandboxRunStore.js";

const run: SandboxRun = {
  runId: "sandbox_abcdef0123456789abcdef01",
  workspaceId: "workspace-readback",
  seed: "golden-path",
  mode: "sandbox",
  status: "completed",
  scout: { branchId: "scout", circuitState: "TRIPPED", reclaimedAtomic: "50000" },
  reviewer: { branchId: "reviewer", status: "completed", actualCostAtomic: "10000" },
  events: [],
  ledger: { rootSettledAtomic: "60000", scoutSettledAtomic: "50000", reviewerSettledAtomic: "10000" },
};

it("reads back a workspace-scoped durable sandbox run", async () => {
  const credentialAuthenticator: CredentialAuthenticator = {
    authenticateToken: async () => ({
      principalType: "service_account", principalId: "operator-readback", organizationId: "workspace-readback",
      credentialId: "cred-readback", capabilities: ["sandbox:run"], role: "operator",
    }),
  };
  const store: SandboxRunStore = {
    async get(workspaceId, runId) {
      return workspaceId === run.workspaceId && runId === run.runId ? run : null;
    },
    async put() {},
  };
  const app = createFuseApp({
    provider: { complete: async () => ({ id: "unused", content: "unused", usage: { inputTokens: 0, outputTokens: 0 } }) },
    paymentGuard: () => (_request, response) => response.status(402).end(),
    estimateInputTokens: () => 1,
    credentialAuthenticator,
    sandboxRunService: { run: () => run, runDurable: async () => run } as never,
    sandboxRunStore: store,
  });

  const response = await request(app).get("/api/v1/product/sandbox/runs/sandbox_abcdef0123456789abcdef01")
    .set("Authorization", "Bearer readback");

  expect(response.status).toBe(200);
  expect(response.body).toEqual(run);
});
