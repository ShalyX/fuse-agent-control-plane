import type { AdministrativePrincipal } from "../identity/credentialAdministration.js";
import type {
  ConfigureProviderInput,
  ProviderConfigurationSummary,
  ProviderName,
} from "../persistence/providerConfigStore.js";

interface ProviderConfigAdministrationStore {
  configure(input: ConfigureProviderInput): Promise<ProviderConfigurationSummary>;
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
}

export class ProviderAdministration implements ProviderAdministrationPort {
  constructor(
    private readonly store: ProviderConfigAdministrationStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async configure(
    principal: AdministrativePrincipal,
    input: ConfigureProviderCommand,
  ): Promise<ProviderConfigurationSummary> {
    this.requireAdmin(principal, "providers:write");
    if (!input.requestId.trim()) throw new Error("REQUEST_ID_REQUIRED");
    const occurredAt = this.now();
    return this.store.configure({
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
    });
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
