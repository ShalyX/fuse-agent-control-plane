import type { AdministrativePrincipal } from "../identity/credentialAdministration.js";
import type {
  ConfigureProviderInput,
  ProviderConfigurationSummary,
  ProviderName,
  ProviderRetryReplay,
  ProviderVerificationRecord,
} from "../persistence/providerConfigStore.js";

interface ProviderConfigAdministrationStore {
  configure(input: ConfigureProviderInput): Promise<ProviderConfigurationSummary>;
  getForVerification?(organizationId: string, id: string): Promise<ProviderVerificationRecord>;
  beginVerificationRetry?(input: { organizationId: string; id: string; requestId: string; occurredAt: string }): Promise<{ record?: ProviderVerificationRecord; replay?: ProviderRetryReplay; claimToken?: string }>;
  finishVerificationRetry?(input: { organizationId: string; id: string; requestId: string; claimToken: string; expectedCredentialVersion: number; status: "verified" | "invalid"; summary: ProviderConfigurationSummary; errorCode?: string; occurredAt: string }): Promise<void>;

  markVerificationStatus?(input: {
    organizationId: string;
    id: string;
    status: "pending" | "verified" | "invalid";
    expectedCredentialVersion: number;
    occurredAt: string;
  }): Promise<void>;
  list(organizationId: string): Promise<ProviderConfigurationSummary[]>;
}

export interface ConfigureProviderCommand {
  configId: string;
  provider: ProviderName;
  model: string;
  apiKey: string;
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  requestId: string;
}

export interface ProviderAdministrationPort {
  configure(
    principal: AdministrativePrincipal,
    input: ConfigureProviderCommand,
  ): Promise<ProviderConfigurationSummary>;
  list(principal: AdministrativePrincipal): Promise<ProviderConfigurationSummary[]>;
  retry?(principal: AdministrativePrincipal, configId: string, requestId: string): Promise<ProviderConfigurationSummary>;

}

export type ProviderCredentialVerifier = (input: {
  provider: ProviderName;
  model: string;
  apiKey: string;
}) => Promise<void>;

export class ProviderAdministration implements ProviderAdministrationPort {
  constructor(
    private readonly store: ProviderConfigAdministrationStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly verifyCredential?: ProviderCredentialVerifier,
  ) {}

  async configure(
    principal: AdministrativePrincipal,
    input: ConfigureProviderCommand,
  ): Promise<ProviderConfigurationSummary> {
    this.requireAdmin(principal, "providers:write");
    if (!input.requestId.trim()) throw new Error("REQUEST_ID_REQUIRED");
    if (input.provider !== "openrouter" || !this.verifyCredential) {
      throw new Error("PROVIDER_VERIFICATION_UNSUPPORTED");
    }
    const occurredAt = this.now();
    const configured = await this.store.configure({
      id: input.configId,
      organizationId: principal.organizationId,
      provider: input.provider,
      model: input.model,
      apiKey: input.apiKey,
      inputUsdPerMillion: input.inputUsdPerMillion,
      outputUsdPerMillion: input.outputUsdPerMillion,
      actorId: `service_account:${principal.principalId}`,
      causationId: input.requestId,
      occurredAt,
      verificationStatus: "pending",
    });
    try {
      await this.verifyCredential({ provider: input.provider, model: input.model, apiKey: input.apiKey });
      await this.store.markVerificationStatus?.({
        organizationId: principal.organizationId, id: input.configId, status: "verified",
        expectedCredentialVersion: configured.credentialVersion, occurredAt,
      });
      return configured;
    } catch (error) {
      await this.store.markVerificationStatus?.({
        organizationId: principal.organizationId, id: input.configId, status: "invalid",
        expectedCredentialVersion: configured.credentialVersion, occurredAt,
      });
      throw error;
    }
  }

  async retry(
    principal: AdministrativePrincipal,
    configId: string,
    requestId: string,
  ): Promise<ProviderConfigurationSummary> {
    this.requireAdmin(principal, "providers:write");
    if (!configId.trim()) throw new Error("PROVIDER_CONFIGURATION_ID_REQUIRED");
    if (!requestId.trim()) throw new Error("REQUEST_ID_REQUIRED");
    if (!this.verifyCredential || !this.store.beginVerificationRetry || !this.store.finishVerificationRetry) {
      throw new Error("PROVIDER_VERIFICATION_RETRY_UNAVAILABLE");
    }
    const occurredAt = this.now();
    const claim = await this.store.beginVerificationRetry({
      organizationId: principal.organizationId, id: configId, requestId, occurredAt,
    });
    if (claim.replay) {
      if (claim.replay.status === "invalid") throw new Error(claim.replay.errorCode ?? "OPENROUTER_CREDENTIAL_INVALID");
      return claim.replay.summary;
    }
    const current = claim.record;
    if (!current || !claim.claimToken) throw new Error("PROVIDER_VERIFICATION_RETRY_NOT_FOUND");
    if (current.provider !== "openrouter") throw new Error("PROVIDER_VERIFICATION_RETRY_UNSUPPORTED");
    try {
      await this.verifyCredential({ provider: current.provider, model: current.model, apiKey: current.apiKey });
    } catch (error) {
      const summary = (await this.store.list(principal.organizationId)).find(({ id }) => id === configId);
      if (!summary) throw new Error("PROVIDER_CONFIGURATION_NOT_FOUND");
      await this.store.finishVerificationRetry({ organizationId: principal.organizationId, id: configId, requestId,
        claimToken: claim.claimToken, expectedCredentialVersion: current.credentialVersion,
        status: "invalid", summary,
        errorCode: error instanceof Error ? error.message : "OPENROUTER_CREDENTIAL_INVALID", occurredAt });
      throw error;
    }
    const summary = (await this.store.list(principal.organizationId)).find(({ id }) => id === configId);
    if (!summary) throw new Error("PROVIDER_CONFIGURATION_NOT_FOUND");
    await this.store.finishVerificationRetry({ organizationId: principal.organizationId, id: configId, requestId,
      claimToken: claim.claimToken, expectedCredentialVersion: current.credentialVersion,
      status: "verified", summary, occurredAt });
    return summary;
  }

  list(principal: AdministrativePrincipal): Promise<ProviderConfigurationSummary[]> {
    this.requireServiceCapability(principal, "providers:read");
    return this.store.list(principal.organizationId);
  }

  private requireServiceCapability(
    principal: AdministrativePrincipal,
    capability: "providers:read" | "providers:write",
  ): void {
    if (principal.principalType !== "service_account") throw new Error("SERVICE_ACCOUNT_REQUIRED");
    if (!principal.capabilities.includes(capability)) throw new Error("PROVIDER_CAPABILITY_REQUIRED");
  }

  private requireAdmin(
    principal: AdministrativePrincipal,
    capability: "providers:write",
  ): void {
    this.requireServiceCapability(principal, capability);
    if (principal.role !== "admin") throw new Error("SERVICE_ACCOUNT_ADMIN_REQUIRED");
  }
}
