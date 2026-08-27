import type { AdministrativePrincipal } from "../identity/credentialAdministration.js";
import type { ApiCapability } from "../identity/apiCredentials.js";
import type { AdmissionResult, ControlledInferenceInput } from "../inference/inferenceExecution.js";

export interface ProductInferenceRequest {
  requestId: string;
  mandateId: string;
  agentId: string;
  agentCapabilities: ApiCapability[];
  branchId?: string;
  workloadClass?: string;
  requestedModel?: string;
  inputTokens: number;
  maxOutputTokens: number;
  messages: ControlledInferenceInput["messages"];
}

export class ProductInferenceService {
  constructor(private readonly execution: {
    execute(input: ControlledInferenceInput): Promise<AdmissionResult>;
    preview?(input: ControlledInferenceInput): Promise<AdmissionResult>;
  }) {}

  supportsPreview(): boolean { return typeof this.execution.preview === "function"; }

  async preview(principal: AdministrativePrincipal, input: Omit<ProductInferenceRequest, "agentId" | "agentCapabilities">): Promise<AdmissionResult> {
    if (principal.principalType !== "agent") throw new Error("AGENT_CREDENTIAL_REQUIRED");
    if (!this.execution.preview) throw new Error("POLICY_PREVIEW_REQUIRED");
    return this.execution.preview({
      ...input,
      organizationId: principal.organizationId,
      credentialId: principal.credentialId,
      agentId: principal.principalId,
      agentCapabilities: [...principal.capabilities],
    });
  }

  async execute(principal: AdministrativePrincipal, input: Omit<ProductInferenceRequest, "agentId" | "agentCapabilities">): Promise<AdmissionResult> {
    if (principal.principalType !== "agent") throw new Error("AGENT_CREDENTIAL_REQUIRED");
    return this.execution.execute({
      ...input,
      organizationId: principal.organizationId,
      credentialId: principal.credentialId,
      agentId: principal.principalId,
      agentCapabilities: [...principal.capabilities],
    });
  }
}
