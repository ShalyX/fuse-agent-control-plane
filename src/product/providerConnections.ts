import type { AdministrativePrincipal } from "../identity/credentialAdministration.js";
import type {
  ConfigureProviderCommand,
  ProviderAdministrationPort,
} from "../providers/providerAdministration.js";
import type { ProviderConfigurationSummary } from "../persistence/providerConfigStore.js";

export type ProviderConnectionInput = ConfigureProviderCommand;

export class ProviderConnectionService {
  constructor(private readonly administration: ProviderAdministrationPort) {}

  async connect(
    principal: AdministrativePrincipal,
    input: ProviderConnectionInput,
  ): Promise<ProviderConfigurationSummary> {
    return this.administration.configure(principal, input);
  }

  async list(principal: AdministrativePrincipal): Promise<ProviderConfigurationSummary[]> {
    return this.administration.list(principal);
  }
}
