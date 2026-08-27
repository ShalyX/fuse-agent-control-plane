import type { AdministrativePrincipal } from "../identity/credentialAdministration.js";
import type {
  CredentialAdministrationPort,
  IssueAgentCredentialInput,
  RegisterAgentInput,
} from "../identity/credentialAdministration.js";

export type ProductRegisterAgentInput = Omit<RegisterAgentInput, "requestId"> & { requestId: string };
export type ProductIssueCredentialInput = Omit<IssueAgentCredentialInput, "requestId"> & { requestId: string };

export class AgentIdentityService {
  constructor(private readonly administration: CredentialAdministrationPort) {}

  async registerAgent(principal: AdministrativePrincipal, input: ProductRegisterAgentInput): Promise<void> {
    await this.administration.registerAgent(principal, input);
  }

  async issueCredential(principal: AdministrativePrincipal, input: ProductIssueCredentialInput) {
    return this.administration.issueAgentCredential(principal, input);
  }
}
