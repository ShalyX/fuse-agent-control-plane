import { describe, expect, it } from "vitest";
import {
  buildFixtureCallPlan,
  buildFixtureSetupPlan,
  buildReplayReport,
  validateAuthoritativeAttempts,
  validateEvidenceRunId,
  validateFixtureOutcomes,
  validateFuseUrl,
  fixtureScenarios,
  type AttemptManifestEntry,
  type PersistedShadowEvidence,
} from "../src/evidence/harness.js";

describe("fixture setup contract", () => {
  it("matches strict HTTP bodies and creates every branch before activation", () => {
    const plan = buildFixtureSetupPlan({
      runId: "run-1",
      model: "claude-sonnet-4-6",
      mandateId: "fixture-run-1",
      policyId: "fixture-policy-run-1",
      agentId: "fixture-agent-run-1",
    });

    expect(plan.map(({ path }) => path)).toEqual([
      "/api/v1/admin/agents",
      "/api/v1/admin/agent-credentials",
      "/api/v1/admin/policies",
      "/api/v1/admin/mandates",
      "/api/v1/admin/mandates/fixture-run-1/agents",
      ...plan.filter(({ kind }) => kind === "branch").map(({ path }) => path),
      "/api/v1/admin/mandates/fixture-run-1/transitions",
    ]);
    expect(plan.at(-1)?.body).toEqual({ to: "active" });
    expect(plan.at(-1)?.body).not.toHaveProperty("requestId");

    const policy = plan.find(({ kind }) => kind === "policy")!;
    expect(policy.body).toMatchObject({
      policyId: "fixture-policy-run-1",
      version: 1,
      mode: "enforce",
      allowedProviders: ["anthropic"],
      allowedModels: ["claude-sonnet-4-6"],
      requiredCapability: "inference:invoke",
      limits: {
        maxPerCallAtomic: expect.any(String),
        maxHourlyAtomic: expect.any(String),
        maxDailyAtomic: expect.any(String),
      },
    });
    expect(policy.body).not.toHaveProperty("allowedProvider");
    expect(policy.body).not.toHaveProperty("requestId");

    const credential = plan.find(({ kind }) => kind === "agentCredential")!;
    expect(credential.body).toEqual({
      credentialId: "fixture-runtime-run-1",
      agentId: "fixture-agent-run-1",
      name: "Sibling divergence fixture runtime",
      capabilities: ["inference:invoke", "mandates:read", "receipts:read"],
      expiresAt: null,
    });

    for (const branch of plan.filter(({ kind }) => kind === "branch")) {
      expect(branch.body).toEqual({
        branchId: expect.any(String),
        parentBranchId: branch.body.parentBranchId,
        agentId: "fixture-agent-run-1",
        allowedWorkloadClasses: expect.any(Array),
        maximumSpendAtomic: expect.stringMatching(/^[1-9]\d*$/),
        expiresAt: null,
      });
      expect(branch.body.parentBranchId === null || typeof branch.body.parentBranchId === "string").toBe(true);
      expect(branch.body).not.toHaveProperty("mandateId");
      expect(branch.body).not.toHaveProperty("requestId");
    }
  });

  it("defines the ten required scenarios and real fan-out sizes", () => {
    expect(fixtureScenarios.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(fixtureScenarios.find(({ id }) => id === 2)?.fanOut).toBe(3);
    expect(fixtureScenarios.find(({ id }) => id === 3)?.fanOut).toBe(2);
    expect(fixtureScenarios.find(({ id }) => id === 4)?.fanOut).toBe(4);
    expect(fixtureScenarios.find(({ id }) => id === 7)?.fanOut).toBe(4);
    expect(fixtureScenarios.find(({ id }) => id === 8)?.fanOut).toBe(3);
  });

  it("builds all ten executable fixture call sequences without inventing dynamic outcomes", () => {
    const calls = buildFixtureCallPlan("run-1", "claude-sonnet-4-6");
    expect(new Set(calls.map(({ fixtureId }) => fixtureId))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(calls.every(({ requestId }, index) => requestId === `run-1-f${calls[index]!.fixtureId}-${index + 1}`)).toBe(true);
    expect(calls.find(({ fixtureId }) => fixtureId === 5)).toMatchObject({
      branchId: "f5-escalation", workloadClass: "expensive-summary", expected: "denied", label: "hard-deny",
    });
    expect(calls.find(({ fixtureId }) => fixtureId === 9)).toMatchObject({
      branchId: "f9-mismatch", model: "gpt-4o", expected: "denied", label: "hard-deny",
    });
    const budgetCalls = calls.filter(({ fixtureId }) => fixtureId === 10);
    expect(budgetCalls).toHaveLength(10);
    expect(budgetCalls.every(({ expected }) => expected === "completed-or-denied")).toBe(true);
    expect(calls.every(({ mandateId }) => mandateId === "fixture-run-1")).toBe(true);
  });

  it("rejects unsafe run IDs and enforces fixture-specific denial truth", () => {
    expect(validateEvidenceRunId("evidence-123.good")).toBe("evidence-123.good");
    expect(() => validateEvidenceRunId("../escape")).toThrow("EVIDENCE_RUN_ID_INVALID");
    expect(validateFuseUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(validateFuseUrl("https://fuse.example.test/path")).toBe("https://fuse.example.test");
    expect(() => validateFuseUrl("http://fuse.example.test")).toThrow("FUSE_URL_INSECURE");
    expect(() => validateFuseUrl("https://user:pass@fuse.example.test")).toThrow("FUSE_URL_CREDENTIALS_FORBIDDEN");
    const calls = buildFixtureCallPlan("r", "claude-sonnet-4-6");
    const attempts = calls.map((call, index): AttemptManifestEntry => ({
      runId: "r", fixtureId: call.fixtureId, requestId: call.requestId, sequence: index + 1,
      label: call.label, outcome: call.expected === "denied" ? "denied" : "completed",
      actualCostAtomic: call.expected === "denied" ? "0" : "1",
      ...(call.fixtureId === 5 ? { denialCode: "WORKLOAD_CLASS_NOT_ALLOWED" } : {}),
      ...(call.fixtureId === 9 ? { denialCode: "MODEL_NOT_ALLOWED" } : {}),
      occurredAt: "2026-07-21T00:00:00.000Z",
    }));
    attempts.at(-1)!.outcome = "denied";
    attempts.at(-1)!.actualCostAtomic = "0";
    attempts.at(-1)!.denialCode = "BRANCH_BUDGET_EXCEEDED";
    expect(() => validateFixtureOutcomes(calls, attempts)).not.toThrow();
    const wrong = attempts.map((attempt) => attempt.fixtureId === 5
      ? { ...attempt, denialCode: "CAPABILITY_MISSING" } : attempt);
    expect(() => validateFixtureOutcomes(calls, wrong)).toThrow("FIXTURE_DENIAL_REASON_MISMATCH");
    const relabeled = attempts.map((attempt, index) => index === 0
      ? { ...attempt, label: "runaway" as const } : attempt);
    expect(() => validateFixtureOutcomes(calls, relabeled)).toThrow("FIXTURE_MANIFEST_MISMATCH");
  });
});

describe("truthful A/B/C replay", () => {
  it("uses hard-gate truth for A and persisted evidence for B and C", () => {
    const attempts: AttemptManifestEntry[] = [
      { runId: "r", fixtureId: 1, requestId: "legit-1", sequence: 1, label: "legitimate", outcome: "completed", actualCostAtomic: "100", occurredAt: "2026-07-21T00:00:01.000Z" },
      { runId: "r", fixtureId: 2, requestId: "runaway-1", sequence: 2, label: "runaway", outcome: "completed", actualCostAtomic: "200", occurredAt: "2026-07-21T00:00:02.000Z" },
      { runId: "r", fixtureId: 2, requestId: "runaway-2", sequence: 3, label: "runaway", outcome: "completed", actualCostAtomic: "300", occurredAt: "2026-07-21T00:00:03.000Z" },
      { runId: "r", fixtureId: 5, requestId: "hard-deny", sequence: 4, label: "hard-deny", outcome: "denied", actualCostAtomic: "0", denialCode: "WORKLOAD_CLASS_NOT_ALLOWED", occurredAt: "2026-07-21T00:00:04.000Z" },
    ];
    const evidence: PersistedShadowEvidence[] = [
      { requestId: "runaway-1", signals: ["CLASS_PRIOR_EXCEEDED"], eligibleForIntervention: false, wouldSignalTarget: true, cohortShift: false, cohortOrdinal: "2" },
      { requestId: "runaway-2", signals: ["SIBLING_DIVERGENCE", "CLASS_PRIOR_EXCEEDED"], eligibleForIntervention: true, wouldSignalTarget: true, cohortShift: false, cohortOrdinal: "3" },
    ];

    const report = buildReplayReport(attempts, evidence);

    expect(report.policies.A).toMatchObject({ hardDenials: 1, warnings: 0, wouldIntervene: 0 });
    expect(report.policies.B).toMatchObject({ warnings: 2, wouldIntervene: 0, firstSignalRequestId: "runaway-1", spendBeforeFirstSignalAtomic: "100", firstRunawaySignalRequestId: "runaway-1", runawaySpendBeforeFirstSignalAtomic: "0" });
    expect(report.policies.C).toMatchObject({ warnings: 2, wouldIntervene: 1, firstSignalRequestId: "runaway-1", spendBeforeFirstSignalAtomic: "100", firstRunawaySignalRequestId: "runaway-1", runawaySpendBeforeFirstSignalAtomic: "0", firstSiblingDivergenceRequestId: "runaway-2", runawaySpendBeforeSiblingDivergenceAtomic: "200" });
    expect(report.policies.C.falseWarnings).toBe(0);
    expect(report.coverage).toEqual({ attempts: 4, completed: 3, denied: 1, withPersistedShadowEvidence: 2, missingShadowEvidence: ["legit-1"] });
    expect(report.unavailableMetrics).toContain("operatorRecoveryTime");
    expect(report.unavailableMetrics).toContain("actualBehavioralInterventions");
  });

  it("rejects fabricated or incomplete replay inputs", () => {
    const duplicate: AttemptManifestEntry = {
      runId: "r", fixtureId: 1, requestId: "same", sequence: 1, label: "legitimate",
      outcome: "completed", actualCostAtomic: "1", occurredAt: "2026-07-21T00:00:00.000Z",
    };
    expect(() => buildReplayReport([duplicate, { ...duplicate, sequence: 2 }], [])).toThrow("REPLAY_REQUEST_ID_DUPLICATE");
    expect(() => buildReplayReport([{ ...duplicate, actualCostAtomic: "-1" }], [])).toThrow("REPLAY_ATOMIC_AMOUNT_INVALID");
  });

  it("cross-checks the manifest against authoritative execution rows", () => {
    const attempts: AttemptManifestEntry[] = [{
      runId: "r", fixtureId: 1, requestId: "request-1", sequence: 1, label: "legitimate",
      outcome: "completed", actualCostAtomic: "125", occurredAt: "2026-07-21T00:00:00.000Z",
    }];
    expect(() => validateAuthoritativeAttempts(attempts, [{ requestId: "request-1", status: "completed", actualCostAtomic: "125" }])).not.toThrow();
    expect(() => validateAuthoritativeAttempts(attempts, [{ requestId: "request-1", status: "completed", actualCostAtomic: "126" }])).toThrow("REPLAY_AUTHORITATIVE_COST_MISMATCH");
    expect(() => validateAuthoritativeAttempts(attempts, [])).toThrow("REPLAY_AUTHORITATIVE_EXECUTION_MISSING");
  });
});
