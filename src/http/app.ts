import express, { type RequestHandler } from "express";
import { z } from "zod";
import { FuseService, type InferenceProvider } from "../core/service.js";
import { MemoryStateStore, type ServiceStateStore } from "../persistence/store.js";
import { renderControlDesk } from "./desk.js";
import { renderLandingPage } from "./landing.js";

const completionSchema = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive().max(32_000),
  messages: z.array(z.object({
    role: z.string().min(1),
    content: z.string(),
  })).min(1),
});

type PaymentGuardFactory = (priceUsdc: string) => RequestHandler;

type AppDependencies = {
  provider: InferenceProvider;
  paymentGuard: PaymentGuardFactory;
  estimateInputTokens: (messages: Array<{ role: string; content: string }>) => number;
  payerWallet?: string;
  price?: { inputUsdPerMillion: string; outputUsdPerMillion: string };
  stateStore?: ServiceStateStore;
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

  app.post("/v1/chat/completions", async (request, response, next) => {
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
    const message = error instanceof Error ? error.message : "INTERNAL_ERROR";
    const budgetError = message.endsWith("BUDGET_EXCEEDED") || message === "BRANCH_TRIPPED";
    response.status(budgetError ? 409 : 500).json({ error: { code: message } });
  });

  return app;
}
