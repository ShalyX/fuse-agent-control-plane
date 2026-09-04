import { randomUUID } from "node:crypto";
import express, { type RequestHandler } from "express";
import { z } from "zod";
import { FuseService, type InferenceProvider } from "../core/service.js";
import { MemoryStateStore, type ServiceStateStore } from "../persistence/store.js";
import { renderControlDesk } from "./desk.js";
import { renderOperatorConsole } from "./console.js";
import { renderLandingPage } from "./landing.js";
import { createAuthenticationGuard, createCapabilityGuard, type CredentialAuthenticator } from "./auth.js";
import { createHumanSession, type HumanSessionStore } from "./humanSessions.js";
import type { AdministrativePrincipal, CredentialAdministrationPort } from "../identity/credentialAdministration.js";
import { API_CAPABILITIES } from "../identity/apiCredentials.js";
import type { PolicyAdministrationPort } from "../policy/policyAdministration.js";
import type { ProviderAdministrationPort } from "../providers/providerAdministration.js";
import { ProviderConnectionService } from "../product/providerConnections.js";
import { MandateManagementService, type ProductBranchInput, type ProductMandateInput } from "../product/mandateManagement.js";
import { PolicyPublishingService, type ProductPolicyInput } from "../product/policyPublishing.js";
import { AgentIdentityService, type ProductIssueCredentialInput, type ProductRegisterAgentInput } from "../product/agentIdentity.js";
import { ProductInferenceService } from "../product/inference.js";
import { ProductReceiptService } from "../product/receipts.js";
import { SandboxRunService } from "../product/sandboxRuns.js";
import type { SandboxRunStore } from "../product/sandboxRunStore.js";
import type { PaymentEvidenceStore } from "../product/paymentEvidence.js";
import type {
  AdmissionResult,
  ControlledInferenceInput,
} from "../inference/inferenceExecution.js";
import { issueReliabilityProtocolContext } from "../inference/inferenceExecution.js";
import { calculateMaximumCostMicros } from "../core/pricing.js";
import { buildSetupReadiness, type SetupReadinessInput } from "../product/setupReadiness.js";
import { buildProductReadiness, type ProductReadinessInput } from "../product/productReadiness.js";
import { CustomerOnboardingService, type CustomerOnboardingPort, type CreateWorkspaceInput } from "../product/customerOnboarding.js";
import { withTrustedReplayOperation } from "../reliability/replayOperationContext.js";
import type { StableSuccessfulResponseProjection } from "../reliability/commitments.js";
import type { OperationalAuditEvent, OperationalAuditStore } from "../product/operationalAudit.js";

const MAX_HUMAN_SESSION_MS = 24 * 60 * 60 * 1_000;

const completionSchema = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive().max(32_000),
  workload_class: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/).optional(),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
  }).strict()).min(1),
});

type PaymentGuardFactory = (priceUsdc: string) => RequestHandler;

function logInferenceFailure(route: string, requestId: string | undefined, error: unknown): void {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  console.error(JSON.stringify({
    event: "inference_execution_failure",
    route,
    ...(requestId ? { requestId } : {}),
    ...(typeof value.name === "string" ? { errorName: value.name } : {}),
    ...(typeof value.code === "string" ? { errorCode: value.code } : {}),
    ...(typeof value.message === "string" && /^[A-Z0-9_]+$/.test(value.message) && value.message.length <= 128
      ? { errorMessage: value.message } : {}),
    ...(typeof value.phase === "string" ? { phase: value.phase } : {}),
    ...(typeof value.status === "number" ? { upstreamStatus: value.status } : {}),
    ...(typeof value.generationId === "string" ? { generationId: value.generationId } : {}),
  }));
}

function publicInferenceError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "OPENROUTER_401" || message === "OPENROUTER_403") return "PROVIDER_CREDENTIAL_REJECTED";
  if (message === "OPENROUTER_429") return "PROVIDER_RATE_LIMITED";
  if (message === "OPENROUTER_COMPLETION_ERROR") return "PROVIDER_REQUEST_REJECTED";
  if (/^(OPENROUTER|ANTHROPIC)_/.test(message)) return "PROVIDER_UNAVAILABLE";
  return "INFERENCE_EXECUTION_UNAVAILABLE";
}

const agentRegistrationSchema = z.object({
  agentId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
}).strict();

const agentCredentialIssueSchema = z.object({
  credentialId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  capabilities: z.array(z.enum([
    "inference:invoke",
    "mandates:read",
    "mandates:write",
    "receipts:read",
  ])).min(1),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict();

const serviceCredentialIssueSchema = z.object({
  credentialId: z.string().min(1).max(128),
  serviceAccountId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  capabilities: z.array(z.enum(API_CAPABILITIES)).min(1),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict();

const providerPriceSchema = z.string().regex(/^\d+(?:\.\d{1,12})?$/).max(64)
  .refine((value) => Number(value) > 0);
const providerConfigurationSchema = z.object({
  configId: z.string().min(1).max(128),
  provider: z.literal("openrouter"),
  model: z.string().min(1).max(256),
  apiKey: z.string().min(8).max(4096),
  inputUsdPerMillion: providerPriceSchema,
  outputUsdPerMillion: providerPriceSchema,
}).strict();

const atomicAmountSchema = z.string().regex(/^\d+$/).max(78);
const positiveAtomicAmountSchema = z.string().regex(/^[1-9]\d*$/).max(78);
const policyLimitsSchema = z.object({
  maxPerCallAtomic: atomicAmountSchema,
  maxHourlyAtomic: atomicAmountSchema,
  maxDailyAtomic: atomicAmountSchema,
  maxRequestsPerMinute: z.number().int().nonnegative().max(1_000_000),
  maxInputTokens: z.number().int().nonnegative().max(10_000_000),
  maxOutputTokens: z.number().int().nonnegative().max(10_000_000),
}).strict();
const workloadShadowSchema = z.object({
  classPriorWindowSpendAtomic: positiveAtomicAmountSchema,
  windowSeconds: z.number().int().positive().max(86_400),
  targetMinimumObservations: z.number().int().positive().max(10_000),
  siblingMinimumForScoring: z.number().int().positive().max(10_000),
  siblingMinimumForIntervention: z.number().int().positive().max(10_000),
  confidenceConstant: z.number().int().positive().max(10_000),
  divergenceThresholdBps: z.number().int().positive().max(10_000_000),
}).strict();
const workloadClassSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  maxCostPerCallAtomic: positiveAtomicAmountSchema,
  maxInvocationsPerBranch: z.number().int().positive().max(1_000_000),
  aggregateBudgetAtomic: positiveAtomicAmountSchema,
  minimumInputTokens: z.number().int().nonnegative().max(10_000_000),
  shadow: workloadShadowSchema.nullable(),
}).strict();
const policyPublishSchema = z.object({
  policyId: z.string().min(1).max(128),
  version: z.number().int().positive().max(1_000_000),
  mode: z.enum(["dry_run", "enforce", "paused"]),
  allowedProviders: z.array(z.string().min(1).max(128)).min(1).max(100),
  allowedModels: z.array(z.string().min(1).max(256)).min(1).max(1_000),
  requiredCapability: z.enum(API_CAPABILITIES),
  limits: policyLimitsSchema,
  workloadClasses: z.array(workloadClassSchema).max(100).optional(),
}).strict();
const mandateCreateSchema = z.object({
  mandateId: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  assetId: z.string().min(1).max(128),
  maximumSpendAtomic: positiveAtomicAmountSchema,
  policyId: z.string().min(1).max(128),
  policyVersion: z.number().int().positive().max(1_000_000),
  expiresAt: z.string().datetime().nullable(),
}).strict();
const mandateAssignmentSchema = z.object({
  agentId: z.string().min(1).max(128),
}).strict();
const mandateBranchSchema = z.object({
  branchId: z.string().min(1).max(128),
  parentBranchId: z.string().min(1).max(128).nullable(),
  agentId: z.string().min(1).max(128),
  allowedWorkloadClasses: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/)).min(1).max(100),
  maximumSpendAtomic: positiveAtomicAmountSchema,
  expiresAt: z.string().datetime().nullable(),
}).strict();
const mandatePolicySchema = z.object({
  policyId: z.string().min(1).max(128),
  policyVersion: z.number().int().positive().max(1_000_000),
}).strict();
const workspaceCreateSchema = z.object({
  name: z.string().trim().min(1).max(128),
  agentName: z.string().trim().min(1).max(128),
  provider: z.literal("openrouter"),
  model: z.string().trim().min(1).max(256),
  apiKey: z.string().min(1).max(512),
  inputUsdPerMillion: providerPriceSchema,
  outputUsdPerMillion: providerPriceSchema,
  maximumSpendAtomic: positiveAtomicAmountSchema,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict();

const reconciliationResolutionSchema = z.object({
  resolution: z.enum(["settle", "confirm_not_billed"]),
  actualCostAtomic: atomicAmountSchema.optional(),
  note: z.string().trim().min(1).max(2_000),
  externalReference: z.string().trim().min(1).max(512),
}).strict().superRefine((value, context) => {
  if (value.resolution === "settle" && value.actualCostAtomic === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "actual cost required" });
  }
  if (value.resolution === "confirm_not_billed" && value.actualCostAtomic !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "actual cost forbidden" });
  }
});

const mandateTransitionSchema = z.object({
  to: z.enum([
    "draft", "active", "paused", "closing", "closed", "exhausted", "tripped",
    "expired", "reconciliation_hold",
  ]),
}).strict();

export interface OperationalReadiness {
  controlMode: boolean;
  settlementDisabled: boolean;
  durableInviteGate: boolean;
  durableAdminRateLimit: boolean;
  sourceCredentialRevocationEnforced: boolean;
  staleOnboardingOperations: number;
  rollbackFailedOnboardingOperations: number;
  oldestInProgressAt: string | null;
  orphanCapacityReservations: number;
  oldestOrphanReservationAt: string | null;
}

type AppDependencies = {
  provider: InferenceProvider;
  paymentGuard?: PaymentGuardFactory;
  paymentMode?: "control" | "settlement";
  estimateInputTokens: (messages: Array<{ role: string; content: string }>) => number;
  payerWallet?: string;
  price?: { inputUsdPerMillion: string; outputUsdPerMillion: string };
  stateStore?: ServiceStateStore;
  credentialAuthenticator?: CredentialAuthenticator;
  humanSessionStore?: HumanSessionStore;
  credentialAdministration?: CredentialAdministrationPort;
  agentIdentityService?: AgentIdentityService;
  policyAdministration?: PolicyAdministrationPort;
  policyPublishingService?: PolicyPublishingService;
  mandateManagementService?: MandateManagementService;
  providerAdministration?: ProviderAdministrationPort;
  providerConnectionService?: ProviderConnectionService;
  inferenceExecution?: {
    execute(input: ControlledInferenceInput): Promise<AdmissionResult>;
    preview?(input: ControlledInferenceInput): Promise<AdmissionResult>;
  };
  productInferenceService?: ProductInferenceService;
  productReceiptService?: ProductReceiptService;
  sandboxRunService?: SandboxRunService;
  sandboxRunStore?: SandboxRunStore;
  paymentEvidenceStore?: PaymentEvidenceStore;
  customerOnboardingService?: CustomerOnboardingPort;
  operationalAudit?: OperationalAuditStore;
  reliabilityContextIssuer?: (input: {
    runId: string | null; laneId: string | null; block: number | null; requestId: string;
    organizationId: string; agentId: string; credentialId: string; mandateId: string; branchId: string | null;
    workloadClass: string | null; model: string; maxOutputTokens: number; body: unknown;
  }) => Promise<{ kind: "ordinary" } | { kind?: "reliability"; callOrdinal: number; requestCommitment?:string } | null>;
  replayOperationAuthorizer?: (input: {
    operationId: string; organizationId: string; credentialId: string; agentId: string;
    mandateId: string; branchId: string | null; workloadClass: string | null;
    idempotencyKey: string; body: unknown;
  }) => Promise<{ authorized: true } | null>;
  sealedReplayExecution?: {
    execute(input: {
      operationId: string; organizationId: string; credentialId: string; agentId: string;
      mandateId: string; branchId: string | null; workloadClass: string | null;
      requestId: string; body: unknown; inputTokens: number; maxOutputTokens: number;
      messages: Array<{ role: string; content: string }>;
    }): Promise<StableSuccessfulResponseProjection>;
  };
  readiness?: () => Promise<Record<string, boolean>>;
  operationalReadiness?: () => Promise<OperationalReadiness>;
  productReadiness?: (principal: { organizationId: string }) => Promise<ProductReadinessInput>;
  workloadShadowEnabled?: boolean;
  adminRateLimit?: {
    maxPerMinute: number;
    now?: () => number;
    consume?: (key: string, maxPerMinute: number, now: number) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  };
  onboardingRateLimit?: {
    maxPerMinute: number;
    now?: () => number;
    consume?: (key: string, maxPerMinute: number, now: number) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  };
  betaOnboardingGuard?: {
    maxActiveWorkspaces: number;
    reserveCapacity: (idempotencyKey: string) => Promise<boolean>;
    authorizeInvite: (inviteToken: string, idempotencyKey: string) => Promise<boolean>;
    authorizeRecoveryInvite?: (inviteToken: string, idempotencyKey: string) => Promise<boolean>;
  };
  productRateLimit?: {
    maxPerMinute: number;
    now?: () => number;
    consume?: (key: string, maxPerMinute: number, now: number) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  };
  sessionRateLimit?: {
    maxPerMinute: number;
    now?: () => number;
    consume?: (key: string, maxPerMinute: number, now: number) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  };
  requestLogger?: (event: {
    requestId: string;
    method: string;
    path: string;
    status: number;
    durationMs: number;
  }) => void;
  nowMs?: () => number;
};

