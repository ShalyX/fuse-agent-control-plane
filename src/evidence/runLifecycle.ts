export type EvidenceRunStage =
  | "setup"
  | "authoritative-setup"
  | "provider-call"
  | "post-call-validation"
  | "final-validation"
  | "interrupted";

export interface EvidenceRunFailureContext {
  stage: EvidenceRunStage;
  requestId: string | null;
  attemptSequence: number | null;
  attemptsPersisted: number;
  plannedAttempts: number;
}

export interface EvidenceRunFailure extends EvidenceRunFailureContext {
  code: string;
  occurredAt: string;
}

export async function runWithIncompleteEvidenceCapture<T>(
  operation: () => Promise<T>,
  persistIncomplete: (failure: EvidenceRunFailure) => Promise<void>,
  context: () => EvidenceRunFailureContext,
  now: () => string = () => new Date().toISOString(),
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const failure: EvidenceRunFailure = {
      code: evidenceFailureCode(error),
      occurredAt: now(),
      ...context(),
    };
    try {
      await persistIncomplete(failure);
    } catch (persistenceError) {
      throw new AggregateError(
        [error, persistenceError],
        "EVIDENCE_INCOMPLETE_MANIFEST_PERSIST_FAILED",
      );
    }
    throw error;
  }
}

export function assertReplayableEvidenceManifestLifecycle(input: {
  schemaVersion?: unknown;
  phase?: unknown;
  failure?: unknown;
}): void {
  if (input.schemaVersion !== 2 && input.schemaVersion !== 3) {
    throw new Error("EVIDENCE_MANIFEST_INVALID");
  }
  if (input.phase === "running") {
    if (input.schemaVersion === 3 && input.failure !== null && input.failure !== undefined) {
      throw new Error("EVIDENCE_MANIFEST_INVALID");
    }
    throw new Error("EVIDENCE_MANIFEST_NOT_TERMINAL");
  }
  if (input.phase === "complete") {
    if (input.schemaVersion === 3 && input.failure !== null && input.failure !== undefined) {
      throw new Error("EVIDENCE_MANIFEST_INVALID");
    }
    return;
  }
  if (input.phase === "incomplete") {
    if (input.schemaVersion !== 3 || !isEvidenceRunFailure(input.failure)) {
      throw new Error("EVIDENCE_MANIFEST_INVALID");
    }
    throw new Error("EVIDENCE_MANIFEST_INCOMPLETE");
  }
  throw new Error("EVIDENCE_MANIFEST_INVALID");
}

function isEvidenceRunFailure(value: unknown): value is EvidenceRunFailure {
  if (!value || typeof value !== "object") return false;
  const failure = value as Partial<Record<keyof EvidenceRunFailure, unknown>>;
  const expectedKeys = [
    "attemptSequence", "attemptsPersisted", "code", "occurredAt",
    "plannedAttempts", "requestId", "stage",
  ];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) return false;
  const stages: EvidenceRunStage[] = [
    "setup", "authoritative-setup", "provider-call", "post-call-validation",
    "final-validation", "interrupted",
  ];
  if (typeof failure.code !== "string" || !/^[A-Z][A-Z0-9_]{2,127}$/.test(failure.code)) return false;
  if (typeof failure.stage !== "string" || !stages.includes(failure.stage as EvidenceRunStage)) return false;
  if (typeof failure.occurredAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(failure.occurredAt)
    || new Date(failure.occurredAt).toISOString() !== failure.occurredAt) return false;
  if (!Number.isInteger(failure.attemptsPersisted) || Number(failure.attemptsPersisted) < 0) return false;
  if (!Number.isInteger(failure.plannedAttempts) || Number(failure.plannedAttempts) < 0) return false;
  if (Number(failure.attemptsPersisted) > Number(failure.plannedAttempts)) return false;
  const noActiveAttempt = failure.requestId === null && failure.attemptSequence === null;
  const activeAttempt = typeof failure.requestId === "string" && failure.requestId.length > 0
    && Number.isInteger(failure.attemptSequence) && Number(failure.attemptSequence) > 0
    && Number(failure.attemptSequence) <= Number(failure.plannedAttempts);
  return noActiveAttempt || activeAttempt;
}

const evidenceFailureCodes = new Set([
  "CIRCLE_API_KEY_REQUIRED",
  "CIRCLE_ENTITY_SECRET_REQUIRED",
  "DATABASE_URL_REQUIRED",
  "EVIDENCE_AUTHORITATIVE_SETUP_COVERAGE_INVALID",
  "EVIDENCE_AUTHORITATIVE_SETUP_MISMATCH",
  "EVIDENCE_OPERATION_TIMEOUT",
  "EVIDENCE_PROVIDER_COST_CAP_EXCEEDED",
  "EVIDENCE_PROVIDER_COST_INVALID",
  "EVIDENCE_RESPONSE_BODY_TOO_LARGE",
  "EVIDENCE_RUN_INTERRUPTED",
  "EVIDENCE_WORKLOAD_COST_CAP_MISSING",
  "EVIDENCE_X402_PAYMENT_REQUIRED",
  "FIXTURE_AGENT_TOKEN_MISSING",
  "FIXTURE_ATTEMPT_MISSING",
  "FIXTURE_CALL_FAILED",
  "FIXTURE_DENIAL_REASON_MISMATCH",
  "FIXTURE_EXPECTATION_FAILED",
  "FIXTURE_HARD_BUDGET_DENIAL_MISSING",
  "FIXTURE_MANIFEST_MISMATCH",
  "FIXTURE_OUTCOME_MISMATCH",
  "FIXTURE_SETUP_FAILED",
  "FUSE_ADMIN_TOKEN_REQUIRED",
  "FUSE_PAYER_ADDRESS_REQUIRED",
  "FUSE_PAYER_WALLET_NOT_FOUND",
  "FUSE_PROVIDER_INVALID",
  "HELD_OUT_MANIFEST_MISMATCH",
  "HELD_OUT_RUN_INCOMPLETE",
  "USE_UNPOOLED_CONNECTION",
]);

function evidenceFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "EVIDENCE_RUN_FAILED";
  const candidate = error.message.split(":", 1)[0]?.trim();
  return candidate && evidenceFailureCodes.has(candidate) ? candidate : "EVIDENCE_RUN_FAILED";
}
