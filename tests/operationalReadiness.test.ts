import request from "supertest";
import { expect, it } from "vitest";
import { createFuseApp } from "../src/http/app.js";

const readiness = {
  controlMode: true,
  settlementDisabled: true,
  durableInviteGate: true,
  durableAdminRateLimit: true,
  sourceCredentialRevocationEnforced: true,
  staleOnboardingOperations: 0,
  rollbackFailedOnboardingOperations: 0,
  oldestInProgressAt: null,
};

it("returns authenticated operational readiness without exposing configuration secrets", async () => {
  const app = createFuseApp({
    provider: { complete: async () => ({ text: "unused", inputTokens: 0, outputTokens: 0 }) },
    estimateInputTokens: () => 0,
    credentialAuthenticator: {
      authenticateToken: async (token) => token === "operator-token"
        ? {
            principalType: "service_account" as const,
            principalId: "operator",
            organizationId: "workspace-1",
            credentialId: "credential-1",
            capabilities: ["policies:read" as const],
          }
        : null,
    },
    operationalReadiness: async () => readiness,
  });

  const unauthenticated = await request(app).get("/api/v1/admin/readiness");
  expect(unauthenticated.status).toBe(401);

  const response = await request(app)
    .get("/api/v1/admin/readiness")
    .set("Authorization", "Bearer operator-token");
  expect(response.status).toBe(200);
  expect(response.body).toEqual(readiness);
  expect(JSON.stringify(response.body)).not.toContain("token");
});