function microsToUsdc(micros: bigint): string {
  return `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, "0")}`;
}

function maximumQuoteUsdc(inputTokens: number, maxOutputTokens: number, price?: { inputUsdPerMillion: string; outputUsdPerMillion: string }): string {
  return microsToUsdc(calculateMaximumCostMicros(
    { inputTokens, maxOutputTokens },
    price ?? { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" },
  ));
}

async function requirePayment(request: express.Request, response: express.Response, guard: RequestHandler): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    guard(request, response, (error?: unknown) => {
      settled = true;
      if (error) reject(error);
      else resolve(true);
    });
    if (!settled && response.headersSent) resolve(false);
  });
}

export function createFuseApp(dependencies: AppDependencies) {
  const app = express();
  const paymentRequired = dependencies.paymentMode === "settlement";
  if (paymentRequired && !dependencies.paymentGuard) throw new Error("SETTLEMENT_PAYMENT_GUARD_REQUIRED");
  const stateStore = dependencies.stateStore ?? new MemoryStateStore();
  const initialState = () => FuseService.createDemo(dependencies.provider, {
    payerWallet: dependencies.payerWallet,
    price: dependencies.price,
  }).exportState();
  const readService = async () => FuseService.fromState(dependencies.provider, await stateStore.read(initialState));
  const mutateService = <T>(operation: (service: FuseService) => Promise<T>) => stateStore.mutate(
    initialState,
    async (state) => {
      const service = FuseService.fromState(dependencies.provider, state);
      const result = await operation(service);
      return { state: service.exportState(), result };
    },
  );
  const readPublicState = async () => {
    const service = await readService();
    const snapshot = service.snapshot();
    const usdc = (value: bigint) => microsToUsdc(value);
    return {
      recordId: snapshot.ledger.mandateId,
      mandateId: snapshot.ledger.mandateId,
      persistence: stateStore.kind,
      parentUnallocatedUsdc: usdc(snapshot.ledger.parentUnallocatedMicros),
      root: {
        authorizedUsdc: usdc(snapshot.ledger.root.authorizedMicros),
        reservedUsdc: usdc(snapshot.ledger.root.reservedMicros),
        settledUsdc: usdc(snapshot.ledger.root.settledMicros),
        availableUsdc: usdc(snapshot.ledger.root.availableMicros),
      },
      children: Object.fromEntries(Object.entries(snapshot.ledger.children).map(([childId, account]) => [
        childId,
        {
          authorizedUsdc: usdc(account.authorizedMicros),
          reservedUsdc: usdc(account.reservedMicros),
          settledUsdc: usdc(account.settledMicros),
          availableUsdc: usdc(account.availableMicros),
          circuitState: snapshot.circuits[childId]?.state ?? "UNKNOWN",
        },
      ])),
    };
  };
  const disableCaching = (response: express.Response) => {
    response.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "CDN-Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store",
    });
  };
  const auditOrUnavailable = async (
    response: express.Response,
    event: Omit<OperationalAuditEvent, "occurredAt">,
  ): Promise<boolean> => {
    if (!dependencies.operationalAudit) return true;
    try {
      await dependencies.operationalAudit.record({ ...event, occurredAt: new Date().toISOString() });
      return true;
    } catch {
      disableCaching(response);
      response.status(503).json({ error: { code: "AUDIT_UNAVAILABLE" } });
      return false;
    }
  };
  const handlePolicyError = (error: unknown, response: express.Response) => {
    const message = error instanceof Error ? error.message : "";
    const databaseCode = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "") : "";
    if ([
      "SERVICE_ACCOUNT_REQUIRED", "SERVICE_ACCOUNT_ADMIN_REQUIRED",
      "POLICY_CAPABILITY_REQUIRED", "MANDATE_CAPABILITY_REQUIRED",
      "PROVIDER_CAPABILITY_REQUIRED",
    ].includes(message)) {
      response.status(403).json({ error: { code: message } });
    } else if (databaseCode === "23505") {
      response.status(409).json({ error: { code: "POLICY_RESOURCE_CONFLICT" } });
    } else if (databaseCode === "23503" || message === "CONTROL_MANDATE_NOT_FOUND"
      || message === "INFERENCE_EXECUTION_NOT_FOUND" || message === "MANDATE_PARENT_BRANCH_NOT_FOUND") {
      response.status(404).json({ error: { code: message === "INFERENCE_EXECUTION_NOT_FOUND"
        ? "RECONCILIATION_CASE_NOT_FOUND" : "POLICY_RESOURCE_NOT_FOUND" } });
    } else if (message === "RECONCILIATION_CASE_NOT_OPEN"
      || message === "RECONCILIATION_RESOLUTION_CONFLICT") {
      response.status(409).json({ error: { code: message } });
    } else if (message.startsWith("CONTROL_MANDATE_TRANSITION_INVALID")
      || [
        "CONTROL_MANDATE_POLICY_CHANGE_REQUIRES_PAUSE",
        "MANDATE_BRANCH_CHANGE_REQUIRES_PAUSE",
        "MANDATE_BRANCH_WORKLOAD_CLASS_NOT_IN_POLICY",
        "MANDATE_BRANCH_AGENT_NOT_ASSIGNED",
        "MANDATE_PARENT_BRANCH_POLICY_MISMATCH",
        "MANDATE_BRANCH_PARENT_AUTHORITY_EXCEEDED",
        "MANDATE_BRANCH_BUDGET_EXCEEDS_MANDATE",
        "MANDATE_BRANCH_PARENT_BUDGET_EXCEEDED",
        "MANDATE_BRANCH_EXPIRY_EXCEEDS_MANDATE",
        "MANDATE_BRANCH_PARENT_EXPIRY_EXCEEDED",
      ].includes(message)) {
      response.status(409).json({ error: { code: message === "CONTROL_MANDATE_POLICY_CHANGE_REQUIRES_PAUSE"
        || !message.startsWith("CONTROL_MANDATE_TRANSITION_INVALID")
        ? message : "MANDATE_TRANSITION_INVALID" } });
    } else if (message.endsWith("_REQUIRED") || message.endsWith("_INVALID")
      || message.endsWith("_DUPLICATE")) {
      response.status(400).json({ error: { code: message } });
    } else {
      response.status(503).json({ error: { code: "POLICY_ADMINISTRATION_UNAVAILABLE" } });
    }
  };
  const handleProviderError = (error: unknown, response: express.Response) => {
    const message = error instanceof Error ? error.message : "";
    if (["SERVICE_ACCOUNT_REQUIRED", "SERVICE_ACCOUNT_ADMIN_REQUIRED", "PROVIDER_CAPABILITY_REQUIRED"]
      .includes(message)) {
      response.status(403).json({ error: { code: message } });
    } else if (["PROVIDER_CONFIGURATION_ID_CONFLICT", "PROVIDER_VERIFICATION_IN_PROGRESS", "PROVIDER_ALREADY_VERIFIED"]
      .includes(message)) {
      response.status(409).json({ error: { code: message } });
    } else if (message.endsWith("_REQUIRED") || message.endsWith("_INVALID")) {
      response.status(400).json({ error: { code: message } });
    } else {
      response.status(503).json({ error: { code: "PROVIDER_ADMINISTRATION_UNAVAILABLE" } });
    }
  };
  const handleIdentityError = (error: unknown, response: express.Response) => {
    const message = error instanceof Error ? error.message : "";
    if (["SERVICE_ACCOUNT_REQUIRED", "SERVICE_ACCOUNT_ADMIN_REQUIRED", "AGENT_CAPABILITY_REQUIRED", "CREDENTIAL_CAPABILITY_REQUIRED"]
      .includes(message)) {
      response.status(403).json({ error: { code: message } });
    } else if (message === "AGENT_CREDENTIAL_CAPABILITY_INVALID") {
      response.status(400).json({ error: { code: message } });
    } else if (message === "AGENT_NOT_FOUND" || message === "CREDENTIAL_NOT_FOUND") {
      response.status(404).json({ error: { code: message } });
    } else if (message.endsWith("_REQUIRED") || message.endsWith("_INVALID") || message.endsWith("_DUPLICATE")) {
      response.status(400).json({ error: { code: message } });
    } else {
      response.status(503).json({ error: { code: "IDENTITY_ADMINISTRATION_UNAVAILABLE" } });
    }
  };
  app.use((request, response, next) => {
    const supplied = request.header("X-Request-Id")?.trim();
    const requestId = supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
    const startedAt = dependencies.nowMs?.() ?? Date.now();
    response.set("X-Request-Id", requestId);
    response.on("finish", () => {
      if (!dependencies.requestLogger) return;
      try {
        dependencies.requestLogger({
          requestId,
          method: request.method,
          path: request.path,
          status: response.statusCode,
          durationMs: Math.max(0, (dependencies.nowMs?.() ?? Date.now()) - startedAt),
        });
      } catch {
        // Logging must never change request behavior.
      }
    });
    next();
  });
  app.use((_request, response, next) => {
    response.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "Content-Security-Policy": [
        "default-src 'self'", "base-uri 'self'", "frame-ancestors 'none'",
        "form-action 'self'", "img-src 'self' data:", "connect-src 'self'",
        "style-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline'",
      ].join("; "),
    });
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  const adminRateLimit = dependencies.adminRateLimit ?? { maxPerMinute: 120 };
  if (!Number.isSafeInteger(adminRateLimit.maxPerMinute) || adminRateLimit.maxPerMinute < 1) {
    throw new Error("ADMIN_RATE_LIMIT_INVALID");
  }
  const onboardingRateLimit = dependencies.onboardingRateLimit ?? { maxPerMinute: 5 };
  if (!Number.isSafeInteger(onboardingRateLimit.maxPerMinute) || onboardingRateLimit.maxPerMinute < 1) {
    throw new Error("ONBOARDING_RATE_LIMIT_INVALID");
  }
  let onboardingRateWindows = new Map<string, { startedAt: number; count: number }>();
  let onboardingRateGenerationStartedAt = 0;
  if (dependencies.customerOnboardingService) {
    app.post("/api/v1/product/workspaces", async (request, response) => {
      disableCaching(response);
      const now = onboardingRateLimit.now?.() ?? Date.now();
      if (onboardingRateGenerationStartedAt === 0 || now - onboardingRateGenerationStartedAt >= 60_000) {
        onboardingRateGenerationStartedAt = now;
        onboardingRateWindows = new Map();
      }
      const origin = request.ip || request.socket.remoteAddress || "unknown";
      if (onboardingRateLimit.consume) {
        const decision = await onboardingRateLimit.consume(origin, onboardingRateLimit.maxPerMinute, now);
        if (!decision.allowed) {
          response.set("Retry-After", String(decision.retryAfterSeconds));
          response.status(429).json({ error: { code: "ONBOARDING_RATE_LIMIT_EXCEEDED" } });
          return;
        }
      } else {
        if (onboardingRateGenerationStartedAt === 0 || now - onboardingRateGenerationStartedAt >= 60_000) {
          onboardingRateGenerationStartedAt = now;
          onboardingRateWindows = new Map();
        }
        const window = onboardingRateWindows.get(origin) ?? { startedAt: now, count: 0 };
        window.count += 1;
        onboardingRateWindows.set(origin, window);
        if (window.count > onboardingRateLimit.maxPerMinute) {
          response.set("Retry-After", String(Math.max(1, Math.ceil((window.startedAt + 60_000 - now) / 1_000))));
          response.status(429).json({ error: { code: "ONBOARDING_RATE_LIMIT_EXCEEDED" } });
          return;
        }
      }
      const idempotencyKey = request.header("Idempotency-Key")?.trim();
      if (!idempotencyKey) {
        response.status(400).json({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
        return;
      }
      const parsed = workspaceCreateSchema.safeParse({ ...request.body, idempotencyKey });
      if (!parsed.success) {
        response.status(400).json({ error: { code: "INVALID_WORKSPACE_REQUEST" } });
        return;
      }
      if (dependencies.betaOnboardingGuard) {
        const inviteToken = request.header("X-Fuse-Invite")?.trim();
        if (!inviteToken) {
          if (!await auditOrUnavailable(response, {
            eventType: "invite.rejected", scopeId: idempotencyKey, outcome: "denied",
            metadata: { reason: "missing" },
          })) return;
          response.status(403).json({ error: { code: "BETA_INVITE_REQUIRED" } });
          return;
        }
        const authorized = await dependencies.betaOnboardingGuard.authorizeInvite(inviteToken, idempotencyKey);
        if (!authorized) {
          if (!await auditOrUnavailable(response, {
            eventType: "invite.rejected", scopeId: idempotencyKey, outcome: "denied",
            metadata: { reason: "invalid_or_consumed" },
          })) return;
          response.status(403).json({ error: { code: "BETA_INVITE_INVALID" } });
          return;
        }
        if (!await dependencies.betaOnboardingGuard.reserveCapacity(idempotencyKey)) {
          response.status(503).json({ error: { code: "BETA_ONBOARDING_CAPACITY_EXHAUSTED" } });
          return;
        }
        if (!await auditOrUnavailable(response, {
          eventType: "invite.consumed", scopeId: idempotencyKey, outcome: "allowed", metadata: {},
        })) return;
      }
      try {
        const result = await dependencies.customerOnboardingService!.createWorkspace(parsed.data as CreateWorkspaceInput);
        if (!await auditOrUnavailable(response, {
          eventType: "onboarding.completed", scopeId: result.workspaceId, outcome: "completed",
          metadata: { idempotencyKey },
        })) return;
        response.status(201).json({
          workspaceId: result.workspaceId,
          agentId: result.agentId,
          mandateId: result.mandateId,
          policyId: result.policyId,
          providerConfigId: result.providerConfigId,
          adminCredential: result.adminCredential,
          credential: result.credential,
          recoveryCode: result.recoveryCode,
          next: {
            method: "POST",
            path: "/api/v1/product/inference",
            headers: {
              Authorization: "Bearer <credential.token>",
              "Idempotency-Key": "your-unique-request-id",
              "X-Fuse-Mandate": result.mandateId,
            },
          },
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : "WORKSPACE_CREATION_FAILED";
        if (!await auditOrUnavailable(response, {
          eventType: code === "WORKSPACE_ONBOARDING_ROLLBACK_FAILED" ? "onboarding.rollback_failed" : "onboarding.rolled_back",
          scopeId: idempotencyKey,
          outcome: code === "WORKSPACE_ONBOARDING_ROLLBACK_FAILED" ? "failed" : "rolled_back",
          metadata: { failureCode: code.slice(0, 96) },
        })) return;
        const status = code.includes("REQUIRED") || code.includes("INVALID") ? 400
          : code.includes("CONFLICT") || code.includes("IN_PROGRESS") || code.includes("CREDENTIAL_UNAVAILABLE") ? 409
          : 503;
        response.status(status)
          .json({ error: { code: code.replace(/[^A-Z0-9_:-]/g, "_").slice(0, 96) } });
      }
    });

    app.post("/api/v1/product/workspaces/:workspaceId/credential-recovery", async (request, response) => {
      disableCaching(response);
      const origin = request.ip || request.socket.remoteAddress || "unknown";
      const now = onboardingRateLimit.now?.() ?? Date.now();
      if (onboardingRateLimit.consume) {
        const decision = await onboardingRateLimit.consume(`recovery:${origin}`, onboardingRateLimit.maxPerMinute, now);
        if (!decision.allowed) {
          response.set("Retry-After", String(decision.retryAfterSeconds));
          response.status(429).json({ error: { code: "CREDENTIAL_RECOVERY_RATE_LIMIT_EXCEEDED" } });
          return;
        }
      }
      const parsed = z.object({ recoveryCode: z.string().regex(/^fuse_rc_[A-Za-z0-9_-]{16,128}$/) }).safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: { code: "RECOVERY_CODE_INVALID" } });
        return;
      }
      const idempotencyKey = request.header("Idempotency-Key")?.trim();
      if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
        response.status(400).json({ error: { code: "IDEMPOTENCY_KEY_INVALID" } });
        return;
      }
      try {
        const result = await dependencies.customerOnboardingService!.recoverWorkspaceCredential({
          workspaceId: request.params.workspaceId,
          recoveryCode: parsed.data.recoveryCode,
          idempotencyKey,
        });
        response.status(200).json(result);
      } catch (error) {
        const code = error instanceof Error ? error.message : "CREDENTIAL_RECOVERY_FAILED";
        if (code === "CREDENTIAL_RECOVERY_INVALID") {
          response.status(401).json({ error: { code } });
        } else if (code === "RECOVERY_CODE_INVALID" || code === "WORKSPACE_ID_INVALID" || code === "IDEMPOTENCY_KEY_INVALID") {
          response.status(400).json({ error: { code } });
        } else if (code === "CREDENTIAL_RECOVERY_UNAVAILABLE") {
          response.status(503).json({ error: { code } });
        } else {
          response.status(503).json({ error: { code: "CREDENTIAL_RECOVERY_FAILED" } });
        }
      }
    });
    const onboardingService = dependencies.customerOnboardingService;
    if (dependencies.credentialAuthenticator && onboardingService.issueReplacementCredentials) {
      app.post(
        "/api/v1/product/workspaces/:workspaceId/credential-package",
        createCapabilityGuard(dependencies.credentialAuthenticator, "credentials:issue"),
        async (request, response) => {
          disableCaching(response);
          const principal = response.locals.fusePrincipal as AdministrativePrincipal;
          if (principal.organizationId !== request.params.workspaceId) {
            response.status(403).json({ error: { code: "WORKSPACE_SCOPE_MISMATCH" } });
            return;
          }
          try {
            const result = await onboardingService.issueReplacementCredentials!(principal, request.params.workspaceId);
            if (!await auditOrUnavailable(response, {
              eventType: "credentials.replacement_issued",
              scopeId: request.params.workspaceId,
              outcome: "completed",
              metadata: {},
            })) return;
            response.status(200).json(result);
          } catch (error) {
            const code = error instanceof Error ? error.message : "CREDENTIAL_RECOVERY_FAILED";
            const status = code === "WORKSPACE_NOT_FOUND" ? 404
              : code === "WORKSPACE_SCOPE_MISMATCH" ? 403
              : code === "CREDENTIAL_RECOVERY_UNAVAILABLE" ? 503
              : code.endsWith("_INVALID") ? 400
              : 503;
            response.status(status).json({ error: { code } });
          }
        },
      );
    }
    const betaGuard = dependencies.betaOnboardingGuard;
    const authorizeRecoveryInvite = betaGuard?.authorizeRecoveryInvite;
    if (authorizeRecoveryInvite && onboardingService.issueReplacementCredentialsFromBetaRecovery) {
      app.post("/api/v1/product/workspace-recovery", async (request, response) => {
        disableCaching(response);
        const idempotencyKey = request.header("Idempotency-Key")?.trim();
        const inviteToken = request.header("X-Fuse-Invite")?.trim();
        if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
          response.status(400).json({ error: { code: "IDEMPOTENCY_KEY_INVALID" } });
          return;
        }
        if (!inviteToken) {
          response.status(403).json({ error: { code: "BETA_INVITE_REQUIRED" } });
          return;
        }
        const authorized = await authorizeRecoveryInvite(inviteToken, idempotencyKey);
        if (!authorized) {
          response.status(403).json({ error: { code: "BETA_INVITE_INVALID" } });
          return;
        }
        try {
          const result = await onboardingService.issueReplacementCredentialsFromBetaRecovery!();
          if (!await auditOrUnavailable(response, {
            eventType: "credentials.beta_recovery_issued",
            scopeId: result.workspaceId,
            outcome: "completed",
            metadata: {},
          })) return;
          response.status(200).json(result);
        } catch (error) {
          const code = error instanceof Error ? error.message : "CREDENTIAL_RECOVERY_FAILED";
          const status = code === "WORKSPACE_NOT_FOUND" ? 404
            : code === "WORKSPACE_RECOVERY_AMBIGUOUS" ? 409
            : code === "CREDENTIAL_RECOVERY_UNAVAILABLE" ? 503
            : 503;
          response.status(status).json({ error: { code } });
        }
      });
    }
  }

  if (dependencies.credentialAuthenticator) {
    if (dependencies.humanSessionStore) {
      const sessionRateLimit = dependencies.sessionRateLimit ?? dependencies.adminRateLimit;
      if (sessionRateLimit && (!Number.isSafeInteger(sessionRateLimit.maxPerMinute) || sessionRateLimit.maxPerMinute < 1)) {
        throw new Error("SESSION_RATE_LIMIT_INVALID");
      }
      let sessionRateWindows = new Map<string, { startedAt: number; count: number }>();
      let sessionRateGenerationStartedAt = 0;
      const enforceSessionRateLimit: RequestHandler = async (request, response, next) => {
        const now = sessionRateLimit?.now?.() ?? Date.now();
        const principal = response.locals.fusePrincipal as { organizationId: string; principalType: string; principalId: string };
        const key = `${principal.organizationId}:${principal.principalType}:${principal.principalId}`;
        if (sessionRateLimit?.consume) {
          const decision = await sessionRateLimit.consume(key, sessionRateLimit.maxPerMinute, now);
          if (!await auditOrUnavailable(response, {
            eventType: "rate_limit.decided", scopeId: `session:${key}`,
            outcome: decision.allowed ? "allowed" : "denied",
            metadata: { retryAfterSeconds: decision.retryAfterSeconds },
          })) return;
          if (!decision.allowed) {
            disableCaching(response);
            response.set("Retry-After", String(decision.retryAfterSeconds));
            response.status(429).json({ error: { code: "RATE_LIMIT_EXCEEDED" } });
            return;
          }
          next();
          return;
        }
        if (!sessionRateLimit) { next(); return; }
        if (sessionRateGenerationStartedAt === 0 || now - sessionRateGenerationStartedAt >= 60_000) {
          sessionRateGenerationStartedAt = now;
          sessionRateWindows = new Map();
        }
        const window = sessionRateWindows.get(key) ?? { startedAt: now, count: 0 };
        window.count += 1;
        sessionRateWindows.set(key, window);
        if (window.count > sessionRateLimit.maxPerMinute) {
          disableCaching(response);
          response.set("Retry-After", String(Math.max(1, Math.ceil((window.startedAt + 60_000 - now) / 1_000))));
          response.status(429).json({ error: { code: "RATE_LIMIT_EXCEEDED" } });
          return;
        }
        next();
      };
      app.post("/api/v1/session", createAuthenticationGuard(dependencies.credentialAuthenticator), enforceSessionRateLimit, async (request, response) => {
        disableCaching(response);
        const principal = response.locals.fusePrincipal as {
          organizationId: string;
          principalId: string;
          credentialId: string;
          principalType: "agent" | "service_account";
          role?: "admin" | "operator" | "viewer";
        };
        if (principal.principalType !== "service_account" || principal.credentialId.startsWith("hs_")) {
          response.status(403).json({ error: { code: "SERVICE_ACCOUNT_SESSION_ISSUER_REQUIRED" } });
          return;
        }
        const parsed = z.object({
          expiresAt: z.string().datetime({ offset: true }),
        }).safeParse(request.body);
        if (!parsed.success) {
          response.status(400).json({ error: { code: "INVALID_SESSION_REQUEST" } });
          return;
        }
        const role = principal.role === "admin" ? "owner"
          : principal.role === "operator" ? "member" : "viewer";
        const createdAt = new Date().toISOString();
        if (Date.parse(parsed.data.expiresAt) - Date.parse(createdAt) > MAX_HUMAN_SESSION_MS) {
          response.status(400).json({ error: { code: "SESSION_EXPIRY_TOO_LONG" } });
          return;
        }
        try {
          const session = createHumanSession({
            workspaceId: principal.organizationId,
            userId: principal.principalId,
            sourceCredentialId: principal.credentialId,
            sourceCredentialType: principal.principalType,
            role,
            createdAt,
            expiresAt: parsed.data.expiresAt,
          });
          await dependencies.humanSessionStore!.put(session.record);
          response.status(201).json({
            token: session.token,
            sessionId: session.record.id,
            workspaceId: session.record.workspaceId,
            expiresAt: session.record.expiresAt,
          });
        } catch {
          response.status(503).json({ error: { code: "SESSION_UNAVAILABLE" } });
        }
      });
      app.delete("/api/v1/session", async (request, response) => {
        disableCaching(response);
        const authorization = request.header("Authorization");
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
        if (!token.startsWith("fuse_hs_")) {
          response.status(401).json({ error: { code: "HUMAN_SESSION_REQUIRED" } });
          return;
        }
        const revokedAt = new Date().toISOString();
        try {
          if (!await dependencies.humanSessionStore!.resolve(token, revokedAt)) {
            response.status(401).json({ error: { code: "INVALID_CREDENTIAL" } });
            return;
          }
          await dependencies.humanSessionStore!.revoke(token, revokedAt);
          response.status(204).send();
        } catch {
          response.status(503).json({ error: { code: "SESSION_UNAVAILABLE" } });
        }
      });
      app.delete(
        "/api/v1/admin/sessions/:sessionId",
        createCapabilityGuard(dependencies.credentialAuthenticator, "policies:read"),
        async (request, response) => {
          disableCaching(response);
          const principal = response.locals.fusePrincipal as { organizationId: string; role?: string };
          if (principal.role !== "admin") {
            response.status(403).json({ error: { code: "ADMIN_CAPABILITY_REQUIRED" } });
            return;
          }
          const sessionId = typeof request.params.sessionId === "string" ? request.params.sessionId.trim() : "";
          if (!sessionId) {
            response.status(400).json({ error: { code: "SESSION_ID_REQUIRED" } });
            return;
          }
          try {
            if (!dependencies.humanSessionStore!.revokeById) {
              response.status(503).json({ error: { code: "SESSION_REVOCATION_UNAVAILABLE" } });
              return;
            }
            const revoked = await dependencies.humanSessionStore!.revokeById(sessionId, principal.organizationId, new Date().toISOString());
            if (!revoked) {
              response.status(404).json({ error: { code: "SESSION_NOT_FOUND" } });
              return;
            }
            response.status(204).send();
          } catch {
            response.status(503).json({ error: { code: "SESSION_UNAVAILABLE" } });
          }
        },
      );
    }
    let adminRateWindows = new Map<string, { startedAt: number; count: number }>();
    let adminRateGenerationStartedAt = 0;
    app.use(
      "/api/v1/admin",
      createAuthenticationGuard(dependencies.credentialAuthenticator),
      async (_request, response, next) => {
        const now = adminRateLimit.now?.() ?? Date.now();
        const principal = response.locals.fusePrincipal;
        const key = `${principal.organizationId}:${principal.principalType}:${principal.principalId}`;
        if (adminRateLimit.consume) {
          const decision = await adminRateLimit.consume(key, adminRateLimit.maxPerMinute, now);
          if (!await auditOrUnavailable(response, {
            eventType: "rate_limit.decided", scopeId: `admin:${key}`,
            outcome: decision.allowed ? "allowed" : "denied",
            metadata: { retryAfterSeconds: decision.retryAfterSeconds },
          })) return;
          if (!decision.allowed) {
            disableCaching(response);
            response.set("Retry-After", String(decision.retryAfterSeconds));
            response.status(429).json({ error: { code: "RATE_LIMIT_EXCEEDED" } });
            return;
          }
          next();
          return;
        }
        if (adminRateGenerationStartedAt === 0 || now - adminRateGenerationStartedAt >= 60_000) {
          adminRateGenerationStartedAt = now;
          adminRateWindows = new Map();
        }
        const window = adminRateWindows.get(key) ?? { startedAt: now, count: 0 };
        window.count += 1;
        adminRateWindows.set(key, window);
        if (window.count > adminRateLimit.maxPerMinute) {
          disableCaching(response);
          response.set("Retry-After", String(Math.max(1, Math.ceil((window.startedAt + 60_000 - now) / 1_000))));
          response.status(429).json({ error: { code: "RATE_LIMIT_EXCEEDED" } });
          return;
        }
        next();
      },
    );

    const productRateLimit = dependencies.productRateLimit ?? adminRateLimit;
    if (!Number.isSafeInteger(productRateLimit.maxPerMinute) || productRateLimit.maxPerMinute < 1) {
      throw new Error("PRODUCT_RATE_LIMIT_INVALID");
    }
    let productRateWindows = new Map<string, { startedAt: number; count: number }>();
    let productRateGenerationStartedAt = 0;
    app.use(
      "/api/v1/product",
      createAuthenticationGuard(dependencies.credentialAuthenticator),
      async (request, response, next) => {
        const now = productRateLimit.now?.() ?? Date.now();
        const principal = response.locals.fusePrincipal;
        const key = `${principal.organizationId}:${principal.principalType}:${principal.principalId}`;
        if (productRateLimit.consume) {
          const decision = await productRateLimit.consume(key, productRateLimit.maxPerMinute, now);
          if (!await auditOrUnavailable(response, {
            eventType: "rate_limit.decided", scopeId: `product:${key}`,
            outcome: decision.allowed ? "allowed" : "denied",
            metadata: { retryAfterSeconds: decision.retryAfterSeconds },
          })) return;
          if (!decision.allowed) {
            disableCaching(response);
            response.set("Retry-After", String(decision.retryAfterSeconds));
            response.status(429).json({ error: { code: "RATE_LIMIT_EXCEEDED" } });
            return;
          }
          next();
          return;
        }
        if (productRateGenerationStartedAt === 0 || now - productRateGenerationStartedAt >= 60_000) {
          productRateGenerationStartedAt = now;
          productRateWindows = new Map();
        }
        const window = productRateWindows.get(key) ?? { startedAt: now, count: 0 };
        window.count += 1;
        productRateWindows.set(key, window);
        if (window.count > productRateLimit.maxPerMinute) {
          disableCaching(response);
          response.set("Retry-After", String(Math.max(1, Math.ceil((window.startedAt + 60_000 - now) / 1_000))));
          response.status(429).json({ error: { code: "RATE_LIMIT_EXCEEDED" } });
          return;
        }
        next();
      },
    );
  }

  app.get("/", (_request, response) => {
    response.type("html").send(renderLandingPage());
  });

  app.get("/health", (_request, response) => {
    disableCaching(response);
    response.json({ ok: true, service: "fuse" });
  });

  app.get("/ready", async (_request, response) => {
    disableCaching(response);
    if (!dependencies.readiness) {
      response.status(503).json({
        ok: false, service: "fuse", error: "READINESS_NOT_CONFIGURED",
      });
      return;
    }
    try {
      const checks = await dependencies.readiness();
      const ready = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);
      response.status(ready ? 200 : 503).json({ ok: ready, service: "fuse", checks });
    } catch {
      response.status(503).json({ ok: false, service: "fuse", error: "DEPENDENCY_UNAVAILABLE" });
    }
  });

  app.get("/desk", (_request, response) => {
    response.type("html").send(renderControlDesk());
  });

  app.get("/console", (_request, response) => {
    response.type("html").send(renderOperatorConsole());
  });

  if (dependencies.credentialAuthenticator) {
    if (dependencies.operationalReadiness) {
      app.get(
        "/api/v1/admin/readiness",
        createCapabilityGuard(dependencies.credentialAuthenticator, "policies:read"),
        async (_request, response) => {
          disableCaching(response);
          try {
            response.json(await dependencies.operationalReadiness!());
          } catch {
            response.status(503).json({ error: { code: "OPERATIONAL_READINESS_UNAVAILABLE" } });
          }
        },
      );
    }
    app.get(
      "/api/v1/identity",
      createCapabilityGuard(dependencies.credentialAuthenticator, "mandates:read"),
      (_request, response) => {
        disableCaching(response);
        response.json(response.locals.fusePrincipal);
      },
    );
    app.get(
      "/api/v1/product/readiness",
      createCapabilityGuard(dependencies.credentialAuthenticator, "mandates:read"),
      async (_request, response) => {
        disableCaching(response);
        try {
          const principal = response.locals.fusePrincipal as { organizationId: string };
          const input = dependencies.productReadiness
            ? await dependencies.productReadiness(principal)
            : {
                paymentMode: dependencies.paymentMode ?? "control",
                database: false,
                providerConfiguration: false,
                policyConfiguration: false,
                agentCredential: false,
                mandate: false,
                signerConfiguration: false,
                walletChain: false,
                gatewayEnvironment: false,
                sandbox: true,
              };
          response.json(buildProductReadiness(principal, input));
        } catch {
          response.status(503).json({ error: { code: "READINESS_UNAVAILABLE" } });
        }
      },
    );
  }

  if (dependencies.credentialAuthenticator && dependencies.agentIdentityService) {
    app.post("/api/v1/product/agents", createCapabilityGuard(dependencies.credentialAuthenticator, "agents:write"), async (request, response) => {
      disableCaching(response);
      const requestId = request.header("X-Request-Id")?.trim();
      const parsed = agentRegistrationSchema.safeParse(request.body);
      if (!requestId) { response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } }); return; }
      if (!parsed.success) { response.status(400).json({ error: { code: "INVALID_AGENT_REQUEST" } }); return; }
      try {
        await dependencies.agentIdentityService!.registerAgent(response.locals.fusePrincipal, { ...parsed.data, requestId } as ProductRegisterAgentInput);
        response.status(201).json({ agentId: parsed.data.agentId });
      } catch (error) { handleIdentityError(error, response); }
    });
    app.post("/api/v1/product/agent-credentials", createCapabilityGuard(dependencies.credentialAuthenticator, "credentials:issue"), async (request, response) => {
      disableCaching(response);
      const requestId = request.header("X-Request-Id")?.trim();
      const parsed = agentCredentialIssueSchema.safeParse(request.body);
      if (!requestId) { response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } }); return; }
      if (!parsed.success) { response.status(400).json({ error: { code: "INVALID_AGENT_CREDENTIAL_REQUEST" } }); return; }
      try {
        const issued = await dependencies.agentIdentityService!.issueCredential(response.locals.fusePrincipal, { ...parsed.data, requestId } as ProductIssueCredentialInput);
        response.status(201).json(issued);
      } catch (error) { handleIdentityError(error, response); }
    });
  }

  if (dependencies.credentialAuthenticator && dependencies.credentialAdministration) {
    app.post(
      "/api/v1/admin/agents",
      createCapabilityGuard(dependencies.credentialAuthenticator, "agents:write"),
      async (request, response) => {
        disableCaching(response);
        const requestId = request.header("X-Request-Id")?.trim();
        if (!requestId) {
          response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
          return;
        }
        const parsed = agentRegistrationSchema.safeParse(request.body);
        if (!parsed.success) {
          response.status(400).json({ error: { code: "INVALID_AGENT_REQUEST" } });
          return;
        }
        try {
          await dependencies.credentialAdministration!.registerAgent(
            response.locals.fusePrincipal,
            { ...parsed.data, requestId },
          );
          response.status(201).json({ agentId: parsed.data.agentId });
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          const databaseCode = typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code ?? "") : "";
          if (["SERVICE_ACCOUNT_REQUIRED", "SERVICE_ACCOUNT_ADMIN_REQUIRED", "ADMIN_CAPABILITY_REQUIRED"]
            .includes(message)) {
            response.status(403).json({ error: { code: message } });
          } else if (databaseCode === "23505") {
            response.status(409).json({ error: { code: "AGENT_ID_CONFLICT" } });
          } else if (databaseCode === "23503") {
            response.status(404).json({ error: { code: "ORGANIZATION_NOT_FOUND" } });
          } else if (message.endsWith("_REQUIRED") || message.endsWith("_INVALID")) {
            response.status(400).json({ error: { code: message } });
          } else {
            response.status(503).json({ error: { code: "IDENTITY_ADMINISTRATION_UNAVAILABLE" } });
          }
        }
      },
    );

    app.post(
      "/api/v1/admin/agent-credentials",
      createCapabilityGuard(dependencies.credentialAuthenticator, "credentials:issue"),
      async (request, response) => {
        disableCaching(response);
        const requestId = request.header("X-Request-Id")?.trim();
        if (!requestId) {
          response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
          return;
        }
        const parsed = agentCredentialIssueSchema.safeParse(request.body);
        if (!parsed.success) {
          response.status(400).json({ error: { code: "INVALID_CREDENTIAL_REQUEST" } });
          return;
        }
        try {
          const issued = await dependencies.credentialAdministration!.issueAgentCredential(
            response.locals.fusePrincipal,
            { ...parsed.data, requestId },
          );
          response.status(201).json(issued);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          const databaseCode = typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code ?? "") : "";
          if (message === "SERVICE_ACCOUNT_REQUIRED" || message === "SERVICE_ACCOUNT_ADMIN_REQUIRED" || message === "ADMIN_CAPABILITY_REQUIRED") {
            response.status(403).json({ error: { code: message } });
          } else if (databaseCode === "23505") {
            response.status(409).json({ error: { code: "CREDENTIAL_ID_CONFLICT" } });
          } else if (databaseCode === "23503") {
            response.status(404).json({ error: { code: "AGENT_NOT_FOUND" } });
          } else if (message.endsWith("_REQUIRED") || message.endsWith("_INVALID")) {
            response.status(400).json({ error: { code: message } });
          } else {
            response.status(503).json({ error: { code: "IDENTITY_ADMINISTRATION_UNAVAILABLE" } });
          }
        }
      },
    );

    app.post(
      "/api/v1/admin/agent-credentials/:credentialId/revoke",
      createCapabilityGuard(dependencies.credentialAuthenticator, "credentials:revoke"),
      async (request, response) => {
        disableCaching(response);
        const requestId = request.header("X-Request-Id")?.trim();
        if (!requestId) {
          response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
          return;
        }
        try {
          const credentialIdParam = request.params["credentialId"];
          const credentialId = typeof credentialIdParam === "string"
            ? credentialIdParam
            : credentialIdParam?.[0] ?? "";
          await dependencies.credentialAdministration!.revokeAgentCredential(
            response.locals.fusePrincipal,
            credentialId,
            requestId,
          );
          response.status(204).send();
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message === "SERVICE_ACCOUNT_REQUIRED" || message === "SERVICE_ACCOUNT_ADMIN_REQUIRED" || message === "ADMIN_CAPABILITY_REQUIRED") {
            response.status(403).json({ error: { code: message } });
          } else if (message === "API_CREDENTIAL_NOT_ACTIVE") {
            response.status(404).json({ error: { code: "CREDENTIAL_NOT_ACTIVE" } });
          } else if (message.endsWith("_REQUIRED") || message.endsWith("_INVALID")) {
            response.status(400).json({ error: { code: message } });
          } else {
            response.status(503).json({ error: { code: "IDENTITY_ADMINISTRATION_UNAVAILABLE" } });
          }
        }
      },
    );
    app.post(
      "/api/v1/admin/service-account-credentials",
      createCapabilityGuard(dependencies.credentialAuthenticator, "credentials:issue"),
      async (request, response) => {
        disableCaching(response);
        const requestId = request.header("X-Request-Id")?.trim();
        if (!requestId) {
          response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
          return;
        }
        const parsed = serviceCredentialIssueSchema.safeParse(request.body);
        if (!parsed.success) {
          response.status(400).json({ error: { code: "INVALID_CREDENTIAL_REQUEST" } });
          return;
        }
        try {
          const issued = await dependencies.credentialAdministration!.issueServiceAccountCredential(
            response.locals.fusePrincipal,
            { ...parsed.data, requestId },
          );
          response.status(201).json(issued);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          const databaseCode = typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code ?? "") : "";
          if (["SERVICE_ACCOUNT_REQUIRED", "SERVICE_ACCOUNT_ADMIN_REQUIRED", "ADMIN_CAPABILITY_REQUIRED"]
            .includes(message)) {
            response.status(403).json({ error: { code: message } });
          } else if (databaseCode === "23505") {
            response.status(409).json({ error: { code: "CREDENTIAL_ID_CONFLICT" } });
          } else if (message === "SERVICE_ACCOUNT_NOT_ACTIVE") {
            response.status(404).json({ error: { code: message } });
          } else if (message.endsWith("_REQUIRED") || message.endsWith("_INVALID")
            || message === "SERVICE_CREDENTIAL_CAPABILITY_FOR_ROLE") {
            response.status(400).json({ error: { code: message } });
          } else {
            response.status(503).json({ error: { code: "IDENTITY_ADMINISTRATION_UNAVAILABLE" } });
          }
        }
      },
    );

    app.post(
      "/api/v1/admin/service-account-credentials/:credentialId/revoke",
      createCapabilityGuard(dependencies.credentialAuthenticator, "credentials:revoke"),
      async (request, response) => {
        disableCaching(response);
        const requestId = request.header("X-Request-Id")?.trim();
        if (!requestId) {
          response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
          return;
        }
        const credentialIdParam = request.params["credentialId"];
        const credentialId = typeof credentialIdParam === "string"
          ? credentialIdParam
          : credentialIdParam?.[0] ?? "";
        try {
          await dependencies.credentialAdministration!.revokeServiceAccountCredential(
            response.locals.fusePrincipal,
            credentialId,
            requestId,
          );
          response.status(204).send();
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (["SERVICE_ACCOUNT_REQUIRED", "SERVICE_ACCOUNT_ADMIN_REQUIRED", "ADMIN_CAPABILITY_REQUIRED"]
            .includes(message)) {
            response.status(403).json({ error: { code: message } });
          } else if (message === "SERVICE_CREDENTIAL_NOT_ACTIVE") {
            response.status(404).json({ error: { code: "CREDENTIAL_NOT_ACTIVE" } });
          } else if (message.endsWith("_REQUIRED") || message.endsWith("_INVALID")) {
            response.status(400).json({ error: { code: message } });
          } else {
            response.status(503).json({ error: { code: "IDENTITY_ADMINISTRATION_UNAVAILABLE" } });
          }
        }
      },
    );
  }

  if (dependencies.credentialAuthenticator && dependencies.providerAdministration) {
    app.post(
      "/api/v1/admin/providers",
      createCapabilityGuard(dependencies.credentialAuthenticator, "providers:write"),
      async (request, response) => {
        disableCaching(response);
        const requestId = request.header("X-Request-Id")?.trim();
        if (!requestId) {
          response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
          return;
        }
        const parsed = providerConfigurationSchema.safeParse(request.body);
        if (!parsed.success) {
          response.status(400).json({ error: { code: "INVALID_PROVIDER_CONFIGURATION" } });
          return;
        }
        try {
          const provider = await dependencies.providerAdministration!.configure(
            response.locals.fusePrincipal,
            { ...parsed.data, requestId },
          );
          response.status(201).json({ provider });
        } catch (error) {
          handleProviderError(error, response);
        }
      },
    );
    if (dependencies.providerAdministration.retry) {
      app.post(
        "/api/v1/admin/providers/:configId/retry",
        createCapabilityGuard(dependencies.credentialAuthenticator, "providers:write"),
        async (request, response) => {
          disableCaching(response);
          const requestId = request.header("X-Request-Id")?.trim();
          const configIdParam = request.params["configId"];
          const configId = typeof configIdParam === "string" ? configIdParam : "";
          if (!requestId) {
            response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
            return;
          }
          try {
            const provider = await dependencies.providerAdministration!.retry!(
              response.locals.fusePrincipal, configId, requestId,
            );
            response.status(200).json({ provider });
          } catch (error) {
            handleProviderError(error, response);
          }
        },
      );
    }
    app.get(
      "/api/v1/admin/providers",
      createCapabilityGuard(dependencies.credentialAuthenticator, "providers:read"),
      async (_request, response) => {
        disableCaching(response);
        try {
          const providers = await dependencies.providerAdministration!.list(
            response.locals.fusePrincipal,
          );
          response.json({ providers });
        } catch (error) {
          handleProviderError(error, response);
        }
      },
    );
  }

  if (dependencies.credentialAuthenticator && dependencies.providerConnectionService) {
    app.post(
      "/api/v1/product/provider-connections",
      createCapabilityGuard(dependencies.credentialAuthenticator, "providers:write"),
      async (request, response) => {
        disableCaching(response);
        const requestId = request.header("X-Request-Id")?.trim();
        if (!requestId) {
          response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
          return;
        }
        const parsed = providerConfigurationSchema.safeParse(request.body);
        if (!parsed.success) {
          response.status(400).json({ error: { code: "INVALID_PROVIDER_CONFIGURATION" } });
          return;
        }
        try {
          const provider = await dependencies.providerConnectionService!.connect(
            response.locals.fusePrincipal,
            { ...parsed.data, requestId },
          );
          response.status(201).json({ provider });
        } catch (error) {
          handleProviderError(error, response);
        }
      },
    );
    app.get(
      "/api/v1/product/provider-connections",
      createCapabilityGuard(dependencies.credentialAuthenticator, "providers:read"),
      async (_request, response) => {
        disableCaching(response);
        try {
          const providers = await dependencies.providerConnectionService!.list(
            response.locals.fusePrincipal,
          );
          response.json({ providers });
        } catch (error) {
          handleProviderError(error, response);
        }
      },
    );
  }

  if (dependencies.credentialAuthenticator && dependencies.policyPublishingService) {
    app.post("/api/v1/product/policies", createCapabilityGuard(dependencies.credentialAuthenticator, "policies:write"), async (request, response) => {
      disableCaching(response);
      const requestId = request.header("X-Request-Id")?.trim();
      const parsed = policyPublishSchema.safeParse(request.body);
      if (!requestId) { response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } }); return; }
      if (!parsed.success) { response.status(400).json({ error: { code: "INVALID_POLICY_REQUEST" } }); return; }
      if ((parsed.data.workloadClasses?.length ?? 0) > 0 && !dependencies.workloadShadowEnabled) {
        response.status(409).json({ error: { code: "WORKLOAD_SHADOW_ROLLOUT_DISABLED" } }); return;
      }
      try {
        await dependencies.policyPublishingService!.publish(response.locals.fusePrincipal, parsed.data as unknown as ProductPolicyInput);
        response.status(201).json({ policyId: parsed.data.policyId, version: parsed.data.version });
      } catch (error) { handlePolicyError(error, response); }
    });
  }

  if (dependencies.credentialAuthenticator && dependencies.mandateManagementService) {
    const mandateProductGuard = createCapabilityGuard(
      dependencies.credentialAuthenticator,
      "mandates:admin",
    );
    app.post("/api/v1/product/mandates", mandateProductGuard, async (request, response) => {
      disableCaching(response);
      const requestId = request.header("X-Request-Id")?.trim();
      const parsed = mandateCreateSchema.safeParse(request.body);
      if (!requestId) { response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } }); return; }
      if (!parsed.success) { response.status(400).json({ error: { code: "INVALID_MANDATE_REQUEST" } }); return; }
      try {
        await dependencies.mandateManagementService!.createMandate(response.locals.fusePrincipal, {
          ...parsed.data, maximumSpendAtomic: parsed.data.maximumSpendAtomic, requestId,
        } as ProductMandateInput);
        response.status(201).json({ mandateId: parsed.data.mandateId });
      } catch (error) { handlePolicyError(error, response); }
    });
    app.post("/api/v1/product/mandates/:mandateId/agents", mandateProductGuard, async (request, response) => {
      disableCaching(response);
      const requestId = request.header("X-Request-Id")?.trim();
      const mandateId = typeof request.params["mandateId"] === "string" ? request.params["mandateId"] : "";
      const parsed = mandateAssignmentSchema.safeParse(request.body);
      if (!requestId) { response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } }); return; }
      if (!mandateId || !parsed.success) { response.status(400).json({ error: { code: "INVALID_MANDATE_ASSIGNMENT" } }); return; }
      try {
        await dependencies.mandateManagementService!.assignAgent(response.locals.fusePrincipal, {
          mandateId, agentId: parsed.data.agentId, requestId,
        });
        response.status(204).send();
      } catch (error) { handlePolicyError(error, response); }
    });
    app.post("/api/v1/product/mandates/:mandateId/branches", mandateProductGuard, async (request, response) => {
      disableCaching(response);
      const requestId = request.header("X-Request-Id")?.trim();
      const mandateId = typeof request.params["mandateId"] === "string" ? request.params["mandateId"] : "";
      const parsed = mandateBranchSchema.safeParse(request.body);
      if (!requestId) { response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } }); return; }
      if (!mandateId || !parsed.success) { response.status(400).json({ error: { code: "INVALID_MANDATE_BRANCH" } }); return; }
      if (!dependencies.workloadShadowEnabled) { response.status(409).json({ error: { code: "WORKLOAD_SHADOW_ROLLOUT_DISABLED" } }); return; }
      try {
        const branch = await dependencies.mandateManagementService!.createBranch(response.locals.fusePrincipal, {
          ...parsed.data, mandateId, maximumSpendAtomic: parsed.data.maximumSpendAtomic, requestId,
        } as ProductBranchInput);
        response.status(201).json({ branch: { ...branch, maximumSpendAtomic: branch.maximumSpendAtomic.toString() } });
      } catch (error) { handlePolicyError(error, response); }
    });
    app.post("/api/v1/product/mandates/:mandateId/transitions", mandateProductGuard, async (request, response) => {
      disableCaching(response);
      const requestId = request.header("X-Request-Id")?.trim();
      const mandateId = typeof request.params["mandateId"] === "string" ? request.params["mandateId"] : "";
      const parsed = mandateTransitionSchema.safeParse(request.body);
      if (!requestId) { response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } }); return; }
      if (!mandateId || !parsed.success) { response.status(400).json({ error: { code: "INVALID_MANDATE_TRANSITION" } }); return; }
      try {
        await dependencies.mandateManagementService!.transitionMandate(response.locals.fusePrincipal, {
          mandateId, to: parsed.data.to, requestId,
        });
        response.status(204).send();
      } catch (error) { handlePolicyError(error, response); }
    });
  }

  if (dependencies.credentialAuthenticator && dependencies.policyAdministration) {
    app.post(
      "/api/v1/admin/policies",
      createCapabilityGuard(dependencies.credentialAuthenticator, "policies:write"),
      async (request, response) => {
        disableCaching(response);
        const requestId = request.header("X-Request-Id")?.trim();
        if (!requestId) {
          response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
          return;
        }
        const parsed = policyPublishSchema.safeParse(request.body);
        if (!parsed.success) {
          response.status(400).json({ error: { code: "INVALID_POLICY_REQUEST" } });
          return;
        }
        if ((parsed.data.workloadClasses?.length ?? 0) > 0 && !dependencies.workloadShadowEnabled) {
          response.status(409).json({ error: { code: "WORKLOAD_SHADOW_ROLLOUT_DISABLED" } });
          return;
        }
        try {
          await dependencies.policyAdministration!.publishPolicy(
            response.locals.fusePrincipal,
            {
              policyId: parsed.data.policyId,
              version: parsed.data.version,
              mode: parsed.data.mode,
              allowedProviders: parsed.data.allowedProviders,
              allowedModels: parsed.data.allowedModels,
              requiredCapability: parsed.data.requiredCapability,
              limits: {
                ...parsed.data.limits,
                maxPerCallAtomic: BigInt(parsed.data.limits.maxPerCallAtomic),
                maxHourlyAtomic: BigInt(parsed.data.limits.maxHourlyAtomic),
                maxDailyAtomic: BigInt(parsed.data.limits.maxDailyAtomic),
              },
              ...(parsed.data.workloadClasses ? {
                workloadClasses: parsed.data.workloadClasses.map((workloadClass) => ({
                  id: workloadClass.id,
                  maxCostPerCallAtomic: BigInt(workloadClass.maxCostPerCallAtomic),
                  maxInvocationsPerBranch: workloadClass.maxInvocationsPerBranch,
                  aggregateBudgetAtomic: BigInt(workloadClass.aggregateBudgetAtomic),
                  minimumInputTokens: workloadClass.minimumInputTokens,
                  shadow: workloadClass.shadow ? {
                    classPriorWindowSpendAtomic: BigInt(
                      workloadClass.shadow.classPriorWindowSpendAtomic,
                    ),
                    windowSeconds: workloadClass.shadow.windowSeconds,
                    targetMinimumObservations: workloadClass.shadow.targetMinimumObservations,
                    siblingMinimumForScoring: workloadClass.shadow.siblingMinimumForScoring,
                    siblingMinimumForIntervention:
                      workloadClass.shadow.siblingMinimumForIntervention,
                    confidenceConstant: workloadClass.shadow.confidenceConstant,
                    divergenceThresholdBps: workloadClass.shadow.divergenceThresholdBps,
                  } : null,
                })),
              } : {}),
              requestId,
            },
          );
          response.status(201).json({ policyId: parsed.data.policyId, version: parsed.data.version });
        } catch (error) {
          handlePolicyError(error, response);
        }
      },
    );

    app.post(
      "/api/v1/admin/mandates",
      createCapabilityGuard(dependencies.credentialAuthenticator, "mandates:admin"),
      async (request, response) => {
        disableCaching(response);
        const requestId = request.header("X-Request-Id")?.trim();
        if (!requestId) {
          response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
          return;
        }
        const parsed = mandateCreateSchema.safeParse(request.body);
        if (!parsed.success) {
          response.status(400).json({ error: { code: "INVALID_MANDATE_REQUEST" } });
          return;
        }
        try {
          await dependencies.policyAdministration!.createMandate(
            response.locals.fusePrincipal,
            {
              ...parsed.data,
              maximumSpendAtomic: BigInt(parsed.data.maximumSpendAtomic),
              requestId,
            },
          );
          response.status(201).json({ mandateId: parsed.data.mandateId });
        } catch (error) {
          handlePolicyError(error, response);
        }
      },
    );

    app.post(
      "/api/v1/admin/mandates/:mandateId/agents",
      createCapabilityGuard(dependencies.credentialAuthenticator, "mandates:admin"),
      async (request, response) => {
        disableCaching(response);
        const requestId = request.header("X-Request-Id")?.trim();
        if (!requestId) {
          response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
          return;
        }
        const parsed = mandateAssignmentSchema.safeParse(request.body);
        const mandateIdParam = request.params["mandateId"];
        const mandateId = typeof mandateIdParam === "string" ? mandateIdParam : mandateIdParam?.[0] ?? "";
        if (!parsed.success || !mandateId) {
          response.status(400).json({ error: { code: "INVALID_MANDATE_ASSIGNMENT" } });
          return;
        }
        try {
          await dependencies.policyAdministration!.assignAgent(
            response.locals.fusePrincipal,
            { mandateId, agentId: parsed.data.agentId, requestId },
          );
          response.status(204).send();
        } catch (error) {
          handlePolicyError(error, response);
        }
      },
    );

    app.post(
      "/api/v1/admin/mandates/:mandateId/branches",
      createCapabilityGuard(dependencies.credentialAuthenticator, "mandates:admin"),
      async (request, response) => {
        disableCaching(response);
        const requestId = request.header("X-Request-Id")?.trim();
        const mandateIdParam = request.params["mandateId"];
        const mandateId = typeof mandateIdParam === "string" ? mandateIdParam : mandateIdParam?.[0] ?? "";
        const parsed = mandateBranchSchema.safeParse(request.body);
        if (!requestId) {
          response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
          return;
        }
        if (!mandateId || !parsed.success) {
          response.status(400).json({ error: { code: "INVALID_MANDATE_BRANCH" } });
          return;
        }
        if (!dependencies.workloadShadowEnabled) {
          response.status(409).json({ error: { code: "WORKLOAD_SHADOW_ROLLOUT_DISABLED" } });
          return;
        }
        try {
          const branch = await dependencies.policyAdministration!.createBranch(
            response.locals.fusePrincipal,
            {
              mandateId,
              branchId: parsed.data.branchId,
              parentBranchId: parsed.data.parentBranchId,
              agentId: parsed.data.agentId,
              allowedWorkloadClasses: parsed.data.allowedWorkloadClasses,
              maximumSpendAtomic: BigInt(parsed.data.maximumSpendAtomic),
              expiresAt: parsed.data.expiresAt,
              requestId,
            },
          );
          response.status(201).json({
            branch: { ...branch, maximumSpendAtomic: branch.maximumSpendAtomic.toString() },
          });
        } catch (error) {
          handlePolicyError(error, response);
        }
      },
    );

    app.post(
      "/api/v1/admin/mandates/:mandateId/transitions",
      createCapabilityGuard(dependencies.credentialAuthenticator, "mandates:admin"),
      async (request, response) => {
        disableCaching(response);
        const requestId = request.header("X-Request-Id")?.trim();
        if (!requestId) {
          response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
          return;
        }
        const parsed = mandateTransitionSchema.safeParse(request.body);
        const mandateIdParam = request.params["mandateId"];
        const mandateId = typeof mandateIdParam === "string" ? mandateIdParam : mandateIdParam?.[0] ?? "";
        if (!parsed.success || !mandateId) {
          response.status(400).json({ error: { code: "INVALID_MANDATE_TRANSITION" } });
          return;
        }
        try {
          await dependencies.policyAdministration!.transitionMandate(
            response.locals.fusePrincipal,
            { mandateId, to: parsed.data.to, requestId },
          );
          response.status(204).send();
        } catch (error) {
          handlePolicyError(error, response);
        }
      },
    );
    app.post(
      "/api/v1/admin/mandates/:mandateId/policy",
      createCapabilityGuard(dependencies.credentialAuthenticator, "mandates:admin"),
      async (request, response) => {
        disableCaching(response);
        const requestId = request.header("X-Request-Id")?.trim();
        if (!requestId) {
          response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
          return;
        }
        const parsed = mandatePolicySchema.safeParse(request.body);
        const mandateIdParam = request.params["mandateId"];
        const mandateId = typeof mandateIdParam === "string" ? mandateIdParam : mandateIdParam?.[0] ?? "";
        if (!parsed.success || !mandateId) {
          response.status(400).json({ error: { code: "INVALID_MANDATE_POLICY" } });
          return;
        }
        try {
          await dependencies.policyAdministration!.setMandatePolicy(
            response.locals.fusePrincipal,
            { mandateId, ...parsed.data, requestId },
          );
          response.status(204).send();
        } catch (error) {
          handlePolicyError(error, response);
        }
      },
    );
    app.get(
      "/api/v1/admin/reconciliation",
      createCapabilityGuard(dependencies.credentialAuthenticator, "policies:read"),
      async (_request, response) => {
        disableCaching(response);
        try {
          const cases = await dependencies.policyAdministration!.listReconciliationCases(
            response.locals.fusePrincipal,
          );
          response.json({
            cases: cases.map((item) => ({
              ...item,
              reservedCostAtomic: item.reservedCostAtomic.toString(),
              reportedCostAtomic: item.reportedCostAtomic?.toString() ?? null,
            })),
          });
        } catch (error) {
          handlePolicyError(error, response);
        }
      },
    );
    app.post(
      "/api/v1/admin/reconciliation/:requestId/resolve",
      createCapabilityGuard(dependencies.credentialAuthenticator, "mandates:admin"),
      async (request, response) => {
        disableCaching(response);
        const causationId = request.header("X-Request-Id")?.trim();
        const executionRequestIdParam = request.params["requestId"];
        const executionRequestId = typeof executionRequestIdParam === "string"
          ? executionRequestIdParam : executionRequestIdParam?.[0] ?? "";
        const parsed = reconciliationResolutionSchema.safeParse(request.body);
        if (!causationId) {
          response.status(400).json({ error: { code: "REQUEST_ID_REQUIRED" } });
          return;
        }
        if (!executionRequestId || !parsed.success) {
          response.status(400).json({ error: { code: "INVALID_RECONCILIATION_RESOLUTION" } });
          return;
        }
        try {
          await dependencies.policyAdministration!.resolveReconciliation(
            response.locals.fusePrincipal,
            {
              executionRequestId,
              resolution: parsed.data.resolution,
              ...(parsed.data.actualCostAtomic === undefined
                ? {} : { actualCostAtomic: BigInt(parsed.data.actualCostAtomic) }),
              note: parsed.data.note,
              externalReference: parsed.data.externalReference,
              requestId: causationId,
            },
          );
          response.status(204).send();
        } catch (error) {
          handlePolicyError(error, response);
        }
      },
    );
    app.get(
      "/api/v1/admin/policies/:policyId/versions/:version",
      createCapabilityGuard(dependencies.credentialAuthenticator, "policies:read"),
      async (request, response) => {
        disableCaching(response);
        const policyIdParam = request.params["policyId"];
        const versionParam = request.params["version"];
        const policyId = typeof policyIdParam === "string" ? policyIdParam : policyIdParam?.[0] ?? "";
        const versionText = typeof versionParam === "string" ? versionParam : versionParam?.[0] ?? "";
        const version = /^\d+$/.test(versionText) ? Number(versionText) : 0;
        if (!policyId || !Number.isSafeInteger(version) || version < 1) {
          response.status(400).json({ error: { code: "INVALID_POLICY_REFERENCE" } });
          return;
        }
        try {
          const policy = await dependencies.policyAdministration!.getPolicy(
            response.locals.fusePrincipal,
            policyId,
            version,
          );
          if (!policy) {
            response.status(404).json({ error: { code: "POLICY_NOT_FOUND" } });
            return;
          }
          response.json({
            ...policy,
            limits: {
              ...policy.limits,
              maxPerCallAtomic: policy.limits.maxPerCallAtomic.toString(),
              maxHourlyAtomic: policy.limits.maxHourlyAtomic.toString(),
              maxDailyAtomic: policy.limits.maxDailyAtomic.toString(),
            },
            ...(policy.workloadClasses ? {
              workloadClasses: policy.workloadClasses.map((workloadClass) => ({
                ...workloadClass,
                maxCostPerCallAtomic: workloadClass.maxCostPerCallAtomic.toString(),
                aggregateBudgetAtomic: workloadClass.aggregateBudgetAtomic.toString(),
                shadow: workloadClass.shadow ? {
                  ...workloadClass.shadow,
                  classPriorWindowSpendAtomic:
                    workloadClass.shadow.classPriorWindowSpendAtomic.toString(),
                } : null,
              })),
            } : {}),
          });
        } catch (error) {
          handlePolicyError(error, response);
        }
      },
    );

    app.get(
      "/api/v1/admin/mandates/:mandateId/decisions",
      createCapabilityGuard(dependencies.credentialAuthenticator, "policies:read"),
      async (request, response) => {
        disableCaching(response);
        const mandateIdParam = request.params["mandateId"];
        const mandateId = typeof mandateIdParam === "string" ? mandateIdParam : mandateIdParam?.[0] ?? "";
        if (!mandateId) {
          response.status(400).json({ error: { code: "INVALID_MANDATE_REFERENCE" } });
          return;
        }
        try {
          const decisions = await dependencies.policyAdministration!.listDecisions(
            response.locals.fusePrincipal,
            mandateId,
          );
          response.json({
            decisions: decisions.map((decision) => ({
              ...decision,
              input: {
                ...decision.input,
                estimatedCostAtomic: decision.input.estimatedCostAtomic.toString(),
                spentHourAtomic: decision.input.spentHourAtomic.toString(),
                spentDayAtomic: decision.input.spentDayAtomic.toString(),
                mandateSpentAtomic: decision.input.mandateSpentAtomic.toString(),
                mandateMaximumAtomic: decision.input.mandateMaximumAtomic.toString(),
                ...(decision.input.workload ? {
                  workload: {
                    ...decision.input.workload,
                    branchMaximumAtomic: decision.input.workload.branchMaximumAtomic.toString(),
                    branchSpentAtomic: decision.input.workload.branchSpentAtomic.toString(),
                    classSpentAtomic: decision.input.workload.classSpentAtomic.toString(),
                  },
                } : {}),
                ...(decision.input.exposure ? {
                  exposure: Object.fromEntries(Object.entries(decision.input.exposure)
                    .map(([key, value]) => [key, value.toString()])),
                } : {}),
              },
            })),
          });
        } catch (error) {
          handlePolicyError(error, response);
        }
      },
    );
    app.get(
      "/api/v1/admin/mandates/:mandateId/shadow-evaluations",
      createCapabilityGuard(dependencies.credentialAuthenticator, "policies:read"),
      async (request, response) => {
        disableCaching(response);
        const mandateIdParam = request.params["mandateId"];
        const mandateId = typeof mandateIdParam === "string" ? mandateIdParam : mandateIdParam?.[0] ?? "";
        if (!mandateId) {
          response.status(400).json({ error: { code: "INVALID_MANDATE_REFERENCE" } });
          return;
        }
        try {
          const evaluations = await dependencies.policyAdministration!.listShadowEvaluations(
            response.locals.fusePrincipal,
            mandateId,
          );
          response.json({
            evaluations: evaluations.map((evaluation) => ({
              ...evaluation,
              cohortOrdinal: evaluation.cohortOrdinal.toString(),
              siblingAggregateAtomic: evaluation.siblingAggregateAtomic.toString(),
              effectiveBaselineAtomic: evaluation.effectiveBaselineAtomic.toString(),
            })),
          });
        } catch (error) {
          handlePolicyError(error, response);
        }
      },
    );
  }

  app.get("/api/state", async (_request, response, next) => {
    try {
      disableCaching(response);
      response.json(await readPublicState());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/runs/:recordId", async (request, response, next) => {
    try {
      disableCaching(response);
      const state = await readPublicState();
      if (request.params.recordId !== state.recordId) {
        response.status(404).json({ error: { code: "RUN_NOT_FOUND" } });
        return;
      }
      response.json({
        recordId: state.recordId,
        persistence: state.persistence,
        state,
        receipts: await stateStore.listReceipts(),
        goldenArcAnchor: {
          mandateId: "0xa12a9146913454b8e14e132a1ee07df1a114cbc01e80e2c1a0bc8bfd58e88c6c",
          totalPaidAtomic: "7302",
          receiptHash: "0x91391b64514c0b4ec350b864dc1f8ad34b51d69180746e818c8420a75f70325c",
          openTxHash: "0xe92bb389d8b05c6121274c2bc7e1edf4a2ecd150afd18dc339eec8aa2aecab9b",
          closeTxHash: "0x03a9f53dc180865a7168cf44f6f0ed2da03fe246aa7f68ddb286abe6cd27d772",
          boundary: "The later Builder cold-start probe is persisted in this record but is not part of the already-closed golden Arc mandate.",
        },
      });
    } catch (error) {
      next(error);
    }
  });

  if (dependencies.credentialAuthenticator && dependencies.sandboxRunStore) {
    app.get("/api/v1/product/sandbox/runs/:runId", createCapabilityGuard(dependencies.credentialAuthenticator, "sandbox:run"), async (request, response) => {
      disableCaching(response);
      const rawRunId = request.params["runId"];
      const runId = (typeof rawRunId === "string" ? rawRunId : "").trim();
      if (!runId || runId.length > 128 || !/^sandbox_[a-f0-9]{24}$/.test(runId)) {
        response.status(400).json({ error: { code: "INVALID_SANDBOX_REFERENCE" } });
        return;
      }
      try {
        const run = await dependencies.sandboxRunStore!.get(response.locals.fusePrincipal.organizationId, runId);
        if (!run) { response.status(404).json({ error: { code: "SANDBOX_RUN_NOT_FOUND" } }); return; }
        response.json(run);
      } catch {
        response.status(503).json({ error: { code: "SANDBOX_UNAVAILABLE" } });
      }
    });
  }

  if (dependencies.credentialAuthenticator && dependencies.sandboxRunService) {
    app.post("/api/v1/product/sandbox/runs", createCapabilityGuard(dependencies.credentialAuthenticator, "sandbox:run"), async (request, response) => {
      disableCaching(response);
      const body = z.object({ seed: z.string().trim().min(1).max(128).optional() }).strict().safeParse(request.body ?? {});
      if (!body.success) { response.status(400).json({ error: { code: "INVALID_SANDBOX_REQUEST" } }); return; }
      try {
        const run = dependencies.sandboxRunStore
          ? await dependencies.sandboxRunService!.runDurable(
            dependencies.sandboxRunStore,
            response.locals.fusePrincipal.organizationId,
            body.data.seed,
          )
          : dependencies.sandboxRunService!.run(response.locals.fusePrincipal.organizationId, body.data.seed);
        response.status(201).json(run);
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (["WORKSPACE_REQUIRED", "INVALID_SANDBOX_REFERENCE"].includes(code)) { response.status(400).json({ error: { code } }); return; }
        response.status(503).json({ error: { code: "SANDBOX_UNAVAILABLE" } });
      }
    });
  }

  if (dependencies.credentialAuthenticator && dependencies.productReceiptService) {
    app.get("/api/v1/product/receipts/:requestId", createCapabilityGuard(dependencies.credentialAuthenticator, "receipts:read"), async (request, response) => {
      disableCaching(response);
      const rawRequestId = request.params["requestId"];
      const requestId = (typeof rawRequestId === "string" ? rawRequestId : "").trim();
      const mandateId = request.header("X-Fuse-Mandate")?.trim() ?? "";
      if (!requestId || requestId.length > 128) { response.status(400).json({ error: { code: "INVALID_RECEIPT_REFERENCE" } }); return; }
      if (!mandateId || mandateId.length > 128) { response.status(400).json({ error: { code: "MISSING_MANDATE" } }); return; }
      try {
        const receipt = await dependencies.productReceiptService!.get(response.locals.fusePrincipal, mandateId, requestId);
        response.json({ receipt });
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code === "RECEIPT_NOT_FOUND") { response.status(404).json({ error: { code } }); return; }
        if (code === "MANDATE_REQUIRED" || code === "REQUEST_ID_REQUIRED") { response.status(400).json({ error: { code } }); return; }
        response.status(503).json({ error: { code: "RECEIPT_QUERY_UNAVAILABLE" } });
      }
    });

    app.get("/api/v1/product/mandates/:mandateId/receipts", createCapabilityGuard(dependencies.credentialAuthenticator, "receipts:read"), async (request, response) => {
      disableCaching(response);
      const rawMandateId = request.params["mandateId"];
      const mandateId = (typeof rawMandateId === "string" ? rawMandateId : "").trim();
      if (!mandateId || mandateId.length > 128) { response.status(400).json({ error: { code: "INVALID_MANDATE_REFERENCE" } }); return; }
      try {
        const rawLimit = request.query.limit;
        const rawCursor = request.query.cursor;
        const limit = rawLimit === undefined ? undefined : Number(rawLimit);
        const cursor = typeof rawCursor === "string" ? rawCursor : undefined;
        const page = await dependencies.productReceiptService!.listPage(response.locals.fusePrincipal, mandateId, { limit, cursor });
        response.json(page);
      } catch (error) {
        if (error instanceof Error && ["MANDATE_REQUIRED", "INVALID_RECEIPT_PAGE_SIZE", "INVALID_RECEIPT_CURSOR"].includes(error.message)) { response.status(400).json({ error: { code: error.message } }); return; }
        response.status(503).json({ error: { code: "RECEIPT_QUERY_UNAVAILABLE" } });
      }
    });
  }

  if (dependencies.productInferenceService && dependencies.credentialAuthenticator) {
    app.post("/api/v1/product/inference", createCapabilityGuard(dependencies.credentialAuthenticator, "inference:invoke"), async (request, response) => {
      disableCaching(response);
      try {
        const principal = response.locals.fusePrincipal;
        const requestId = request.header("Idempotency-Key")?.trim() || request.header("X-Request-Id")?.trim();
        const mandateId = request.header("X-Fuse-Mandate")?.trim();
        if (!requestId) { response.status(400).json({ error: { code: "MISSING_IDEMPOTENCY_KEY" } }); return; }
        if (!mandateId) { response.status(400).json({ error: { code: "MISSING_MANDATE" } }); return; }
        const parsed = completionSchema.safeParse(request.body);
        if (!parsed.success) { response.status(400).json({ error: { code: "INVALID_COMPLETION_REQUEST" } }); return; }
        const branchId = request.header("X-Fuse-Branch")?.trim();
        const workloadClass = parsed.data.workload_class;
        if (Boolean(branchId) !== Boolean(workloadClass)) { response.status(400).json({ error: { code: "INCOMPLETE_WORKLOAD_SCOPE" } }); return; }
        if (branchId && workloadClass && !dependencies.workloadShadowEnabled) { response.status(409).json({ error: { code: "WORKLOAD_SHADOW_ROLLOUT_DISABLED" } }); return; }
        const inputTokens = dependencies.estimateInputTokens(parsed.data.messages as Array<{ role: string; content: string }>);
        const productInferenceService = dependencies.productInferenceService!;
        if (typeof productInferenceService.supportsPreview === "function" && productInferenceService.supportsPreview()) {
          const preview = await productInferenceService.preview(principal, {
            requestId, mandateId, requestedModel: parsed.data.model,
            inputTokens, maxOutputTokens: parsed.data.max_tokens, messages: parsed.data.messages,
            ...(branchId && workloadClass ? { branchId, workloadClass } : {}),
          });
          if (preview.status === "denied") {
            response.status(403).json({ error: { code: "POLICY_DENIED", decisionId: preview.decision.id, reasonCodes: preview.decision.result.reasonCodes } });
            return;
          }
        }
        if (paymentRequired) {
          const paymentAccepted = await requirePayment(
            request,
            response,
            dependencies.paymentGuard!(maximumQuoteUsdc(inputTokens, parsed.data.max_tokens, dependencies.price)),
          );
          if (!paymentAccepted) return;
        }
        const execution = await dependencies.productInferenceService!.execute(principal, {
          requestId, mandateId, requestedModel: parsed.data.model,
          inputTokens,
          maxOutputTokens: parsed.data.max_tokens, messages: parsed.data.messages,
          ...(branchId && workloadClass ? { branchId, workloadClass } : {}),
        });
        if (execution.status === "denied") { response.status(403).json({ error: { code: "POLICY_DENIED", decisionId: execution.decision.id, reasonCodes: execution.decision.result.reasonCodes } }); return; }
        if (execution.status === "in_progress") { response.status(409).json({ error: { code: "REQUEST_IN_PROGRESS" } }); return; }
        if (execution.status === "failed") { response.status(409).json({ error: { code: "REQUEST_REQUIRES_REVIEW" } }); return; }
        if (execution.status !== "completed") { response.status(503).json({ error: { code: "INFERENCE_EXECUTION_UNAVAILABLE" } }); return; }
        const complete = () => response.json({ status: "completed", response: execution.response, decisionId: execution.decision.id,
          reservedCostAtomic: execution.reservedCostAtomic.toString(), actualCostAtomic: execution.actualCostAtomic.toString() });
        const payment = (request as unknown as { payment?: unknown }).payment;
        if (dependencies.paymentEvidenceStore && payment !== undefined) {
          await dependencies.paymentEvidenceStore.record({
            requestId, organizationId: principal.organizationId,
            actualCostAtomic: execution.actualCostAtomic.toString(), payment,
            recordedAt: new Date().toISOString(),
          });
        }
        complete();
      } catch (error) {
        logInferenceFailure("/api/v1/product/inference", request.header("Idempotency-Key")?.trim(), error);
        if (error instanceof Error && error.message === "AGENT_CREDENTIAL_REQUIRED") { response.status(403).json({ error: { code: error.message } }); return; }
        if (error instanceof Error && error.message === "IDEMPOTENCY_CONFLICT") { response.status(409).json({ error: { code: error.message } }); return; }
        const code = publicInferenceError(error);
        response.status(code === "PROVIDER_RATE_LIMITED" ? 429 : code.startsWith("PROVIDER_") ? 502 : 503)
          .json({ error: { code } });
      }
    });
  }

  if (dependencies.inferenceExecution && dependencies.credentialAuthenticator) {
    app.post(
      "/v1/chat/completions",
      createCapabilityGuard(dependencies.credentialAuthenticator, "inference:invoke"),
      async (request, response, next) => {
        try {
          disableCaching(response);
          const principal = response.locals.fusePrincipal;
          if (principal.principalType !== "agent") {
            response.status(403).json({ error: { code: "AGENT_CREDENTIAL_REQUIRED" } });
            return;
          }
          const requestId = request.header("Idempotency-Key")?.trim();
          if (!requestId) {
            response.status(400).json({ error: { code: "MISSING_IDEMPOTENCY_KEY" } });
            return;
          }
          const mandateId = request.header("X-Fuse-Mandate")?.trim();
          if (!mandateId || mandateId.length > 128) {
            response.status(400).json({ error: { code: "MISSING_MANDATE" } });
            return;
          }
          const parsed = completionSchema.safeParse(request.body);
          if (!parsed.success) {
            response.status(400).json({ error: { code: "INVALID_COMPLETION_REQUEST" } });
            return;
          }
          const branchId = request.header("X-Fuse-Branch")?.trim();
          const workloadClass = parsed.data.workload_class;
          if (branchId && branchId.length > 128) {
            response.status(400).json({ error: { code: "INVALID_WORKLOAD_SCOPE" } });
            return;
          }
          if (Boolean(branchId) !== Boolean(workloadClass)) {
            response.status(400).json({ error: { code: "INCOMPLETE_WORKLOAD_SCOPE" } });
            return;
          }
          if (branchId && workloadClass && !dependencies.workloadShadowEnabled) {
            response.status(409).json({ error: { code: "WORKLOAD_SHADOW_ROLLOUT_DISABLED" } });
            return;
          }
          const reliabilityRunId = request.header("X-Fuse-Reliability-Run")?.trim();
          const reliabilityLaneId = request.header("X-Fuse-Reliability-Lane")?.trim();
          const reliabilityBlockText = request.header("X-Fuse-Reliability-Block")?.trim();
          const replayOperationId = request.header("X-Fuse-Replay-Operation")?.trim();
          let reliabilityContext: ReturnType<typeof issueReliabilityProtocolContext> | undefined;
          if (!replayOperationId && dependencies.reliabilityContextIssuer) {
            const block = reliabilityBlockText === undefined ? null : Number(reliabilityBlockText);
            const authorized = await dependencies.reliabilityContextIssuer({
                runId: reliabilityRunId ?? null, laneId: reliabilityLaneId ?? null,
                block: block !== null && Number.isInteger(block) ? block : null, requestId,
                organizationId: principal.organizationId, agentId: principal.principalId, credentialId: principal.credentialId, mandateId,
                branchId: branchId ?? null, workloadClass: workloadClass ?? null,
                model: parsed.data.model, maxOutputTokens: parsed.data.max_tokens, body: parsed.data,
              });
            if (!authorized) {
              const hasCoordinates = Boolean(reliabilityRunId || reliabilityLaneId || reliabilityBlockText);
              response.status(403).json({ error: { code: hasCoordinates
                ? "RELIABILITY_PROTOCOL_CONTEXT_INVALID" : "RELIABILITY_PROTOCOL_CONTEXT_REQUIRED" } });
              return;
            }
            if (authorized.kind !== "ordinary") {
              if (!reliabilityRunId || !reliabilityLaneId || block === null) {
                response.status(403).json({ error: { code: "RELIABILITY_PROTOCOL_CONTEXT_REQUIRED" } });
                return;
              }
              reliabilityContext = issueReliabilityProtocolContext({
                runId: reliabilityRunId, laneId: reliabilityLaneId, block,
                callOrdinal: authorized.callOrdinal,...(authorized.requestCommitment?{requestCommitment:authorized.requestCommitment}:{}),
              });
            }
          } else if (!replayOperationId && (reliabilityRunId || reliabilityLaneId || reliabilityBlockText)) {
            response.status(403).json({ error: { code: "RELIABILITY_PROTOCOL_CONTEXT_INVALID" } });
            return;
          }
          const executionInput: ControlledInferenceInput = {
            requestId,
            organizationId: principal.organizationId,
            credentialId: principal.credentialId,
            mandateId,
            agentId: principal.principalId,
            agentCapabilities: [...principal.capabilities],
            ...(branchId && workloadClass ? { branchId, workloadClass } : {}),
            requestedModel: parsed.data.model,
            inputTokens: dependencies.estimateInputTokens(parsed.data.messages),
            maxOutputTokens: parsed.data.max_tokens,
            messages: parsed.data.messages,
            ...(reliabilityContext ? { reliabilityContext } : {}),
          };
          if (!replayOperationId && paymentRequired) {
            const inferenceExecution = dependencies.inferenceExecution!;
            if (inferenceExecution.preview) {
              const preview = await inferenceExecution.preview(executionInput);
              if (preview.status === "denied") {
                response.status(403).json({ error: { code: "POLICY_DENIED", decisionId: preview.decision.id, reasonCodes: preview.decision.result.reasonCodes } });
                return;
              }
            }
            const paymentAccepted = await requirePayment(
              request,
              response,
              dependencies.paymentGuard!(maximumQuoteUsdc(executionInput.inputTokens, executionInput.maxOutputTokens, dependencies.price)),
            );
            if (!paymentAccepted) return;
          }
          let execution: AdmissionResult;
          if (replayOperationId) {
            if (dependencies.sealedReplayExecution) {
              try {
                const replayResponse = await dependencies.sealedReplayExecution.execute({
                  operationId: replayOperationId,
                  organizationId: principal.organizationId,
                  credentialId: principal.credentialId,
                  agentId: principal.principalId,
                  mandateId,
                  branchId: branchId ?? null,
                  workloadClass: workloadClass ?? null,
                  requestId,
                  body: parsed.data,
                  inputTokens: executionInput.inputTokens,
                  maxOutputTokens: parsed.data.max_tokens,
                  messages: parsed.data.messages,
                });
                response.json(replayResponse);
                return;
              } catch (error) {
                const code = error instanceof Error ? error.message : "";
                if (code === "REPLAY_OPERATION_ID_INVALID") {
                  response.status(403).json({ error: { code: "REPLAY_AUTHORIZATION_INVALID" } });
                  return;
                }
                if (["REPLAY_TARGET_NOT_IMMUTABLE", "REPLAY_TARGET_INELIGIBLE", "REPLAY_TARGET_NOT_SEALED",
                  "REPLAY_REQUEST_PROJECTION_CONFLICT"].includes(code)) {
                  response.status(409).json({ error: { code: "REPLAY_TARGET_NOT_IMMUTABLE" } });
                  return;
                }
                throw error;
              }
            }
            if (!dependencies.replayOperationAuthorizer) {
              response.status(403).json({ error: { code: "REPLAY_AUTHORIZATION_INVALID" } });
              return;
            }
            let replayAuthorization: { authorized: true } | null;
            try {
              replayAuthorization = await dependencies.replayOperationAuthorizer({
                operationId: replayOperationId,
                organizationId: principal.organizationId,
                credentialId: principal.credentialId,
                agentId: principal.principalId,
                mandateId,
                branchId: branchId ?? null,
                workloadClass: workloadClass ?? null,
                idempotencyKey: requestId,
                body: parsed.data,
              });
            } catch {
              response.status(403).json({ error: { code: "REPLAY_AUTHORIZATION_INVALID" } });
              return;
            }
            if (!replayAuthorization?.authorized) {
              response.status(409).json({ error: { code: "REPLAY_TARGET_NOT_IMMUTABLE" } });
              return;
            }
            try {
              execution = await withTrustedReplayOperation(
                replayOperationId,
                () => dependencies.inferenceExecution!.execute(executionInput),
              );
            } catch (error) {
              if (error instanceof Error && error.message === "REPLAY_OPERATION_ID_INVALID") {
                response.status(403).json({ error: { code: "REPLAY_AUTHORIZATION_INVALID" } });
                return;
              }
              throw error;
            }
          } else {
            execution = await dependencies.inferenceExecution!.execute(executionInput);
          }
          if (execution.status === "denied") {
            response.status(403).json({
              error: {
                code: "POLICY_DENIED",
                decisionId: execution.decision.id,
                reasonCodes: execution.decision.result.reasonCodes,
                ...(execution.decision.input?.exposure ? {
                  exposure: Object.fromEntries(Object.entries(execution.decision.input.exposure)
                    .map(([key, value]) => [key, value.toString()])),
                } : {}),
              },
            });
            return;
          }
          if (execution.status === "in_progress") {
            response.status(409).json({ error: { code: "REQUEST_IN_PROGRESS" } });
            return;
          }
          if (execution.status === "failed") {
            response.status(409).json({ error: { code: "REQUEST_REQUIRES_REVIEW" } });
            return;
          }
          if (execution.status !== "completed") {
            response.status(503).json({ error: { code: "INFERENCE_EXECUTION_UNAVAILABLE" } });
            return;
          }
          response.json({
            id: execution.response.id,
            object: "chat.completion",
            model: execution.decision.input.model,
            choices: [{
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: execution.response.content },
            }],
            usage: {
              prompt_tokens: execution.response.usage.inputTokens,
              completion_tokens: execution.response.usage.outputTokens,
              total_tokens: execution.response.usage.inputTokens
                + execution.response.usage.outputTokens,
            },
            fuse: {
              decision: {
                id: execution.decision.id,
                outcome: execution.decision.result.outcome,
                wouldOutcome: execution.decision.result.wouldOutcome,
                enforced: execution.decision.result.enforced,
                reasonCodes: execution.decision.result.reasonCodes,
              },
              reservationAtomic: execution.reservedCostAtomic.toString(),
              actualCostAtomic: execution.actualCostAtomic.toString(),
              ...(execution.decision.input.branchId && execution.decision.input.workloadClass ? {
                workloadScope: {
                  branchId: execution.decision.input.branchId,
                  workloadClass: execution.decision.input.workloadClass,
                },
              } : {}),
              ...(execution.decision.input.exposure ? {
                exposure: Object.fromEntries(Object.entries(execution.decision.input.exposure)
                  .map(([key, value]) => [key, value.toString()])),
              } : {}),
              ...(execution.shadowEvaluation ? {
                shadowEvaluation: {
                  ...execution.shadowEvaluation,
                  cohortOrdinal: execution.shadowEvaluation.cohortOrdinal.toString(),
                  siblingAggregateAtomic:
                    execution.shadowEvaluation.siblingAggregateAtomic.toString(),
                  effectiveBaselineAtomic:
                    execution.shadowEvaluation.effectiveBaselineAtomic.toString(),
                },
              } : {}),
            },
          });
        } catch (error) {
          next(error);
        }
      },
    );
  }

  if (!dependencies.inferenceExecution) app.post("/v1/chat/completions", async (request, response, next) => {
    try {
      const requestId = request.header("Idempotency-Key");
      if (!requestId) {
        response.status(400).json({ error: { code: "MISSING_IDEMPOTENCY_KEY" } });
        return;
      }
      const childId = request.header("X-Fuse-Child");
      if (!childId) {
        response.status(400).json({ error: { code: "MISSING_CHILD_CAPABILITY" } });
        return;
      }
      const parsed = completionSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({
          error: { code: "INVALID_COMPLETION_REQUEST", details: parsed.error.flatten() },
        });
        return;
      }

      const inputTokens = dependencies.estimateInputTokens(parsed.data.messages as Array<{ role: string; content: string }>);
      if (paymentRequired) {
        const paymentAccepted = await requirePayment(
          request,
          response,
          dependencies.paymentGuard!(maximumQuoteUsdc(inputTokens, parsed.data.max_tokens, dependencies.price)),
        );
        if (!paymentAccepted) return;
      }
      const quote = await mutateService((service) => service.prepareCompletion({
        requestId,
        childId,
        model: parsed.data.model,
        inputTokens,
        maxOutputTokens: parsed.data.max_tokens,
        messages: parsed.data.messages,
      }));
      if (quote.status !== "payment_required") throw new Error("PAYMENT_QUOTE_INVALID");
      const gatewayPayment = (request as express.Request & {
        payment?: { transaction?: string; network?: string; payer?: string };
      }).payment;
      const payment = response.locals.fusePayment ?? {
        authorizationHash: gatewayPayment?.transaction ?? "gateway-accepted",
        gatewayStatus: "accepted",
      };
      const completed = await mutateService(async (service) =>
        service.releasePaidCompletion(requestId, payment));
      response.json({
        id: completed.response.id,
        object: "chat.completion",
        model: parsed.data.model,
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: completed.response.content },
        }],
        usage: {
          prompt_tokens: completed.response.usage.inputTokens,
          completion_tokens: completed.response.usage.outputTokens,
          total_tokens: completed.response.usage.inputTokens + completed.response.usage.outputTokens,
        },
        fuse: { receipt: completed.receipt },
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, request: express.Request, response: express.Response, _next: express.NextFunction) => {
    logInferenceFailure("/v1/chat/completions", request.header("Idempotency-Key")?.trim(), error);
    const message = error instanceof Error ? error.message : "";
    const budgetError = message.endsWith("BUDGET_EXCEEDED") || message === "BRANCH_TRIPPED";
    if (budgetError) {
      response.status(409).json({ error: { code: message } });
      return;
    }
    if (message === "IDEMPOTENCY_CONFLICT") {
      response.status(409).json({ error: { code: message } });
      return;
    }
    if (message === "REQUESTED_MODEL_MISMATCH") {
      response.status(409).json({ error: { code: message } });
      return;
    }
    if (["PROVIDER_COST_MISSING", "PROVIDER_MODEL_MISMATCH", "ACTUAL_COST_EXCEEDS_RESERVATION"]
      .includes(message)) {
      response.status(409).json({ error: { code: "REQUEST_REQUIRES_REVIEW" } });
      return;
    }
    if (message === "CONTROL_MANDATE_NOT_FOUND") {
      response.status(404).json({ error: { code: "MANDATE_NOT_FOUND" } });
      return;
    }
    if (/^(OPENROUTER|ANTHROPIC)_/.test(message)) {
      const code = publicInferenceError(error);
      response.status(code === "PROVIDER_RATE_LIMITED" ? 429 : 502).json({ error: { code } });
      return;
    }
    response.status(500).json({ error: { code: "INTERNAL_ERROR" } });
  });

  return app;
}
