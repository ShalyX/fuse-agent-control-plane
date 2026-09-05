import { randomBytes, randomUUID } from "node:crypto";
import { hashApiToken } from "./apiCredentials.js";
import type { AdministrativePrincipal } from "./credentialAdministration.js";
import type { IdentityStore, WorkspaceInviteRole } from "../persistence/identityStore.js";
import {
  createHumanSession,
  type HumanSessionRole,
  type HumanSessionStore,
} from "../http/humanSessions.js";

const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_HUMAN_SESSION_MS = 24 * 60 * 60 * 1_000;

export interface IssueWorkspaceInviteInput {
  email: string;
  name: string;
  role: WorkspaceInviteRole;
  requestId: string;
}

export interface IssuedWorkspaceInvite {
  inviteId: string;
  workspaceId: string;
  email: string;
  name: string;
  role: WorkspaceInviteRole;
  inviteToken: string;
  expiresAt: string;
}

export interface AcceptedWorkspaceInvite {
  sessionToken: string;
  sessionId: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceInviteRole;
  expiresAt: string;
}

function sessionRoleForInvite(role: WorkspaceInviteRole): HumanSessionRole {
  return role === "admin" ? "owner" : role === "operator" ? "member" : "viewer";
}

export class WorkspaceInviteService {
  constructor(
    private readonly identityStore: IdentityStore,
    private readonly humanSessionStore: HumanSessionStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly entropy: (size: number) => Buffer = randomBytes,
  ) {}

  async issue(
    principal: AdministrativePrincipal,
    input: IssueWorkspaceInviteInput,
  ): Promise<IssuedWorkspaceInvite> {
    if (principal.principalType !== "service_account" || principal.role !== "admin") {
      throw new Error("SERVICE_ACCOUNT_ADMIN_REQUIRED");
    }
    if (!input.requestId.trim()) throw new Error("REQUEST_ID_REQUIRED");
    const sourceCredentialType = principal.sessionSourceCredentialType ?? "service_account";
    if (sourceCredentialType !== "service_account") {
      throw new Error("SERVICE_ACCOUNT_SOURCE_REQUIRED");
    }
    const createdAt = this.now();
    const expiresAt = new Date(Date.parse(createdAt) + INVITE_LIFETIME_MS).toISOString();
    const secret = this.entropy(32);
    if (secret.length < 32) throw new Error("WORKSPACE_INVITE_ENTROPY_INSUFFICIENT");
    const inviteToken = `fuse_wi_${secret.toString("base64url")}`;
    const inviteId = `wsi_${randomUUID().replaceAll("-", "")}`;
    const sourceCredentialId = principal.sessionSourceCredentialId ?? principal.credentialId;
    await this.identityStore.createWorkspaceInvite({
      id: inviteId,
      organizationId: principal.organizationId,
      email: input.email,
      name: input.name,
      role: input.role,
      sourceCredentialId,
      sourceCredentialType,
      tokenHash: hashApiToken(inviteToken),
      createdAt,
      expiresAt,
      actorId: `service_account:${principal.principalId}`,
      causationId: input.requestId,
      occurredAt: createdAt,
    });
    return {
      inviteId,
      workspaceId: principal.organizationId,
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      role: input.role,
      inviteToken,
      expiresAt,
    };
  }

  async list(workspaceId: string) {
    return this.identityStore.listWorkspaceInvites(workspaceId);
  }

  async revoke(
    principal: AdministrativePrincipal,
    inviteId: string,
    requestId: string,
  ): Promise<void> {
    if (principal.principalType !== "service_account" || principal.role !== "admin") {
      throw new Error("SERVICE_ACCOUNT_ADMIN_REQUIRED");
    }
    if (!requestId.trim()) throw new Error("REQUEST_ID_REQUIRED");
    const revoked = await this.identityStore.revokeWorkspaceInvite(
      principal.organizationId,
      inviteId,
      {
        actorId: `service_account:${principal.principalId}`,
        causationId: requestId,
        occurredAt: this.now(),
      },
    );
    if (!revoked) throw new Error("WORKSPACE_INVITE_NOT_ACTIVE");
  }

  async accept(inviteToken: string): Promise<AcceptedWorkspaceInvite> {
    const now = this.now();
    if (!/^fuse_wi_[A-Za-z0-9_-]{32,128}$/.test(inviteToken.trim())) {
      throw new Error("WORKSPACE_INVITE_INVALID");
    }
    const invite = await this.identityStore.consumeWorkspaceInvite(hashApiToken(inviteToken), now);
    if (!invite) throw new Error("WORKSPACE_INVITE_INVALID");
    const createdAt = now;
    const inviteExpiry = Date.parse(invite.expiresAt);
    const sessionExpiresAt = new Date(Math.min(
      Date.parse(createdAt) + MAX_HUMAN_SESSION_MS,
      inviteExpiry,
    )).toISOString();
    const session = createHumanSession({
      workspaceId: invite.workspaceId,
      userId: invite.userId,
      sourceCredentialId: invite.sourceCredentialId,
      sourceCredentialType: invite.sourceCredentialType,
      role: sessionRoleForInvite(invite.role),
      createdAt,
      expiresAt: sessionExpiresAt,
    }, this.entropy);
    await this.humanSessionStore.put(session.record);
    return {
      sessionToken: session.token,
      sessionId: session.record.id,
      workspaceId: invite.workspaceId,
      userId: invite.userId,
      role: invite.role,
      expiresAt: session.record.expiresAt,
    };
  }
}
