import type { AuthenticatedPrincipal } from "../http/auth.js";
import type { SetupReadiness, SetupStatus } from "./setupReadiness.js";

export interface ProductReadinessInput {
  paymentMode: "control" | "settlement";
  database: boolean;
  providerConfiguration: boolean;
  policyConfiguration: boolean;
  agentCredential: boolean;
  mandate: boolean;
  signerConfiguration: boolean;
  walletChain: boolean;
  gatewayEnvironment: boolean;
  sandbox: boolean;
}

export interface ProductReadiness extends Omit<SetupReadiness, "checks" | "status" | "missingSteps"> {
  status: "ready" | "incomplete";
  checks: SetupReadiness["checks"] & {
    policy: SetupStatus;
    agentCredential: SetupStatus;
    mandate: SetupStatus;
  };
  missingSteps: string[];
}

const check = (value: boolean, verified = false): SetupStatus => verified && value ? "verified" : value ? "configured" : "unavailable";

export function buildProductReadiness(
  principal: Pick<AuthenticatedPrincipal, "organizationId">,
  input: ProductReadinessInput,
): ProductReadiness {
  const checks = {
    database: check(input.database, true),
    provider: check(input.providerConfiguration),
    policy: check(input.policyConfiguration),
    agentCredential: check(input.agentCredential),
    mandate: check(input.mandate),
    signer: input.paymentMode === "control" ? "not_applicable" as const : check(input.signerConfiguration),
    wallet: input.paymentMode === "control" ? "not_applicable" as const : check(input.walletChain),
    gateway: input.paymentMode === "control" ? "not_applicable" as const : check(input.gatewayEnvironment),
    sandbox: check(input.sandbox, true),
  };
  const missingSteps: string[] = [];
  if (checks.database === "unavailable") missingSteps.push("Restore the durable database connection");
  if (checks.provider === "unavailable") missingSteps.push("Connect a provider");
  if (checks.policy === "unavailable") missingSteps.push("Publish a policy");
  if (checks.agentCredential === "unavailable") missingSteps.push("Issue an agent credential");
  if (checks.mandate === "unavailable") missingSteps.push("Create a mandate");
  if (checks.signer === "unavailable") missingSteps.push("Configure the signer boundary");
  if (checks.wallet === "unavailable") missingSteps.push("Verify the wallet chain");
  if (checks.gateway === "unavailable") missingSteps.push("Align the Gateway environment");
  if (checks.sandbox === "unavailable") missingSteps.push("Restore the durable sandbox run store");
  return {
    workspaceId: principal.organizationId,
    status: missingSteps.length === 0 ? "ready" : "incomplete",
    checks,
    missingSteps,
  };
}
