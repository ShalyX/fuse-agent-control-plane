import { describe, expect, it } from "vitest";
import {
  createMandateLifecycle,
  createPaymentLifecycle,
  createRequestLifecycle,
} from "../src/domain/lifecycles.js";

const context = {
  actorId: "service:fuse",
  causationId: "request:req-1",
  occurredAt: "2026-07-13T00:00:00.000Z",
};

describe("production lifecycle state machines", () => {
  it("moves a request through the successful held-response path", () => {
    const request = createRequestLifecycle("req-1");
    request.transition("admitted", context);
    request.transition("reserved", context);
    request.transition("provider_pending", context);
    request.transition("response_held", context);
    request.transition("payment_pending", context);
    request.transition("released", context);
    request.transition("completed", context);

    expect(request.state).toBe("completed");
    expect(request.history().map((event) => event.to)).toEqual([
      "admitted", "reserved", "provider_pending", "response_held",
      "payment_pending", "released", "completed",
    ]);
  });

  it("rejects an impossible request transition", () => {
    const request = createRequestLifecycle("req-1");
    expect(() => request.transition("completed", context)).toThrow(
      "LIFECYCLE_TRANSITION_INVALID:request:received->completed",
    );
    expect(request.state).toBe("received");
  });

  it("tracks accepted payments separately from final settlement", () => {
    const payment = createPaymentLifecycle("pay-1");
    payment.transition("signed", context);
    payment.transition("submitted", context);
    payment.transition("accepted", context);
    payment.transition("pending_batch", context);

    expect(payment.state).toBe("pending_batch");
    payment.transition("finalized", context);
    expect(payment.state).toBe("finalized");
  });

  it("allows an unknown payment to be reconciled into a terminal state", () => {
    const payment = createPaymentLifecycle("pay-1");
    payment.transition("signed", context);
    payment.transition("submitted", context);
    payment.transition("unknown", context);
    payment.transition("failed", { ...context, causationId: "reconcile:pay-1" });
    expect(payment.state).toBe("failed");
  });

  it("keeps mandate pause, reconciliation hold, and close distinct", () => {
    const mandate = createMandateLifecycle("mandate-1");
    mandate.transition("active", context);
    mandate.transition("paused", context);
    mandate.transition("reconciliation_hold", context);
    mandate.transition("closing", context);
    mandate.transition("closed", context);
    expect(mandate.state).toBe("closed");
  });

  it("does not allow manual review to bypass admission and reservation", () => {
    const request = createRequestLifecycle("req-1");
    request.transition("manual_review", context);
    expect(() => request.transition("payment_pending", context)).toThrow(
      "LIFECYCLE_TRANSITION_INVALID:request:manual_review->payment_pending",
    );
  });

  it("does not resurrect an expired mandate through reconciliation hold", () => {
    const mandate = createMandateLifecycle("mandate-1");
    mandate.transition("active", context);
    mandate.transition("expired", context);
    expect(() => mandate.transition("reconciliation_hold", context)).toThrow(
      "LIFECYCLE_TRANSITION_INVALID:mandate:expired->reconciliation_hold",
    );
  });

  it("requires actor and causal identity for transitions", () => {
    const mandate = createMandateLifecycle("mandate-1");
    expect(() => mandate.transition("active", { ...context, actorId: "" })).toThrow(
      "LIFECYCLE_ACTOR_REQUIRED",
    );
    expect(() => mandate.transition("active", { ...context, causationId: "" })).toThrow(
      "LIFECYCLE_CAUSATION_REQUIRED",
    );
  });

  it("requires stable entity identity and a valid transition timestamp", () => {
    expect(() => createMandateLifecycle("")).toThrow("LIFECYCLE_ENTITY_ID_REQUIRED");
    const mandate = createMandateLifecycle("mandate-1");
    expect(() => mandate.transition("active", { ...context, occurredAt: "not-a-date" })).toThrow(
      "LIFECYCLE_OCCURRED_AT_INVALID",
    );
  });

  it("returns immutable transition history", () => {
    const mandate = createMandateLifecycle("mandate-1");
    mandate.transition("active", context);
    const history = mandate.history();
    history[0]!.actorId = "tampered";
    expect(mandate.history()[0]!.actorId).toBe("service:fuse");
  });
});
