import { describe, expect, it } from "vitest";
import { API_CAPABILITIES } from "../src/identity/apiCredentials.js";
import type { AdministrativePrincipal } from "../src/identity/credentialAdministration.js";
import { MemoryHumanSessionStore } from "../src/http/humanSessions.js";
import { IdentityStore } from "../src/persistence/identityStore.js";
import { WorkspaceInviteService } from "../src/identity/workspaceInvites.js";
import { newAdvisoryMemoryDb } from "./helpers/pgMemAdvisory.js";

describe("workspace invites", () => {
  it("issues a one-time invite, creates a scoped human session, and records acceptance", async () => {
    const db = newAdvisoryMemoryDb();
    const pool = new (db.adapters.createPg().Pool)();
    const identityStore = new IdentityStore(pool);
    const sessions = new MemoryHumanSessionStore();
    const now = "2026-09-05T10:00:00.000Z";
    await identityStore.createOrganization({
      id: "org-invites", name: "Invite Workspace", actorId: "test", causationId: "setup", occurredAt: now,
    });
    const service = new WorkspaceInviteService(identityStore, sessions, () => now, () => Buffer.alloc(32, 21));
    const principal: AdministrativePrincipal = {
      principalType: "service_account",
      principalId: "service-admin",
      organizationId: "org-invites",
      credentialId: "credential-admin",
      capabilities: [...API_CAPABILITIES],
      role: "admin",
    };

    const issued = await service.issue(principal, {
      email: " Teammate@Example.com ", name: " Teammate ", role: "operator", requestId: "invite-1",
    });
    expect(issued.inviteToken).toMatch(/^fuse_wi_[A-Za-z0-9_-]+$/);
    expect(issued.email).toBe("teammate@example.com");
    expect(issued.name).toBe("Teammate");
    expect((await service.list("org-invites"))[0]).toMatchObject({
      inviteId: issued.inviteId, email: "teammate@example.com", role: "operator", acceptedAt: null, revokedAt: null,
    });

    const accepted = await service.accept(issued.inviteToken);
    expect(accepted).toMatchObject({
      workspaceId: "org-invites", role: "operator", expiresAt: "2026-09-06T10:00:00.000Z",
    });
    expect(accepted.sessionToken).toMatch(/^fuse_hs_[A-Za-z0-9_-]+$/);
    await expect(sessions.resolve(accepted.sessionToken, now)).resolves.toMatchObject({
      workspaceId: "org-invites", userId: accepted.userId, role: "member", sourceCredentialId: "credential-admin",
    });
    expect((await service.list("org-invites"))[0].acceptedAt).toBe(now);
    await expect(service.accept(issued.inviteToken)).rejects.toThrow("WORKSPACE_INVITE_INVALID");
  });

  it("lets an admin revoke a pending invite without affecting another workspace", async () => {
    const db = newAdvisoryMemoryDb();
    const pool = new (db.adapters.createPg().Pool)();
    const identityStore = new IdentityStore(pool);
    const now = "2026-09-05T10:00:00.000Z";
    await identityStore.createOrganization({
      id: "org-revoke", name: "Revoke Workspace", actorId: "test", causationId: "setup", occurredAt: now,
    });
    const service = new WorkspaceInviteService(
      identityStore,
      new MemoryHumanSessionStore(),
      () => now,
      () => Buffer.alloc(32, 22),
    );
    const principal: AdministrativePrincipal = {
      principalType: "service_account", principalId: "service-admin", organizationId: "org-revoke",
      credentialId: "credential-admin", capabilities: [...API_CAPABILITIES], role: "admin",
    };
    const issued = await service.issue(principal, {
      email: "pending@example.com", name: "Pending", role: "viewer", requestId: "invite-2",
    });
    await expect(service.revoke(principal, issued.inviteId, "revoke-1")).resolves.toBeUndefined();
    expect((await service.list("org-revoke"))[0].revokedAt).toBe(now);
    await expect(service.accept(issued.inviteToken)).rejects.toThrow("WORKSPACE_INVITE_INVALID");
  });
});
