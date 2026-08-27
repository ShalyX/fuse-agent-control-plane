import type { AdministrativePrincipal } from "../identity/credentialAdministration.js";
import type { MandateBranch } from "../persistence/policyStore.js";
import type {
  AssignAgentInput,
  CreateBranchInput,
  CreateMandateInput,
  PolicyAdministrationPort,
  TransitionMandateInput,
} from "../policy/policyAdministration.js";

export type ProductMandateInput = Omit<CreateMandateInput, "maximumSpendAtomic" | "requestId"> & {
  maximumSpendAtomic: string;
  requestId: string;
};
export type ProductAgentAssignmentInput = Omit<AssignAgentInput, "requestId"> & { requestId: string };
export type ProductBranchInput = Omit<CreateBranchInput, "maximumSpendAtomic" | "requestId"> & {
  maximumSpendAtomic: string;
  requestId: string;
};
export type ProductMandateTransitionInput = Omit<TransitionMandateInput, "requestId"> & {
  requestId: string;
};

function atomicAmount(value: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("PRODUCT_ATOMIC_AMOUNT_INVALID");
  return BigInt(value);
}

export class MandateManagementService {
  constructor(private readonly administration: PolicyAdministrationPort) {}

  async createMandate(principal: AdministrativePrincipal, input: ProductMandateInput): Promise<void> {
    await this.administration.createMandate(principal, {
      ...input,
      maximumSpendAtomic: atomicAmount(input.maximumSpendAtomic),
    });
  }

  async assignAgent(principal: AdministrativePrincipal, input: ProductAgentAssignmentInput): Promise<void> {
    await this.administration.assignAgent(principal, input);
  }

  async createBranch(principal: AdministrativePrincipal, input: ProductBranchInput): Promise<MandateBranch> {
    const branch = await this.administration.createBranch(principal, {
      ...input,
      maximumSpendAtomic: atomicAmount(input.maximumSpendAtomic),
    });
    return { ...branch, allowedWorkloadClasses: [...branch.allowedWorkloadClasses] };
  }

  async transitionMandate(
    principal: AdministrativePrincipal,
    input: ProductMandateTransitionInput,
  ): Promise<void> {
    await this.administration.transitionMandate(principal, input);
  }
}
