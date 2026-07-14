import { expect, it } from "vitest";
import { createOperatorClient } from "../src/operations/operatorClient.js";

const adminToken = "operator-token-with-at-least-32-characters";

it("rejects short operator bearer tokens", () => {
  expect(() => createOperatorClient({
    baseUrl: "https://fuse.example", adminToken: "sixteen-char-key",
  })).toThrow("OPERATOR_TOKEN_INVALID");
});

it("reports open reconciliation cases without exposing the admin credential", async () => {
  const requests: Array<{ url: string; authorization: string }> = [];
  const client = createOperatorClient({
    baseUrl: "https://fuse.example",
    adminToken,
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization: (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "",
      });
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, service: "fuse" }), { status: 200 });
      }
      return new Response(JSON.stringify({ cases: [{
        requestId: "held-1", mandateId: "mandate-1", agentId: "agent-1",
        provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
        reasonCode: "PROVIDER_OUTCOME_AMBIGUOUS", reservedCostAtomic: "100",
        reportedCostAtomic: null, hasProviderResponse: false,
        heldAt: "2026-07-14T08:00:00.000Z",
      }] }), { status: 200 });
    },
  });
  expect(await client.status()).toEqual({
    healthy: true,
    openReconciliationCases: 1,
    casesByReason: { PROVIDER_OUTCOME_AMBIGUOUS: 1 },
    oldestHeldAt: "2026-07-14T08:00:00.000Z",
  });
  expect(requests).toHaveLength(2);
  expect(requests[1]?.authorization).toBe(["Bearer", adminToken].join(" "));
});

it("requires explicit evidence to resolve a case", async () => {
  let submitted: Record<string, unknown> | undefined;
  let requestId = "";
  const client = createOperatorClient({
    baseUrl: "https://fuse.example", adminToken,
    fetch: async (_input, init) => {
      submitted = JSON.parse(String(init?.body));
      requestId = (init?.headers as Record<string, string>)["X-Request-Id"] ?? "";
      return new Response(null, { status: 204 });
    },
  });
  await client.resolve({
    executionRequestId: "held-1", resolution: "confirm_not_billed",
    note: "Provider ledger confirms no charge", externalReference: "provider-ledger:none",
    operationRequestId: "operator:resolve-1",
  });
  expect(submitted).toEqual({
    resolution: "confirm_not_billed", note: "Provider ledger confirms no charge",
    externalReference: "provider-ledger:none",
  });
  expect(requestId).toBe("operator:resolve-1");
});
