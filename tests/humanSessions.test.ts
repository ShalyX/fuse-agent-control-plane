import { describe, expect, it } from "vitest";
import {
  MemoryHumanSessionStore,
  createHumanSession,
} from "../src/http/humanSessions.js";
import { createSessionAwareAuthenticator } from "../src/http/auth.js";
import { API_CAPABILITIES } from "../src/identity/apiCredentials.js";

describe("human workspace sessions", () => {
  it("rejects a session after its source credential is revoked", async () => {
    const store = new MemoryHumanSessionStore();
    const session = createHumanSession({
      workspaceId: "workspace-1", userId: "user-1", role: "owner",
      sourceCredentialId: "credential-source",
      createdAt: "2026-08-14T00:00:00.000Z", expiresAt: "2026-08-14T01:00:00.000Z",
    }, () => Buffer.alloc(32, 6));
    await store.put(session.record);
    const authenticator = createSessionAwareAuthenticator({
      authenticateToken: async () => null,
      isCredentialActive: async (_workspaceId, _credentialId, sourceCredentialType) => {
        expect(sourceCredentialType).toBe("service_account");
        return false;
      },
    }, store);

    await expect(authenticator.authenticateToken(session.token, "2026-08-14T00:30:00.000Z"))
      .resolves.toBeNull();
  });

  it("creates an opaque workspace-scoped session and resolves it before expiry", async () => {
    const store = new MemoryHumanSessionStore();
    const session = createHumanSession({
      workspaceId: "workspace-1",
      userId: "user-1",
      sourceCredentialId: "credential-source",
      role: "owner",
      createdAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2026-08-14T01:00:00.000Z",
    }, () => Buffer.alloc(32, 7));
    await store.put(session.record);

    expect(session.token).toMatch(/^fuse_hs_[A-Za-z0-9_-]+$/);
    expect(session.token).not.toContain("workspace-1");
    await expect(store.resolve(session.token, "2026-08-14T00:30:00.000Z")).resolves.toMatchObject({
      workspaceId: "workspace-1",
      userId: "user-1",
      sourceCredentialId: "credential-source",
      role: "owner",
    });
  });

  it("rejects expired and revoked sessions", async () => {
    const store = new MemoryHumanSessionStore();
    const session = createHumanSession({
      workspaceId: "workspace-1",
      userId: "user-1",
      sourceCredentialId: "credential-source",
      role: "member",
      createdAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2026-08-14T01:00:00.000Z",
    }, () => Buffer.alloc(32, 8));
    await store.put(session.record);

    await expect(store.resolve(session.token, "2026-08-14T01:00:00.000Z")).resolves.toBeNull();
    await store.revoke(session.token, "2026-08-14T00:45:00.000Z");
    await expect(store.resolve(session.token, "2026-08-14T00:50:00.000Z")).resolves.toBeNull();
  });

  it("does not let a token lookup select another workspace", async () => {
    const store = new MemoryHumanSessionStore();
    const session = createHumanSession({
      workspaceId: "workspace-1",
      userId: "user-1",
      sourceCredentialId: "credential-source",
      role: "owner",
      createdAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2026-08-14T01:00:00.000Z",
    }, () => Buffer.alloc(32, 9));
    await store.put(session.record);

    await expect(store.resolveForWorkspace(session.token, "workspace-2", "2026-08-14T00:30:00.000Z"))
      .resolves.toBeNull();
  });

  it("allows an administrator to revoke one session by scoped id", async () => {
    const store = new MemoryHumanSessionStore();
    const session = createHumanSession({
      workspaceId: "workspace-1", userId: "user-1", sourceCredentialId: "credential-source", role: "owner",
      createdAt: "2026-08-14T00:00:00.000Z", expiresAt: "2026-08-14T01:00:00.000Z",
    }, () => Buffer.alloc(32, 10));
    await store.put(session.record);
    await expect(store.revokeById(session.record.id, "workspace-2", "2026-08-14T00:30:00.000Z")).resolves.toBe(false);
    await expect(store.revokeById(session.record.id, "workspace-1", "2026-08-14T00:30:00.000Z")).resolves.toBe(true);
    await expect(store.resolve(session.token, "2026-08-14T00:45:00.000Z")).resolves.toBeNull();
  });

  it("lists only sessions belonging to the requested workspace without token material", async () => {
    const store = new MemoryHumanSessionStore();
    const first = createHumanSession({
      workspaceId: "workspace-1", userId: "user-1", sourceCredentialId: "credential-source", role: "owner",
      createdAt: "2026-08-14T00:00:00.000Z", expiresAt: "2026-08-14T01:00:00.000Z",
    }, () => Buffer.alloc(32, 11));
    const second = createHumanSession({
      workspaceId: "workspace-2", userId: "user-2", sourceCredentialId: "credential-other", role: "member",
      createdAt: "2026-08-14T00:05:00.000Z", expiresAt: "2026-08-14T01:00:00.000Z",
    }, () => Buffer.alloc(32, 12));
    await store.put(first.record);
    await store.put(second.record);

    await expect(store.listByWorkspace("workspace-1", "2026-08-14T00:30:00.000Z")).resolves.toEqual([{
      sessionId: first.record.id,
      workspaceId: "workspace-1",
      userId: "user-1",
      sourceCredentialId: "credential-source",
      role: "owner",
      createdAt: first.record.createdAt,
      expiresAt: first.record.expiresAt,
      revokedAt: null,
    }]);
  });

  it("gives human operators inspection and sandbox access without live inference authority", async () => {
    const store = new MemoryHumanSessionStore();
    const session = createHumanSession({
      workspaceId: "workspace-1", userId: "operator-1", sourceCredentialId: "credential-source", role: "member",
      createdAt: "2026-08-14T00:00:00.000Z", expiresAt: "2026-08-14T01:00:00.000Z",
    }, () => Buffer.alloc(32, 13));
    await store.put(session.record);
    const authenticator = createSessionAwareAuthenticator({
      authenticateToken: async () => ({
        principalType: "service_account" as const,
        principalId: "service-1",
        organizationId: "workspace-1",
        credentialId: "credential-source",
        capabilities: [...API_CAPABILITIES],
        role: "operator" as const,
      }),
      isCredentialActive: async () => true,
    }, store);

    await expect(authenticator.authenticateToken(session.token, "2026-08-14T00:30:00.000Z"))
      .resolves.toMatchObject({
        role: "operator",
        capabilities: expect.arrayContaining(["mandates:read", "receipts:read", "policies:read", "providers:read", "sandbox:run"]),
      });
    const principal = await authenticator.authenticateToken(session.token, "2026-08-14T00:30:00.000Z");
    expect(principal?.capabilities).not.toContain("inference:invoke");
    expect(principal?.capabilities).not.toContain("mandates:write");
  });
});
