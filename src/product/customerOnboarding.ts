import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createApiCredential,
  createServiceAccountCredential,
  type ApiCapability,
  type ServiceAccountCredentialRecord,
} from "../identity/apiCredentials.js";
import type {
  AdministrativePrincipal,
  CredentialAdministrationPort,
} from "../identity/credentialAdministration.js";
import type { IdentityStore } from "../persistence/identityStore.js";
import type { ProviderName } from "../persistence/providerConfigStore.js";
import type { ProviderConnectionService } from "./providerConnections.js";
import type { PolicyPublishingService, ProductPolicyInput } from "./policyPublishing.js";
import type { MandateManagementService } from "./mandateManagement.js";

export interface CreateWorkspaceInput {
  name: string;
  agentName: string;
  provider: ProviderName;
  model: string;
  apiKey: string;
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  maximumSpendAtomic: string;
  idempotencyKey: string;
  expiresAt?: string | null;
}

export type WorkspaceRecoveryRecord = {
  workspaceId: string;
  serviceAccountId: string;
  serviceCredentialId: string;
  agentId: string;
  agentCredentialId: string;
  expiresAt: string | null;
} | { deliveryResult: WorkspaceCredentialRecoveryResult };

export type WorkspaceCredentialMetadata = {
  workspaceId: string;
  serviceAccountId: string;
  serviceCredentialId: string;
  agentId: string;
  agentCredentialId: string;
  expiresAt: string | null;
};

export type WorkspaceSetupMetadata = WorkspaceCredentialMetadata & {
  policyId: string;
  mandateId: string;
  providerConfigId: string;
};

export interface WorkspaceOnboardingStore {
  tryReserveCapacity(input: {
    idempotencyKey: string;
    maxActiveWorkspaces: number;
    baselineWorkspaceIds: readonly string[];
    now?: Date;
  }): Promise<boolean>;
  claim(input: {
    idempotencyKey: string;
    fingerprint: string;
    recoveryCodeHash: string;
    identifiers: Record<string, string>;
    now?: Date;
    staleAfterMs?: number;
  }): Promise<
    | { status: "new" }
    | { status: "replay"; result: CustomerWorkspaceResult | null }
    | { status: "in_progress" }
    | { status: "conflict" }
  >;
  heartbeat(idempotencyKey: string, workspaceId: string, now: Date): Promise<void>;
  complete(idempotencyKey: string, result: CustomerWorkspaceResult): Promise<void>;
  rollback(idempotencyKey: string, workspaceId: string, code: string): Promise<void>;
  recordRollbackFailure?(idempotencyKey: string, workspaceId: string, code: string): Promise<void>;
  getRecovery(workspaceId: string, recoveryCodeHash: string, deliveryId: string): Promise<WorkspaceRecoveryRecord | null>;
  getWorkspaceCredentialMetadata?(workspaceId: string): Promise<WorkspaceCredentialMetadata | null>;
  getWorkspaceSetupMetadata?(workspaceId: string): Promise<WorkspaceSetupMetadata | null>;
  rotateRecoveryCode?(workspaceId: string, recoveryCodeHash: string, now?: Date): Promise<boolean>;
  sealRecoveryResult?(result: WorkspaceCredentialRecoveryResult, recoveryCodeHash: string, deliveryId: string): string;
  listCompletedWorkspaceIds(): Promise<string[]>;
}

export interface CustomerOnboardingDependencies {
  identityStore: Pick<IdentityStore, "bootstrapServiceAccount" | "rotateAgentCredentialWithRecovery">;
  credentialAdministration: Pick<CredentialAdministrationPort, "registerAgent" | "issueAgentCredential" | "revokeAgentCredential">
    & Partial<Pick<CredentialAdministrationPort, "issueServiceAccountCredential">>;
  providerConnectionService: Pick<ProviderConnectionService, "connect">;
  policyPublishingService: Pick<PolicyPublishingService, "publish">;
  mandateManagementService: Pick<MandateManagementService, "createMandate" | "assignAgent" | "transitionMandate">;
  now?: () => string;
  ids?: () => string;
  onboardingStore?: WorkspaceOnboardingStore;
}

