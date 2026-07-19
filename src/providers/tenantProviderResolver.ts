import type { InferenceProvider } from "../core/service.js";
import type { ProviderExecutionBinding } from "../inference/inferenceExecution.js";
import type { ResolvedProviderConfiguration } from "../persistence/providerConfigStore.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenRouterProvider } from "./openRouter.js";

interface ProviderConfigSource {
  resolve(organizationId: string): Promise<ResolvedProviderConfiguration>;
}

interface AnthropicOptions {
  apiKey: string;
  model: string;
}

interface OpenRouterOptions extends AnthropicOptions {
  siteUrl?: string;
  appName?: string;
}

interface ProviderFactories {
  anthropic: (options: AnthropicOptions) => InferenceProvider;
  openrouter: (options: OpenRouterOptions) => InferenceProvider;
}

const defaultFactories: ProviderFactories = {
  anthropic: (options) => new AnthropicProvider(options),
  openrouter: (options) => new OpenRouterProvider(options),
};

export class TenantProviderResolver {
  constructor(
    private readonly source: ProviderConfigSource,
    private readonly factories: ProviderFactories = defaultFactories,
    private readonly siteUrl = "https://fuse-agent-control-plane.vercel.app",
  ) {}

  async resolve(organizationId: string): Promise<ProviderExecutionBinding> {
    const config = await this.source.resolve(organizationId);
    const provider = config.provider === "anthropic"
      ? this.factories.anthropic({
        apiKey: config.apiKey,
        model: config.model,
      })
      : this.factories.openrouter({
        apiKey: config.apiKey,
        model: config.model,
        siteUrl: this.siteUrl,
        appName: "Fuse",
      });
    return {
      provider,
      providerName: config.provider,
      model: config.model,
      price: {
        inputUsdPerMillion: config.inputUsdPerMillion,
        outputUsdPerMillion: config.outputUsdPerMillion,
      },
      requireProviderCost: config.requireProviderCost,
      requireProviderModelMatch: config.requireProviderModelMatch,
    };
  }
}
