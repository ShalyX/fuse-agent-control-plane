import { readBoundedBody } from "../reliability/boundedBody.js";

const MAX_RESPONSE_BYTES = 1_048_576;

type OpenRouterModelsResponse = {
  data?: Array<{ id?: unknown }>;
};

export type OpenRouterCredentialVerification = {
  provider: "openrouter";
  model: string;
};

export async function verifyOpenRouterCredential(config: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<OpenRouterCredentialVerification> {
  if (!config.apiKey.trim()) throw new Error("OPENROUTER_CREDENTIAL_INVALID");
  if (!config.model.trim()) throw new Error("OPENROUTER_MODEL_INVALID");

  const fetcher = config.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${(config.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "")}/models`, {
      method: "GET",
      headers: {
        Authorization: ["Bearer", config.apiKey].join(" "),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });
  } catch {
    throw new Error("OPENROUTER_VERIFICATION_UNAVAILABLE");
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("OPENROUTER_CREDENTIAL_INVALID");
  }
  if (!response.ok) throw new Error("OPENROUTER_VERIFICATION_FAILED");

  let body: OpenRouterModelsResponse;
  try {
    const text = (await readBoundedBody(response, MAX_RESPONSE_BYTES)).bytes.toString("utf8");
    body = JSON.parse(text) as OpenRouterModelsResponse;
  } catch {
    throw new Error("OPENROUTER_VERIFICATION_INVALID_RESPONSE");
  }

  if (!body.data?.some((entry) => entry.id === config.model)) {
    throw new Error("OPENROUTER_MODEL_UNAVAILABLE");
  }
  return { provider: "openrouter", model: config.model };
}
