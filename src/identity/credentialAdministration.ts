import { randomBytes } from "node:crypto";
import {
  createApiCredential,
  createServiceAccountCredential,
  type ApiCapability,
  type ServiceAccountRole,
} from "./apiCredentials.js";
import type { IdentityStore } from "../persistence/identityStore.js";

export interface AdministrativePrincipal {
  principalType: "agent" | "service_account";
  principalId: string;
  organizationId: string;
  credentialId: string;
  capabilities: readonly ApiCapability[];
  role?: ServiceAccountRole;
}

export interface IssueAgentCredentialInput {
  credentialId: string;
  agentId: string;
  name: string;
  capabilities: readonly ApiCapability[];
  expiresAt?: string | null;
  requestId: string;
}

export interface IssueServiceAccountCredentialInput {
  credentialId: string;
  serviceAccountId: string;
  name: string;
  capabilities: readonly ApiCapability[];
  expiresAt?: string | null;
  requestId: string;
}

const agentCapabilities = new Set<ApiCapability>([
  "inference:invoke",
  "mandates:read",
  "mandates:write",
  "receipts:read",
]);

export interface CredentialAdministrationPort {
  issueAgentCredential(
    principal: AdministrativePrincipal,
    input: IssueAgentCredentialInput,
  ): Promise<{
    credentialId: string;
    token: string;
    tokenPrefix: string;
    capabilities: ApiCapability[];
    expiresAt: string | null;
  }>;
  revokeAgentCredential(
    principal: AdministrativePrincipal,
    credentialId: string,
    requestId: string,
  ): Promise<void>;
  issueServiceAccountCredential(
    principal: AdministrativePrincipal,
    input: IssueServiceAccountCredentialInput,
  ): Promise<{
    credentialId: string;
    token: string;
    tokenPrefix: string;
    capabilities: ApiCapability[];
    expiresAt: string | null;
  }>;
  revokeServiceAccountCredential(
    principal: AdministrativePrincipal,
    credentialId: string,
    requestId: string,
  ): Promise<void>;
}

export class CredentialAdministration implements CredentialAdministrationPort {
  constructor(
    private readonly store: IdentityStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly entropy: (size: number) => Buffer = randomBytes,
  ) {}

  async issueAgentCredential(
    principal: AdministrativePrincipal,
    input: IssueAgentCredentialInput,
  ): Promise<{
    credentialId: string;
    token: string;
    tokenPrefix: string;
    capabilities: ApiCapability[];
    expiresAt: string | null;
  }> {
    this.requireServiceAccount(principal, "credentials:issue");
    if (!input.requestId.trim()) throw new Error("REQUEST_ID_REQUIRED");
    if (input.capabilities.length === 0
      || input.capabilities.some((capability) => !agentCapabilities.has(capability))) {
      throw new Error("AGENT_CREDENTIAL_CAPABILITY_INVALID");
    }
    const createdAt = this.now();
    const issued = createApiCredential({
      id: input.credentialId,
      organizationId: principal.organizationId,
      agentId: input.agentId,
      name: input.name,
      capabilities: input.capabilities,
      createdAt,
      expiresAt: input.expiresAt,
    }, this.entropy);
    await this.store.issueCredential(issued.record, {
      actorId: `service_account:${principal.principalId}`,
      causationId: input.requestId,
      occurredAt: createdAt,
    });
    return {
      credentialId: issued.record.id,
      token: issued.token,
      tokenPrefix: issued.record.tokenPrefix,
      capabilities: issued.record.capabilities,
      expiresAt: issued.record.expiresAt,
    };
  }

  async revokeAgentCredential(
    principal: AdministrativePrincipal,
    credentialId: string,
    requestId: string,
  ): Promise<void> {
    this.requireServiceAccount(principal, "credentials:revoke");
    if (!requestId.trim()) throw new Error("REQUEST_ID_REQUIRED");
    const occurredAt = this.now();
    await this.store.revokeCredential(principal.organizationId, credentialId, {
      actorId: `service_account:${principal.principalId}`,
      causationId: requestId,
      occurredAt,
    });
  }

  async issueServiceAccountCredential(
    principal: AdministrativePrincipal,
    input: IssueServiceAccountCredentialInput,
  ): Promise<{
    credentialId: string;
    token: string;
    tokenPrefix: string;
    capabilities: ApiCapability[];
    expiresAt: string | null;
  }> {
    this.requireServiceAccount(principal, "credentials:issue");
    if (!input.requestId.trim()) throw new Error("REQUEST_ID_REQUIRED");
    const createdAt = this.now();
    const issued = createServiceAccountCredential({
      id: input.credentialId,
      organizationId: principal.organizationId,
      serviceAccountId: input.serviceAccountId,
      name: input.name,
      capabilities: input.capabilities,
      createdAt,
      expiresAt: input.expiresAt,
    }, this.entropy);
    await this.store.issueServiceAccountCredential(issued.record, {
      actorId: `service_account:${principal.principalId}`,
      causationId: input.requestId,
      occurredAt: createdAt,
    });
    return {
      credentialId: issued.record.id,
      token: issued.token,
      tokenPrefix: issued.record.tokenPrefix,
      capabilities: issued.record.capabilities,
      expiresAt: issued.record.expiresAt,
    };
  }

  async revokeServiceAccountCredential(
    principal: AdministrativePrincipal,
    credentialId: string,
    requestId: string,
  ): Promise<void> {
    this.requireServiceAccount(principal, "credentials:revoke");
    if (!requestId.trim()) throw new Error("REQUEST_ID_REQUIRED");
    const occurredAt = this.now();
    await this.store.revokeServiceAccountCredential(principal.organizationId, credentialId, {
      actorId: `service_account:${principal.principalId}`,
      causationId: requestId,
      occurredAt,
    });
  }

  private requireServiceAccount(
    principal: AdministrativePrincipal,
    capability: ApiCapability,
  ): void {
    if (principal.principalType !== "service_account") throw new Error("SERVICE_ACCOUNT_REQUIRED");
    if (principal.role !== "admin") throw new Error("SERVICE_ACCOUNT_ADMIN_REQUIRED");
    if (!principal.capabilities.includes(capability)) throw new Error("ADMIN_CAPABILITY_REQUIRED");
  }
}
