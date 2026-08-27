import { z } from "zod";

const casesSchema = z.object({
  cases: z.array(z.object({
    requestId: z.string().min(1),
    mandateId: z.string().min(1),
    agentId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    reasonCode: z.string().min(1),
    reservedCostAtomic: z.string().regex(/^\d+$/),
    reportedCostAtomic: z.string().regex(/^\d+$/).nullable(),
    hasProviderResponse: z.boolean(),
    heldAt: z.string().datetime(),
  }).strict()),
}).strict();

const operationalReadinessSchema = z.object({
  controlMode: z.boolean(),
  settlementDisabled: z.boolean(),
  durableInviteGate: z.boolean(),
  durableAdminRateLimit: z.boolean(),
  sourceCredentialRevocationEnforced: z.boolean(),
  staleOnboardingOperations: z.number().int().nonnegative(),
  rollbackFailedOnboardingOperations: z.number().int().nonnegative(),
  oldestInProgressAt: z.string().datetime().nullable(),
  orphanCapacityReservations: z.number().int().nonnegative(),
  oldestOrphanReservationAt: z.string().datetime().nullable(),
}).strict();

export function alphaOperationalAlerts(status: {
  healthy: boolean;
  openReconciliationCases: number;
  operationalReadiness: z.infer<typeof operationalReadinessSchema>;
}): string[] {
  const alerts: string[] = [];
  if (!status.healthy) alerts.push("control_plane_unhealthy");
  if (!status.operationalReadiness.controlMode) alerts.push("control_mode_not_enforced");
  if (!status.operationalReadiness.settlementDisabled) alerts.push("settlement_enabled");
  if (!status.operationalReadiness.durableInviteGate) alerts.push("invite_gate_not_durable");
  if (!status.operationalReadiness.durableAdminRateLimit) alerts.push("admin_rate_limit_not_durable");
  if (!status.operationalReadiness.sourceCredentialRevocationEnforced) {
    alerts.push("source_credential_revocation_not_enforced");
  }
  if (status.operationalReadiness.rollbackFailedOnboardingOperations > 0) {
    alerts.push(`onboarding_rollback_failures:${status.operationalReadiness.rollbackFailedOnboardingOperations}`);
  }
  if (status.operationalReadiness.staleOnboardingOperations > 0) {
    alerts.push(`stale_onboarding_operations:${status.operationalReadiness.staleOnboardingOperations}`);
  }
  if (status.operationalReadiness.orphanCapacityReservations > 0) {
    alerts.push(`orphan_capacity_reservations:${status.operationalReadiness.orphanCapacityReservations}`);
  }
  if (status.openReconciliationCases > 0) {
    alerts.push(`open_reconciliation_cases:${status.openReconciliationCases}`);
  }
  return alerts;
}

export interface ReconciliationResolutionCommand {
  executionRequestId: string;
  resolution: "settle" | "confirm_not_billed";
  actualCostAtomic?: bigint;
  note: string;
  externalReference: string;
  operationRequestId: string;
}

export function createOperatorClient(config: {
  baseUrl: string;
  adminToken: string;
  fetch?: typeof fetch;
}) {
  const baseUrl = new URL(config.baseUrl);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search) {
    throw new Error("OPERATOR_BASE_URL_INVALID");
  }
  if (config.adminToken.length < 32) throw new Error("OPERATOR_TOKEN_INVALID");
  const request = config.fetch ?? fetch;
  const authorization = ["Bearer", config.adminToken].join(" ");
  return {
    async status() {
      const [health, dependencyReadiness, casesResponse, readinessResponse] = await Promise.all([
        request(new URL("/health", baseUrl), { signal: AbortSignal.timeout(10_000) }),
        request(new URL("/ready", baseUrl), { signal: AbortSignal.timeout(10_000) }),
        request(new URL("/api/v1/admin/reconciliation", baseUrl), {
          headers: { Authorization: authorization },
          signal: AbortSignal.timeout(10_000),
        }),
        request(new URL("/api/v1/admin/readiness", baseUrl), {
          headers: { Authorization: authorization },
          signal: AbortSignal.timeout(10_000),
        }),
      ]);
      if (!casesResponse.ok) throw new Error(`OPERATOR_CASES_REJECTED:${casesResponse.status}`);
      if (!readinessResponse.ok) throw new Error(`OPERATOR_READINESS_REJECTED:${readinessResponse.status}`);
      const parsed = casesSchema.safeParse(await casesResponse.json());
      if (!parsed.success) throw new Error("OPERATOR_CASES_RESPONSE_INVALID");
      const readiness = operationalReadinessSchema.safeParse(await readinessResponse.json());
      if (!readiness.success) throw new Error("OPERATOR_READINESS_RESPONSE_INVALID");
      const casesByReason: Record<string, number> = {};
      for (const item of parsed.data.cases) {
        casesByReason[item.reasonCode] = (casesByReason[item.reasonCode] ?? 0) + 1;
      }
      return {
        healthy: health.ok,
        openReconciliationCases: parsed.data.cases.length,
        casesByReason,
        oldestHeldAt: parsed.data.cases[0]?.heldAt ?? null,
        operationalReadiness: readiness.data,
        operationallyReady: health.ok
          && dependencyReadiness.ok
          && parsed.data.cases.length === 0
          && readiness.data.controlMode
          && readiness.data.settlementDisabled
          && readiness.data.durableInviteGate
          && readiness.data.durableAdminRateLimit
          && readiness.data.sourceCredentialRevocationEnforced
          && readiness.data.rollbackFailedOnboardingOperations === 0
          && readiness.data.staleOnboardingOperations === 0
          && readiness.data.orphanCapacityReservations === 0,
      };
    },
    async resolve(command: ReconciliationResolutionCommand): Promise<void> {
      if (!command.executionRequestId.trim() || !command.operationRequestId.trim()) {
        throw new Error("OPERATOR_REQUEST_ID_REQUIRED");
      }
      if (!command.note.trim() || !command.externalReference.trim()) {
        throw new Error("OPERATOR_EVIDENCE_REQUIRED");
      }
      if (command.resolution === "settle") {
        if (command.actualCostAtomic === undefined || command.actualCostAtomic < 0n) {
          throw new Error("OPERATOR_ACTUAL_COST_REQUIRED");
        }
      } else if (command.actualCostAtomic !== undefined) {
        throw new Error("OPERATOR_ACTUAL_COST_FORBIDDEN");
      }
      const response = await request(
        new URL(`/api/v1/admin/reconciliation/${encodeURIComponent(command.executionRequestId)}/resolve`, baseUrl),
        {
          method: "POST",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
            "X-Request-Id": command.operationRequestId,
          },
          body: JSON.stringify({
            resolution: command.resolution,
            ...(command.actualCostAtomic === undefined
              ? {} : { actualCostAtomic: command.actualCostAtomic.toString() }),
            note: command.note,
            externalReference: command.externalReference,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.status !== 204) throw new Error(`OPERATOR_RESOLUTION_REJECTED:${response.status}`);
    },
  };
}
