import { describe, expect, it } from "vitest";
import {
  advanceOnboarding,
  initialOnboardingState,
  type OnboardingEvent,
} from "../src/product/onboardingState.js";

describe("onboarding state machine", () => {
  it("starts in created state", () => {
    expect(initialOnboardingState("workspace-1")).toMatchObject({
      workspaceId: "workspace-1",
      state: "created",
    });
  });

  it("advances through the customer golden path", () => {
    let current = initialOnboardingState("workspace-1");
    const events: OnboardingEvent[] = [
      { type: "identity_ready", actorId: "customer-1", requestId: "req-1" },
      { type: "provider_verified", actorId: "customer-1", requestId: "req-2" },
      { type: "payment_ready", actorId: "customer-1", requestId: "req-3" },
      { type: "agent_ready", actorId: "customer-1", requestId: "req-4" },
      { type: "mandate_ready", actorId: "customer-1", requestId: "req-5" },
      { type: "first_run_completed", actorId: "agent-1", requestId: "req-6" },
    ];

    for (const event of events) current = advanceOnboarding(current, event);

    expect(current.state).toBe("first_run_completed");
    expect(current.transitions).toHaveLength(events.length);
    expect(current.transitions.at(-1)).toMatchObject({
      actorId: "agent-1",
      requestId: "req-6",
      from: "ready_to_run",
      to: "first_run_completed",
    });
  });

  it("rejects out-of-order transitions without changing state", () => {
    const current = initialOnboardingState("workspace-1");

    expect(() => advanceOnboarding(current, {
      type: "first_run_completed",
      actorId: "agent-1",
      requestId: "req-invalid",
    })).toThrow("ONBOARDING_INVALID_TRANSITION");
    expect(current.state).toBe("created");
  });

  it("blocks a suspended workspace and records the reason", () => {
    const current = initialOnboardingState("workspace-1");
    const suspended = advanceOnboarding(current, {
      type: "suspended",
      actorId: "operator-1",
      requestId: "req-suspend",
      reason: "manual_review",
    });

    expect(suspended).toMatchObject({ state: "blocked", blockReason: "manual_review" });
    expect(() => advanceOnboarding(suspended, {
      type: "identity_ready",
      actorId: "customer-1",
      requestId: "req-after-block",
    })).toThrow("ONBOARDING_WORKSPACE_BLOCKED");
  });

  it("allows explicit unblock before resuming setup", () => {
    const blocked = advanceOnboarding(initialOnboardingState("workspace-1"), {
      type: "suspended",
      actorId: "operator-1",
      requestId: "req-suspend",
      reason: "manual_review",
    });
    const reopened = advanceOnboarding(blocked, {
      type: "unblocked",
      actorId: "operator-1",
      requestId: "req-unblock",
    });

    expect(reopened).toMatchObject({ state: "created", blockReason: null });
  });
});
