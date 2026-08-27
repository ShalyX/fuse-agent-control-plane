import { expect, it } from "vitest";
import * as operatorClient from "../src/operations/operatorClient.js";

const { createOperatorClient } = operatorClient;

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
      if (url.endsWith("/ready")) {
        return new Response(JSON.stringify({ ready: true }), { status: 200 });
      }
      if (url.endsWith("/api/v1/admin/readiness")) {
        return new Response(JSON.stringify({
          controlMode: true,
          settlementDisabled: true,
          durableInviteGate: true,
          durableAdminRateLimit: true,
          sourceCredentialRevocationEnforced: true,
          staleOnboardingOperations: 0,
          rollbackFailedOnboardingOperations: 0,
          oldestInProgressAt: null,
          orphanCapacityReservations: 0,
          oldestOrphanReservationAt: null,
        }), { status: 200 });
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
    operationalReadiness: {
      controlMode: true,
      settlementDisabled: true,
      durableInviteGate: true,
      durableAdminRateLimit: true,
      sourceCredentialRevocationEnforced: true,
      staleOnboardingOperations: 0,
      rollbackFailedOnboardingOperations: 0,
      oldestInProgressAt: null,
      orphanCapacityReservations: 0,
      oldestOrphanReservationAt: null,
    },
    operationallyReady: false,
  });
  expect(requests).toHaveLength(4);
  expect(requests[2]?.authorization).toBe(["Bearer", adminToken].join(" "));
  expect(requests[3]?.authorization).toBe(["Bearer", adminToken].join(" "));
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

it("turns failed alpha invariants into deterministic operator alerts", () => {
  const alerts = (operatorClient as unknown as {
    alphaOperationalAlerts(status: unknown): string[];
  }).alphaOperationalAlerts({
    healthy: false,
    openReconciliationCases: 2,
    operationalReadiness: {
      controlMode: false,
      settlementDisabled: false,
      durableInviteGate: false,
      durableAdminRateLimit: false,
      sourceCredentialRevocationEnforced: false,
      staleOnboardingOperations: 3,
      rollbackFailedOnboardingOperations: 2,
      oldestInProgressAt: "2026-08-23T10:00:00.000Z",
      orphanCapacityReservations: 4,
      oldestOrphanReservationAt: "2026-08-23T09:00:00.000Z",
    },
  });
  expect(alerts).toEqual([
    "control_plane_unhealthy",
    "control_mode_not_enforced",
    "settlement_enabled",
    "invite_gate_not_durable",
    "admin_rate_limit_not_durable",
    "source_credential_revocation_not_enforced",
    "onboarding_rollback_failures:2",
    "stale_onboarding_operations:3",
    "orphan_capacity_reservations:4",
    "open_reconciliation_cases:2",
  ]);
});

it.each([
  [{ healthy: false, openReconciliationCases: 0 }, "unhealthy control plane"],
  [{ healthy: true, openReconciliationCases: 1 }, "open reconciliation work"],
])("does not report operational readiness with %s", async (override) => {
  const client = createOperatorClient({
    baseUrl: "https://fuse.example", adminToken,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: override.healthy, service: "fuse" }), {
          status: override.healthy ? 200 : 503,
        });
      }
      if (url.endsWith("/ready")) {
        return new Response(JSON.stringify({ ready: true }), { status: 200 });
      }
      if (url.endsWith("/api/v1/admin/readiness")) {
        return new Response(JSON.stringify({
          controlMode: true, settlementDisabled: true, durableInviteGate: true,
          durableAdminRateLimit: true, sourceCredentialRevocationEnforced: true,
          staleOnboardingOperations: 0, rollbackFailedOnboardingOperations: 0,
          oldestInProgressAt: null, orphanCapacityReservations: 0,
          oldestOrphanReservationAt: null,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        cases: Array.from({ length: override.openReconciliationCases }, (_, index) => ({
          requestId: `held-${index}`, mandateId: "mandate-1", agentId: "agent-1",
          provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
          reasonCode: "PROVIDER_OUTCOME_AMBIGUOUS", reservedCostAtomic: "100",
          reportedCostAtomic: null, hasProviderResponse: false,
          heldAt: "2026-08-23T10:00:00.000Z",
        })),
      }), { status: 200 });
    },
  });

  expect((await client.status()).operationallyReady).toBe(false);
});

it("does not report operational readiness when dependency readiness fails", async () => {
  const client = createOperatorClient({
    baseUrl: "https://fuse.example", adminToken,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, service: "fuse" }), { status: 200 });
      }
      if (url.endsWith("/ready")) {
        return new Response(JSON.stringify({ ready: false }), { status: 503 });
      }
      if (url.endsWith("/api/v1/admin/readiness")) {
        return new Response(JSON.stringify({
          controlMode: true, settlementDisabled: true, durableInviteGate: true,
          durableAdminRateLimit: true, sourceCredentialRevocationEnforced: true,
          staleOnboardingOperations: 0, rollbackFailedOnboardingOperations: 0,
          oldestInProgressAt: null, orphanCapacityReservations: 0,
          oldestOrphanReservationAt: null,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ cases: [] }), { status: 200 });
    },
  });

  expect((await client.status()).operationallyReady).toBe(false);
});
