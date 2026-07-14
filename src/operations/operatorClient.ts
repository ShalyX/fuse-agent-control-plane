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
      const [health, casesResponse] = await Promise.all([
        request(new URL("/health", baseUrl), { signal: AbortSignal.timeout(10_000) }),
        request(new URL("/api/v1/admin/reconciliation", baseUrl), {
          headers: { Authorization: authorization },
          signal: AbortSignal.timeout(10_000),
        }),
      ]);
      if (!casesResponse.ok) throw new Error(`OPERATOR_CASES_REJECTED:${casesResponse.status}`);
      const parsed = casesSchema.safeParse(await casesResponse.json());
      if (!parsed.success) throw new Error("OPERATOR_CASES_RESPONSE_INVALID");
      const casesByReason: Record<string, number> = {};
      for (const item of parsed.data.cases) {
        casesByReason[item.reasonCode] = (casesByReason[item.reasonCode] ?? 0) + 1;
      }
      return {
        healthy: health.ok,
        openReconciliationCases: parsed.data.cases.length,
        casesByReason,
        oldestHeldAt: parsed.data.cases[0]?.heldAt ?? null,
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