export interface CustomerWorkspaceResult {
  workspaceId: string;
  agentId: string;
  mandateId: string;
  policyId: string;
  providerConfigId: string;
  adminCredential: {
    credentialId: string;
    token: string | null;
    tokenPrefix: string;
    capabilities: ApiCapability[];
    expiresAt: string | null;
  };
  credential: {
    credentialId: string;
    token: string | null;
    tokenPrefix: string;
    capabilities: ApiCapability[];
    expiresAt: string | null;
  };
  recoveryCode: string;
}

const adminCapabilities: ApiCapability[] = [
  "agents:write", "credentials:issue", "credentials:revoke", "providers:write", "policies:write", "mandates:admin",
];
const agentCapabilities: ApiCapability[] = ["inference:invoke", "receipts:read"];

export interface WorkspaceCredentialRecoveryResult {
  workspaceId: string;
  agentId: string;
  credential: CustomerWorkspaceResult["credential"];
}

export interface WorkspaceCredentialPackage {
  workspaceId: string;
  serviceCredential: {
    credentialId: string;
    token: string;
    tokenPrefix: string;
    capabilities: ApiCapability[];
    expiresAt: string | null;
  };
  agentCredential: CustomerWorkspaceResult["credential"];
  recoveryCode: string;
}

export interface CustomerOnboardingPort {
  createWorkspace(input: CreateWorkspaceInput): Promise<CustomerWorkspaceResult>;
  recoverWorkspaceCredential(input: { workspaceId: string; recoveryCode: string; idempotencyKey: string }): Promise<WorkspaceCredentialRecoveryResult>;
  getWorkspaceSetupMetadata?(workspaceId: string): Promise<WorkspaceSetupMetadata | null>;
  issueReplacementCredentials?(principal: AdministrativePrincipal, workspaceId: string): Promise<WorkspaceCredentialPackage>;
  issueReplacementCredentialsFromBetaRecovery?(): Promise<WorkspaceCredentialPackage>;
}

export class CustomerOnboardingService {
  private readonly now: () => string;
  private readonly ids: () => string;

