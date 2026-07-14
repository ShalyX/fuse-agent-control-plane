import express, { type RequestHandler } from "express";
import { z } from "zod";
import { FuseService, type InferenceProvider } from "../core/service.js";
import { MemoryStateStore, type ServiceStateStore } from "../persistence/store.js";
import { renderControlDesk } from "./desk.js";
import { renderLandingPage } from "./landing.js";
import { createCapabilityGuard, type CredentialAuthenticator } from "./auth.js";
import type { CredentialAdministrationPort } from "../identity/credentialAdministration.js";
import { API_CAPABILITIES } from "../identity/apiCredentials.js";
import type { PolicyAdministrationPort } from "../policy/policyAdministration.js";
import type {
  AdmissionResult,
  ControlledInferenceInput,
} from "../inference/inferenceExecution.js";

const completionSchema = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive().max(32_000),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
  }).strict()).min(1),
});

type PaymentGuardFactory = (priceUsdc: string) => RequestHandler;

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
const policyPublishSchema = z.object({
  policyId: z.string().min(1).max(128),
  version: z.number().int().positive().max(1_000_000),
  mode: z.enum(["dry_run", "enforce", "paused"]),
  allowedProviders: z.array(z.string().min(1).max(128)).min(1).max(100),
  allowedModels: z.array(z.string().min(1).max(256)).min(1).max(1_000),
  requiredCapability: z.enum(API_CAPABILITIES),
  limits: policyLimitsSchema,
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
const mandatePolicySchema = z.object({
  policyId: z.string().min(1).max(128),
  policyVersion: z.number().int().positive().max(1_000_000),
}).strict();
const mandateTransitionSchema = z.object({
  to: z.enum([
    "draft", "active", "paused", "closing", "closed", "exhausted", "tripped",
    "expired", "reconciliation_hold",
  ]),
}).strict();

type AppDependencies = {
  provider: InferenceProvider;
  paymentGuard: PaymentGuardFactory;
  estimateInputTokens: (messages: Array<{ role: string; content: string }>) => number;
  payerWallet?: string;
  price?: { inputUsdPerMillion: string; outputUsdPerMillion: string };
  stateStore?: ServiceStateStore;
  credentialAuthenticator?: CredentialAuthenticator;
  credentialAdministration?: CredentialAdministrationPort;
  policyAdministration?: PolicyAdministrationPort;
  inferenceExecution?: {
    execute(input: ControlledInferenceInput): Promise<AdmissionResult>;
  };
};

function microsToUsdc(micros: bigint): string {
  return `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, "0")}`;
}

export function createFuseApp(dependencies: AppDependencies) {
  const app = express();
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
  const handlePolicyError = (error: unknown, response: express.Response) => {
    const message = error instanceof Error ? error.message : "";
    const databaseCode = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "") : "";
    if ([
      "SERVICE_ACCOUNT_REQUIRED", "SERVICE_ACCOUNT_ADMIN_REQUIRED",
      "POLICY_CAPABILITY_REQUIRED", "MANDATE_CAPABILITY_REQUIRED",
    ].includes(message)) {
      response.status(403).json({ error: { code: message } });
    } else if (databaseCode === "23505") {
      response.status(409).json({ error: { code: "POLICY_RESOURCE_CONFLICT" } });
    } else if (databaseCode === "23503" || message === "CONTROL_MANDATE_NOT_FOUND") {
      response.status(404).json({ error: { code: "POLICY_RESOURCE_NOT_FOUND" } });
    } else if (message.startsWith("CONTROL_MANDATE_TRANSITION_INVALID")
      || message === "CONTROL_MANDATE_POLICY_CHANGE_REQUIRES_PAUSE") {
      response.status(409).json({ error: { code: message === "CONTROL_MANDATE_POLICY_CHANGE_REQUIRES_PAUSE"
        ? message : "MANDATE_TRANSITION_INVALID" } });
    } else if (message.endsWith("_REQUIRED") || message.endsWith("_INVALID")
      || message.endsWith("_DUPLICATE")) {
      response.status(400).json({ error: { code: message } });
    } else {
      response.status(503).json({ error: { code: "POLICY_ADMINISTRATION_UNAVAILABLE" } });
    }
  };
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_request, response) => {
    response.type("html").send(renderLandingPage());
  });

  app.get("/health", (_request, response) => {
    response.json({ ok: true, service: "fuse" });
  });

  app.get("/desk", (_request, response) => {
    response.type("html").send(renderControlDesk());
  });

  if (dependencies.credentialAuthenticator) {
    app.get(
      "/api/v1/identity",
      createCapabilityGuard(dependencies.credentialAuthenticator, "mandates:read"),
      (_request, response) => {
        disableCaching(response);
        response.json(response.locals.fusePrincipal);
      },
    );
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
        try {
          await dependencies.policyAdministration!.publishPolicy(
            response.locals.fusePrincipal,
            {
              ...parsed.data,
              limits: {
                ...parsed.data.limits,
                maxPerCallAtomic: BigInt(parsed.data.limits.maxPerCallAtomic),
                maxHourlyAtomic: BigInt(parsed.data.limits.maxHourlyAtomic),
                maxDailyAtomic: BigInt(parsed.data.limits.maxDailyAtomic),
              },
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
              },
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
          if (!mandateId) {
            response.status(400).json({ error: { code: "MISSING_MANDATE" } });
            return;
          }
          const parsed = completionSchema.safeParse(request.body);
          if (!parsed.success) {
            response.status(400).json({ error: { code: "INVALID_COMPLETION_REQUEST" } });
            return;
          }
          const execution = await dependencies.inferenceExecution!.execute({
            requestId,
            organizationId: principal.organizationId,
            mandateId,
            agentId: principal.principalId,
            agentCapabilities: [...principal.capabilities],
            inputTokens: dependencies.estimateInputTokens(parsed.data.messages),
            maxOutputTokens: parsed.data.max_tokens,
            messages: parsed.data.messages,
          });
          if (execution.status === "denied") {
            response.status(403).json({
              error: {
                code: "POLICY_DENIED",
                decisionId: execution.decision.id,
                reasonCodes: execution.decision.result.reasonCodes,
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

      const quote = await mutateService((service) => service.prepareCompletion({
        requestId,
        childId,
        model: parsed.data.model,
        inputTokens: dependencies.estimateInputTokens(parsed.data.messages),
        maxOutputTokens: parsed.data.max_tokens,
        messages: parsed.data.messages,
      }));
      const priceUsdc = microsToUsdc(quote.exactCostMicros);
      const guard = dependencies.paymentGuard(priceUsdc);

      guard(request, response, async () => {
        try {
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
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
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
      response.status(502).json({ error: { code: "PROVIDER_UNAVAILABLE" } });
      return;
    }
    response.status(500).json({ error: { code: "INTERNAL_ERROR" } });
  });

  return app;
}
