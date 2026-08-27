import type { AdministrativePrincipal } from "../identity/credentialAdministration.js";
import type { PolicyLimits, WorkloadClassPolicy } from "../domain/policy.js";
import type { PolicyAdministrationPort, PublishPolicyInput } from "../policy/policyAdministration.js";

type ProductLimits = Omit<PolicyLimits, "maxPerCallAtomic" | "maxHourlyAtomic" | "maxDailyAtomic"> & {
  maxPerCallAtomic: string;
  maxHourlyAtomic: string;
  maxDailyAtomic: string;
};
type ProductWorkloadClass = Omit<WorkloadClassPolicy, "maxCostPerCallAtomic" | "aggregateBudgetAtomic" | "shadow"> & {
  maxCostPerCallAtomic: string;
  aggregateBudgetAtomic: string;
  shadow: Omit<NonNullable<WorkloadClassPolicy["shadow"]>, "classPriorWindowSpendAtomic"> & {
    classPriorWindowSpendAtomic: string;
  } | null;
};
export type ProductPolicyInput = Omit<PublishPolicyInput, "limits" | "workloadClasses"> & {
  limits: ProductLimits;
  workloadClasses?: ProductWorkloadClass[];
};

export class PolicyPublishingService {
  constructor(private readonly administration: PolicyAdministrationPort) {}

  async publish(principal: AdministrativePrincipal, input: ProductPolicyInput): Promise<void> {
    await this.administration.publishPolicy(principal, {
      ...input,
      limits: {
        ...input.limits,
        maxPerCallAtomic: BigInt(input.limits.maxPerCallAtomic),
        maxHourlyAtomic: BigInt(input.limits.maxHourlyAtomic),
        maxDailyAtomic: BigInt(input.limits.maxDailyAtomic),
      },
      ...(input.workloadClasses ? {
        workloadClasses: input.workloadClasses.map((item) => ({
          ...item,
          maxCostPerCallAtomic: BigInt(item.maxCostPerCallAtomic),
          aggregateBudgetAtomic: BigInt(item.aggregateBudgetAtomic),
          shadow: item.shadow ? {
            ...item.shadow,
            classPriorWindowSpendAtomic: BigInt(item.shadow.classPriorWindowSpendAtomic),
          } : null,
        })),
      } : {}),
    } as PublishPolicyInput);
  }
}