  constructor(private readonly dependencies: CustomerOnboardingDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.ids = dependencies.ids ?? randomUUID;
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<CustomerWorkspaceResult> {
    this.validate(input);
    const occurredAt = this.now();
    const recoveryCode = `fuse_rc_${randomBytes(18).toString("base64url")}`;
    const recoveryCodeHash = createHash("sha256").update(recoveryCode).digest("hex");
    const workspaceId = this.ids();
    const serviceAccountId = this.ids();
    const serviceCredentialId = this.ids();
    const agentId = this.ids();
    const agentCredentialId = this.ids();
    const policyId = this.ids();
    const mandateId = this.ids();
    const providerConfigId = this.ids();
    const fingerprint = createHash("sha256").update(JSON.stringify({
      name: input.name.trim(), agentName: input.agentName.trim(), provider: input.provider, model: input.model.trim(),
      apiKey: createHash("sha256").update(input.apiKey).digest("hex"), inputUsdPerMillion: input.inputUsdPerMillion,
      outputUsdPerMillion: input.outputUsdPerMillion, maximumSpendAtomic: input.maximumSpendAtomic, expiresAt: input.expiresAt ?? null,
    })).digest("hex");
    const onboardingStore = this.dependencies.onboardingStore;
    if (onboardingStore) {
      const claim = await onboardingStore.claim({ idempotencyKey: input.idempotencyKey, fingerprint, recoveryCodeHash,
        identifiers: { workspaceId, serviceAccountId, serviceCredentialId, agentId, agentCredentialId, policyId, mandateId, providerConfigId },
        now: new Date(occurredAt), staleAfterMs: 15 * 60_000 });
      if (claim.status === "conflict") throw new Error("WORKSPACE_IDEMPOTENCY_CONFLICT");
      if (claim.status === "in_progress") throw new Error("WORKSPACE_ONBOARDING_IN_PROGRESS");
      if (claim.status === "replay") {
        if (claim.result?.credential.token) return claim.result;
        throw new Error("WORKSPACE_CREATED_CREDENTIAL_UNAVAILABLE");
      }
    }
    const heartbeat = async () => onboardingStore?.heartbeat(input.idempotencyKey, workspaceId, new Date(this.now()));
    try {
      const adminCredential = createServiceAccountCredential({
      id: serviceCredentialId,
      organizationId: workspaceId,
      serviceAccountId,
      name: "Fuse customer administration",
      capabilities: [
        ...adminCapabilities,
        "providers:read", "policies:read", "mandates:read", "receipts:read", "sandbox:run",
      ],
      createdAt: occurredAt,
      expiresAt: input.expiresAt ?? null,
    });
    await this.dependencies.identityStore.bootstrapServiceAccount({
      organizationId: workspaceId,
      organizationName: input.name,
      serviceAccountId,
      serviceAccountName: "Fuse customer administration",
      credential: adminCredential.record as ServiceAccountCredentialRecord,
      actorId: `workspace:${workspaceId}`,
      causationId: `${workspaceId}:bootstrap`,
      occurredAt,
    });
    await heartbeat();
    const adminPrincipal: AdministrativePrincipal = {
      principalType: "service_account",
      principalId: serviceAccountId,
      organizationId: workspaceId,
      credentialId: serviceCredentialId,
      capabilities: adminCredential.record.capabilities,
      role: "admin",
    };
    await this.dependencies.credentialAdministration.registerAgent(adminPrincipal, {
      agentId,
      name: input.agentName,
      requestId: `${workspaceId}:agent`,
    });
    await heartbeat();
    const agentCredential = await this.dependencies.credentialAdministration.issueAgentCredential(adminPrincipal, {
      credentialId: agentCredentialId,
      agentId,
      name: "Default inference credential",
      capabilities: agentCapabilities,
      expiresAt: input.expiresAt ?? null,
      requestId: `${workspaceId}:agent-credential`,
    });
    await heartbeat();
    await this.dependencies.providerConnectionService.connect(adminPrincipal, {
      configId: providerConfigId,
      provider: input.provider,
      model: input.model,
      apiKey: input.apiKey,
      inputUsdPerMillion: input.inputUsdPerMillion,
      outputUsdPerMillion: input.outputUsdPerMillion,
      requestId: `${workspaceId}:provider`,
    });
    await heartbeat();
    const policyInput: ProductPolicyInput = {
      policyId,
      version: 1,
      mode: "enforce",
      allowedProviders: [input.provider],
      allowedModels: [input.model],
      requiredCapability: "inference:invoke",
      limits: {
        maxPerCallAtomic: input.maximumSpendAtomic,
        maxHourlyAtomic: input.maximumSpendAtomic,
        maxDailyAtomic: input.maximumSpendAtomic,
        maxRequestsPerMinute: 10,
        maxInputTokens: 32_000,
        maxOutputTokens: 4_096,
      },
      requestId: `${workspaceId}:policy`,
    };
    await this.dependencies.policyPublishingService.publish(adminPrincipal, policyInput);
    await heartbeat();
    await this.dependencies.mandateManagementService.createMandate(adminPrincipal, {
      mandateId,
      name: "Default bounded inference mandate",
      assetId: "USDC",
      maximumSpendAtomic: input.maximumSpendAtomic,
      policyId,
      policyVersion: 1,
      expiresAt: input.expiresAt ?? null,
      requestId: `${workspaceId}:mandate`,
    });
    await heartbeat();
    await this.dependencies.mandateManagementService.assignAgent(adminPrincipal, {
      mandateId,
      agentId,
      requestId: `${workspaceId}:assignment`,
    });
    await heartbeat();
    await this.dependencies.mandateManagementService.transitionMandate(adminPrincipal, {
      mandateId,
      to: "active",
      requestId: `${workspaceId}:activation`,
    });
    await heartbeat();
      const result = {
        workspaceId,
        agentId,
        mandateId,
        policyId,
        providerConfigId,
        adminCredential: {
          credentialId: adminCredential.record.id,
          token: adminCredential.token,
          tokenPrefix: adminCredential.record.tokenPrefix,
          capabilities: adminCredential.record.capabilities,
          expiresAt: adminCredential.record.expiresAt,
        },
        credential: agentCredential,
        recoveryCode,
      };
      await onboardingStore?.complete(input.idempotencyKey, result);
      return result;
    } catch (error) {
      if (onboardingStore) {
        try {
          await onboardingStore.rollback(
            input.idempotencyKey,
            workspaceId,
            error instanceof Error ? error.message : "WORKSPACE_ONBOARDING_FAILED",
          );
        } catch (rollbackError) {
          await onboardingStore.recordRollbackFailure?.(
            input.idempotencyKey,
            workspaceId,
            rollbackError instanceof Error ? rollbackError.message : "WORKSPACE_ONBOARDING_ROLLBACK_FAILED",
          ).catch(() => undefined);
          throw new Error("WORKSPACE_ONBOARDING_ROLLBACK_FAILED");
        }
      }
      throw error;
    }
  }

  async recoverWorkspaceCredential(input: { workspaceId: string; recoveryCode: string; idempotencyKey: string }): Promise<WorkspaceCredentialRecoveryResult> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.workspaceId)) throw new Error("WORKSPACE_ID_INVALID");
    if (!/^fuse_rc_[A-Za-z0-9_-]{16,128}$/.test(input.recoveryCode)) throw new Error("RECOVERY_CODE_INVALID");
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw new Error("IDEMPOTENCY_KEY_INVALID");
    const onboardingStore = this.dependencies.onboardingStore;
    if (!onboardingStore) throw new Error("CREDENTIAL_RECOVERY_UNAVAILABLE");
    const recoveryCodeHash = createHash("sha256").update(input.recoveryCode).digest("hex");
    const record = await onboardingStore.getRecovery(input.workspaceId, recoveryCodeHash, input.idempotencyKey);
    if (!record) throw new Error("CREDENTIAL_RECOVERY_INVALID");
    if ("deliveryResult" in record) return record.deliveryResult;
    const occurredAt = this.now();
    const issued = createApiCredential({
      id: this.ids(),
      organizationId: record.workspaceId,
      agentId: record.agentId,
      name: "Recovered inference credential",
      capabilities: agentCapabilities,
      expiresAt: record.expiresAt,
      createdAt: occurredAt,
    });
    const result: WorkspaceCredentialRecoveryResult = {
      workspaceId: record.workspaceId,
      agentId: record.agentId,
      credential: {
        credentialId: issued.record.id,
        token: issued.token,
        tokenPrefix: issued.record.tokenPrefix,
        capabilities: [...issued.record.capabilities],
        expiresAt: issued.record.expiresAt,
      },
    };
    const recoveryDeliveryEnvelope = onboardingStore.sealRecoveryResult?.(result, recoveryCodeHash, input.idempotencyKey);
    if (!recoveryDeliveryEnvelope) throw new Error("CREDENTIAL_RECOVERY_DELIVERY_UNAVAILABLE");
    await this.dependencies.identityStore.rotateAgentCredentialWithRecovery({
      workspaceId: record.workspaceId,
      recoveryCodeHash,
      recoveryDeliveryId: input.idempotencyKey,
      recoveryDeliveryEnvelope,
      replacement: issued.record,
      actorId: `service_account:${record.serviceAccountId}`,
      causationId: `${record.workspaceId}:credential-recovery:${this.ids()}`,
      occurredAt,
    });
    return result;
  }

  async getWorkspaceSetupMetadata(workspaceId: string): Promise<WorkspaceSetupMetadata | null> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(workspaceId)) throw new Error("WORKSPACE_ID_INVALID");
    return this.dependencies.onboardingStore?.getWorkspaceSetupMetadata?.(workspaceId) ?? null;
  }

  async issueReplacementCredentials(principal: AdministrativePrincipal, workspaceId: string): Promise<WorkspaceCredentialPackage> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(workspaceId)) throw new Error("WORKSPACE_ID_INVALID");
    if (principal.organizationId !== workspaceId) throw new Error("WORKSPACE_SCOPE_MISMATCH");
    const onboardingStore = this.dependencies.onboardingStore;
    const issueServiceAccountCredential = this.dependencies.credentialAdministration.issueServiceAccountCredential
      ?.bind(this.dependencies.credentialAdministration);
    if (!onboardingStore?.getWorkspaceCredentialMetadata || !onboardingStore.rotateRecoveryCode
      || !issueServiceAccountCredential) throw new Error("CREDENTIAL_RECOVERY_UNAVAILABLE");
    const metadata = await onboardingStore.getWorkspaceCredentialMetadata(workspaceId);
    if (!metadata) throw new Error("WORKSPACE_NOT_FOUND");
    const occurredAt = this.now();
    const serviceCredential = await issueServiceAccountCredential(principal, {
      credentialId: this.ids(),
      serviceAccountId: metadata.serviceAccountId,
      name: "Fuse customer administration replacement",
      capabilities: [
        ...adminCapabilities,
        "providers:read", "policies:read", "mandates:read", "receipts:read", "sandbox:run",
      ],
      expiresAt: metadata.expiresAt,
      requestId: `${workspaceId}:service-credential-replacement:${this.ids()}`,
    });
    const agentCredential = await this.dependencies.credentialAdministration.issueAgentCredential(principal, {
      credentialId: this.ids(),
      agentId: metadata.agentId,
      name: "Replacement inference credential",
      capabilities: agentCapabilities,
      expiresAt: metadata.expiresAt,
      requestId: `${workspaceId}:agent-credential-replacement:${this.ids()}`,
    });
    const recoveryCode = `fuse_rc_${randomBytes(18).toString("base64url")}`;
    const recoveryCodeHash = createHash("sha256").update(recoveryCode).digest("hex");
    if (!await onboardingStore.rotateRecoveryCode(workspaceId, recoveryCodeHash, new Date(occurredAt))) {
      throw new Error("WORKSPACE_NOT_FOUND");
    }
    return {
      workspaceId,
      serviceCredential,
      agentCredential,
      recoveryCode,
    };
  }

  async issueReplacementCredentialsFromBetaRecovery(): Promise<WorkspaceCredentialPackage> {
    const onboardingStore = this.dependencies.onboardingStore;
    if (!onboardingStore?.listCompletedWorkspaceIds) throw new Error("CREDENTIAL_RECOVERY_UNAVAILABLE");
    const workspaceIds = await onboardingStore.listCompletedWorkspaceIds();
    if (workspaceIds.length === 0) throw new Error("WORKSPACE_NOT_FOUND");
    if (workspaceIds.length !== 1) throw new Error("WORKSPACE_RECOVERY_AMBIGUOUS");
    const metadata = onboardingStore.getWorkspaceCredentialMetadata
      ? await onboardingStore.getWorkspaceCredentialMetadata(workspaceIds[0])
      : null;
    if (!metadata) throw new Error("WORKSPACE_NOT_FOUND");
    return this.issueReplacementCredentials({
      principalType: "service_account",
      principalId: metadata.serviceAccountId,
      organizationId: metadata.workspaceId,
      credentialId: metadata.serviceCredentialId,
      capabilities: [
        ...adminCapabilities,
        "providers:read", "policies:read", "mandates:read", "receipts:read", "sandbox:run",
      ],
      role: "admin",
    }, metadata.workspaceId);
  }

  private validate(input: CreateWorkspaceInput): void {
    if (!input.name.trim()) throw new Error("WORKSPACE_NAME_REQUIRED");
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw new Error("IDEMPOTENCY_KEY_INVALID");
    if (!input.agentName.trim()) throw new Error("AGENT_NAME_REQUIRED");
    if (!input.model.trim()) throw new Error("MODEL_REQUIRED");
    if (!input.apiKey.trim()) throw new Error("PROVIDER_API_KEY_REQUIRED");
    if (!/^\d+(?:\.\d{1,12})?$/.test(input.inputUsdPerMillion)) throw new Error("INPUT_PRICE_INVALID");
    if (!/^\d+(?:\.\d{1,12})?$/.test(input.outputUsdPerMillion)) throw new Error("OUTPUT_PRICE_INVALID");
    if (!/^[1-9]\d*$/.test(input.maximumSpendAtomic)) throw new Error("MAXIMUM_SPEND_INVALID");
  }
}
