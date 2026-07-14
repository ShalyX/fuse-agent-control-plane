import { describe, expect, it } from "vitest";
import {
  createApiCredential,
  hashApiToken,
  tokenMatchesHash,
  createServiceAccountCredential,
  serviceAccountRoleAllowsCapabilities,
  type ApiCapability,
} from "../src/identity/apiCredentials.js";

const input = {
  id: "cred-1",
  organizationId: "org-1",
  agentId: "agent-1",
  name: "Scout runtime",
  capabilities: ["inference:invoke", "receipts:read", "inference:invoke"] as const,
  createdAt: "2026-07-13T12:00:00.000Z",
  expiresAt: "2026-08-13T12:00:00.000Z",
};

describe("API credentials", () => {
  it("issues a high-entropy token once while retaining only its hash and display prefix", () => {
    const issued = createApiCredential(input, () => Buffer.alloc(32, 7));

    expect(issued.token).toMatch(/^fuse_sk_[A-Za-z0-9_-]+$/);
    expect(issued.record).toEqual({
      ...input,
      capabilities: ["inference:invoke", "receipts:read"],
      tokenPrefix: issued.token.slice(0, 20),
      tokenHash: hashApiToken(issued.token),
      revokedAt: null,
    });
    expect(issued.record).not.toHaveProperty("token");
    expect(tokenMatchesHash(issued.token, issued.record.tokenHash)).toBe(true);
    expect(tokenMatchesHash(`${issued.token}x`, issued.record.tokenHash)).toBe(false);
  });

  it("supports policy administration capabilities while preserving role ceilings", () => {
    const policiesRead = "policies:read" as ApiCapability;
    const policiesWrite = "policies:write" as ApiCapability;
    const mandateAdmin = "mandates:admin" as ApiCapability;
    expect(() => createServiceAccountCredential({
      id: "service-cred-1",
      organizationId: "org-1",
      serviceAccountId: "service-1",
      name: "policy administration",
      capabilities: [policiesRead, policiesWrite, mandateAdmin],
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    })).not.toThrow();
    expect(serviceAccountRoleAllowsCapabilities("viewer", [policiesRead])).toBe(true);
    expect(serviceAccountRoleAllowsCapabilities("viewer", [policiesWrite])).toBe(false);
    expect(serviceAccountRoleAllowsCapabilities("operator", [mandateAdmin])).toBe(false);
  });

  it("rejects unknown capabilities and invalid expiry windows", () => {
    expect(() => createApiCredential({
      ...input,
      capabilities: ["wallet:drain" as "inference:invoke"],
    })).toThrow("API_CREDENTIAL_CAPABILITY_INVALID");

    expect(() => createApiCredential({
      ...input,
      expiresAt: input.createdAt,
    })).toThrow("API_CREDENTIAL_EXPIRY_INVALID");
  });
});
