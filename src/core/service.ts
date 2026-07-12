import { FuseLedger } from "./ledger.js";
import { calculateCostMicros, calculateMaximumCostMicros, type TokenPrice } from "./pricing.js";

export type CompletionRequest = {
  requestId: string;
  childId: string;
  model: string;
  inputTokens: number;
  maxOutputTokens: number;
  messages: Array<{ role: string; content: string }>;
};

export type ProviderResult = {
  id: string;
  content: string;
  usage: { inputTokens: number; outputTokens: number };
};

export interface InferenceProvider {
  complete(request: CompletionRequest): Promise<ProviderResult>;
}

type Pending = {
  request: CompletionRequest;
  result: ProviderResult;
  exactCostMicros: bigint;
  released?: ReleasedCompletion;
};

type Payment = { authorizationHash: string; gatewayStatus: "accepted" };

type Receipt = {
  requestId: string;
  childId: string;
  payerWallet: string;
  inputTokens: number;
  outputTokens: number;
  costUsdc: string;
  authorizationHash: string;
  gatewayStatus: string;
  settlementStatus: "pending_batch";
};

type ReleasedCompletion = {
  status: "completed";
  httpStatus: 200;
  response: ProviderResult;
  receipt: Receipt;
};

function microsToUsdc(micros: bigint): string {
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

export class FuseService {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly provider: InferenceProvider,
    private readonly ledger: FuseLedger,
    private readonly price: TokenPrice,
    private readonly payerWallet: string,
  ) {}

  static createDemo(provider: InferenceProvider): FuseService {
    return new FuseService(
      provider,
      new FuseLedger({
        mandateId: "demo-mandate",
        maximumSpendMicros: 250_000n,
        children: { scout: 60_000n, builder: 120_000n, reviewer: 50_000n },
      }),
      { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" },
      "0xDemoParentWallet",
    );
  }

  async prepareCompletion(request: CompletionRequest) {
    const cached = this.pending.get(request.requestId);
    if (cached) {
      return {
        status: "payment_required" as const,
        httpStatus: 402 as const,
        exactCostMicros: cached.exactCostMicros,
        paymentRequirements: this.paymentRequirements(request.requestId, cached.exactCostMicros),
      };
    }

    const maximumMicros = calculateMaximumCostMicros(
      { inputTokens: request.inputTokens, maxOutputTokens: request.maxOutputTokens },
      this.price,
    );
    this.ledger.reserve(request.childId, maximumMicros, request.requestId);

    let result: ProviderResult;
    try {
      result = await this.provider.complete(request);
    } catch (error) {
      throw error;
    }

    const exactCostMicros = calculateCostMicros(result.usage, this.price);
    this.pending.set(request.requestId, { request, result, exactCostMicros });
    return {
      status: "payment_required" as const,
      httpStatus: 402 as const,
      exactCostMicros,
      paymentRequirements: this.paymentRequirements(request.requestId, exactCostMicros),
    };
  }

  releasePaidCompletion(requestId: string, payment: Payment): ReleasedCompletion {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error("PENDING_COMPLETION_NOT_FOUND");
    if (pending.released) return pending.released;

    this.ledger.reconcile(requestId, pending.exactCostMicros);
    pending.released = {
      status: "completed",
      httpStatus: 200,
      response: pending.result,
      receipt: {
        requestId,
        childId: pending.request.childId,
        payerWallet: this.payerWallet,
        inputTokens: pending.result.usage.inputTokens,
        outputTokens: pending.result.usage.outputTokens,
        costUsdc: microsToUsdc(pending.exactCostMicros),
        authorizationHash: payment.authorizationHash,
        gatewayStatus: payment.gatewayStatus,
        settlementStatus: "pending_batch",
      },
    };
    return pending.released;
  }

  private paymentRequirements(requestId: string, amountMicros: bigint) {
    return {
      protocol: "x402",
      asset: "USDC",
      amount: microsToUsdc(amountMicros),
      payer: this.payerWallet,
      requestId,
    };
  }
}
