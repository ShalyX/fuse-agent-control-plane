import type { AdministrativePrincipal } from "../identity/credentialAdministration.js";
import type { ApiCapability } from "../identity/apiCredentials.js";
import type { PolicyLimits, PolicyMode, PolicyVersion } from "../domain/policy.js";
import type { MandateState } from "../domain/lifecycles.js";
import type { PolicyStore, StoredPolicyDecision } from "../persistence/policyStore.js";

export interface PublishPolicyInput {
  policyId: string;
  version: number;
  mode: PolicyMode;
  allowedProviders: string[];
  allowedModels: string[];
  requiredCapability: ApiCapability;
  limits: PolicyLimits;
  requestId: string;
}

export interface CreateMandateInput {
  mandateId: string;
  name: string;
  assetId: string;
  maximumSpendAtomic: bigint;
  policyId: string;
  policyVersion: number;
  expiresAt: string | null;
  requestId: string;
}

export interface AssignAgentInput {
  mandateId: string;
  agentId: string;
  requestId: string;
}

export interface TransitionMandateInput {
  mandateId: string;
  to: MandateState;
  requestId: string;
}

export interface SetMandatePolicyInput {
  mandateId: string;
  policyId: string;
  policyVersion: number;
  requestId: string;
}

export interface PolicyAdministrationPort {
  publishPolicy(principal: AdministrativePrincipal, input: PublishPolicyInput): Promise<void>;
  createMandate(principal: AdministrativePrincipal, input: CreateMandateInput): Promise<void>;
  assignAgent(principal: AdministrativePrincipal, input: AssignAgentInput): Promise<void>;
  transitionMandate(
    principal: AdministrativePrincipal,
    input: TransitionMandateInput,
  ): Promise<void>;
  setMandatePolicy(
    principal: AdministrativePrincipal,
    input: SetMandatePolicyInput,
  ): Promise<void>;
  getPolicy(
    principal: AdministrativePrincipal,
    policyId: string,
    version: number,
  ): Promise<PolicyVersion | null>;
  listDecisions(
    principal: AdministrativePrincipal,
    mandateId: string,
  ): Promise<StoredPolicyDecision[]>;
}

export class PolicyAdministration implements PolicyAdministrationPort {
  constructor(
    private readonly store: PolicyStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async publishPolicy(
    principal: AdministrativePrincipal,
    input: PublishPolicyInput,
  ): Promise<void> {
    this.requireAdmin(principal, "policies:write", "POLICY_CAPABILITY_REQUIRED");
    this.requireRequestId(input.requestId);
    const occurredAt = this.now();
    await this.store.publishPolicy({
      id: input.policyId,
      organizationId: principal.organizationId,
      version: input.version,
      mode: input.mode,
      allowedProviders: [...input.allowedProviders],
      allowedModels: [...input.allowedModels],
      requiredCapability: input.requiredCapability,
      limits: { ...input.limits },
      createdAt: occurredAt,
    }, this.context(principal, input.requestId, occurredAt));
  }

  async createMandate(
    principal: AdministrativePrincipal,
    input: CreateMandateInput,
  ): Promise<void> {
    this.requireAdmin(principal, "mandates:admin", "MANDATE_CAPABILITY_REQUIRED");
    this.requireRequestId(input.requestId);
    const occurredAt = this.now();
    await this.store.createMandate({
      id: input.mandateId,
      organizationId: principal.organizationId,
      name: input.name,
      assetId: input.assetId,
      maximumSpendAtomic: input.maximumSpendAtomic,
      state: "draft",
      policyId: input.policyId,
      policyVersion: input.policyVersion,
      expiresAt: input.expiresAt,
      ...this.context(principal, input.requestId, occurredAt),
    });
  }

  async assignAgent(
    principal: AdministrativePrincipal,
    input: AssignAgentInput,
  ): Promise<void> {
    this.requireAdmin(principal, "mandates:admin", "MANDATE_CAPABILITY_REQUIRED");
    this.requireRequestId(input.requestId);
    const occurredAt = this.now();
    await this.store.assignAgent({
      organizationId: principal.organizationId,
      mandateId: input.mandateId,
      agentId: input.agentId,
      ...this.context(principal, input.requestId, occurredAt),
    });
  }

  async transitionMandate(
    principal: AdministrativePrincipal,
    input: TransitionMandateInput,
  ): Promise<void> {
    this.requireAdmin(principal, "mandates:admin", "MANDATE_CAPABILITY_REQUIRED");
    this.requireRequestId(input.requestId);
    const occurredAt = this.now();
    await this.store.transitionMandateState(
      principal.organizationId,
      input.mandateId,
      input.to,
      this.context(principal, input.requestId, occurredAt),
    );
  }

  async setMandatePolicy(
    principal: AdministrativePrincipal,
    input: SetMandatePolicyInput,
  ): Promise<void> {
    this.requireAdmin(principal, "mandates:admin", "MANDATE_CAPABILITY_REQUIRED");
    this.requireRequestId(input.requestId);
    const occurredAt = this.now();
    await this.store.setMandatePolicy(
      principal.organizationId,
      input.mandateId,
      input.policyId,
      input.policyVersion,
      this.context(principal, input.requestId, occurredAt),
    );
  }

  async getPolicy(
    principal: AdministrativePrincipal,
    policyId: string,
    version: number,
  ): Promise<PolicyVersion | null> {
    this.requireServiceCapability(principal, "policies:read", "POLICY_CAPABILITY_REQUIRED");
    if (!policyId.trim()) throw new Error("POLICY_ID_REQUIRED");
    if (!Number.isInteger(version) || version < 1) throw new Error("POLICY_VERSION_INVALID");
    return this.store.getPolicy(principal.organizationId, policyId, version);
  }

  async listDecisions(
    principal: AdministrativePrincipal,
    mandateId: string,
  ): Promise<StoredPolicyDecision[]> {
    this.requireServiceCapability(principal, "policies:read", "POLICY_CAPABILITY_REQUIRED");
    if (!mandateId.trim()) throw new Error("CONTROL_MANDATE_ID_REQUIRED");
    return this.store.listDecisions(principal.organizationId, mandateId);
  }

  private requireServiceCapability(
    principal: AdministrativePrincipal,
    capability: ApiCapability,
    errorCode: string,
  ): void {
    if (principal.principalType !== "service_account") throw new Error("SERVICE_ACCOUNT_REQUIRED");
    if (!principal.capabilities.includes(capability)) throw new Error(errorCode);
  }

  private requireAdmin(
    principal: AdministrativePrincipal,
    capability: ApiCapability,
    errorCode: string,
  ): void {
    if (principal.principalType !== "service_account") throw new Error("SERVICE_ACCOUNT_REQUIRED");
    if (principal.role !== "admin") throw new Error("SERVICE_ACCOUNT_ADMIN_REQUIRED");
    if (!principal.capabilities.includes(capability)) throw new Error(errorCode);
  }

  private requireRequestId(requestId: string): void {
    if (!requestId.trim()) throw new Error("REQUEST_ID_REQUIRED");
  }

  private context(
    principal: AdministrativePrincipal,
    causationId: string,
    occurredAt: string,
  ) {
    return {
      actorId: `service_account:${principal.principalId}`,
      causationId,
      occurredAt,
    };
  }
}
