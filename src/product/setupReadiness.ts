import type { AuthenticatedPrincipal } from "../http/auth.js";

export type SetupStatus = "verified" | "configured" | "unavailable" | "not_applicable";

export interface SetupReadinessInput {
  database: boolean;
  providerConfiguration: boolean;
  signerConfiguration: boolean;
  walletChain: boolean;
  gatewayEnvironment: boolean;
  sandbox: boolean;
}

export interface SetupReadiness {
  workspaceId: string;
  status: "ready" | "incomplete";
  checks: {
    database: SetupStatus;
    provider: SetupStatus;
    signer: SetupStatus;
    wallet: SetupStatus;
    gateway: SetupStatus;
    sandbox: SetupStatus;
  };
  missingSteps: string[];
}

function status(value: boolean, verified = false): SetupStatus {
  if (verified && value) return "verified";
  return value ? "configured" : "unavailable";
}

export function buildSetupReadiness(
  principal: Pick<AuthenticatedPrincipal, "organizationId">,
  input: SetupReadinessInput,
): SetupReadiness {
  const checks = {
    database: status(input.database, true),
    provider: status(input.providerConfiguration),
    signer: status(input.signerConfiguration),
    wallet: status(input.walletChain),
    gateway: status(input.gatewayEnvironment),
    sandbox: status(input.sandbox, true),
  };
  const missingSteps: string[] = [];
  if (checks.database === "unavailable") missingSteps.push("Restore the durable database connection");
  if (checks.provider === "unavailable") missingSteps.push("Connect a provider");
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
