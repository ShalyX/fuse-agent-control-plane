const env = process.env;
const apiKey = env["ANTHROPIC_API_KEY"];
const baseUrl = env["AGENTROUTER_BASE_URL"] ?? "https://agentrouter.org/v1";
const model = env["AGENTROUTER_MODEL"] ?? "claude-opus-4-8";
const userAgent = env["AGENTROUTER_USER_AGENT"] ?? "claude-cli/2.0.0 (external, cli)";
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is empty");

const response = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "user-agent": userAgent,
  },
  body: JSON.stringify({
    model,
    max_tokens: 64,
    messages: [{ role: "user", content: "Reply with exactly: FUSE ROUTER OK" }],
  }),
});
const body = await response.json() as Record<string, unknown>;
console.log(JSON.stringify({
  status: response.status,
  id: body.id,
  model: body.model,
  choices: body.choices,
  usage: body.usage,
  error: body.error,
}, null, 2));
if (!response.ok) process.exitCode = 1;
