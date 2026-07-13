import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createCapabilityGuard, type CredentialAuthenticator } from "../src/http/auth.js";

const authenticator: CredentialAuthenticator = {
  authenticateToken: async () => null,
};

function createApp(auth: CredentialAuthenticator = authenticator) {
  const app = express();
  app.get(
    "/protected",
    createCapabilityGuard(auth, "mandates:read", () => "2026-07-14T00:00:00.000Z"),
    (_request, response) => response.json({ principal: response.locals.fusePrincipal }),
  );
  return app;
}

describe("capability authentication middleware", () => {
  it("rejects requests without a bearer credential", async () => {
    const response = await request(createApp()).get("/protected");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { code: "AUTHENTICATION_REQUIRED" } });
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("rejects an invalid bearer credential", async () => {
    const response = await request(createApp())
      .get("/protected")
      .set("Authorization", "Bearer fuse_sk_invalid");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { code: "INVALID_CREDENTIAL" } });
  });

  it("rejects a valid credential that lacks the required capability", async () => {
    const limited: CredentialAuthenticator = {
      authenticateToken: async () => ({
        organizationId: "org-1",
        agentId: "agent-1",
        credentialId: "cred-1",
        capabilities: ["receipts:read"],
      }),
    };
    const response = await request(createApp(limited))
      .get("/protected")
      .set("Authorization", "Bearer fuse_sk_valid");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { code: "INSUFFICIENT_CAPABILITY" } });
  });

  it("returns a sanitized availability error when credential verification fails", async () => {
    const unavailable: CredentialAuthenticator = {
      authenticateToken: async () => { throw new Error("postgres://secret-host/internal"); },
    };
    const response = await request(createApp(unavailable))
      .get("/protected")
      .set("Authorization", "Bearer fuse_sk_valid");
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: { code: "AUTHENTICATION_UNAVAILABLE" } });
    expect(response.text).not.toContain("secret-host");
  });
});
