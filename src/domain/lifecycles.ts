export interface TransitionContext {
  actorId: string;
  causationId: string;
  occurredAt: string;
}

export interface LifecycleTransition<State extends string> extends TransitionContext {
  entityId: string;
  kind: string;
  from: State;
  to: State;
  sequence: number;
}

class Lifecycle<State extends string> {
  private current: State;
  private readonly events: Array<LifecycleTransition<State>> = [];

  constructor(
    private readonly kind: string,
    private readonly entityId: string,
    initial: State,
    private readonly transitions: Record<State, readonly State[]>,
  ) {
    if (!entityId.trim()) throw new Error("LIFECYCLE_ENTITY_ID_REQUIRED");
    this.current = initial;
  }

  get state(): State {
    return this.current;
  }

  transition(to: State, context: TransitionContext): void {
    if (!context.actorId.trim()) throw new Error("LIFECYCLE_ACTOR_REQUIRED");
    if (!context.causationId.trim()) throw new Error("LIFECYCLE_CAUSATION_REQUIRED");
    if (Number.isNaN(Date.parse(context.occurredAt))) throw new Error("LIFECYCLE_OCCURRED_AT_INVALID");
    if (!this.transitions[this.current].includes(to)) {
      throw new Error(`LIFECYCLE_TRANSITION_INVALID:${this.kind}:${this.current}->${to}`);
    }
    const event: LifecycleTransition<State> = {
      ...context,
      entityId: this.entityId,
      kind: this.kind,
      from: this.current,
      to,
      sequence: this.events.length + 1,
    };
    this.events.push(event);
    this.current = to;
  }

  history(): Array<LifecycleTransition<State>> {
    return this.events.map((event) => ({ ...event }));
  }
}

export type RequestState =
  | "received" | "admitted" | "reserved" | "provider_pending"
  | "response_held" | "payment_pending" | "released" | "completed"
  | "provider_failed" | "reservation_expired" | "payment_rejected"
  | "response_expired" | "manual_review" | "compensation_required";

const requestTransitions: Record<RequestState, readonly RequestState[]> = {
  received: ["admitted", "manual_review"],
  admitted: ["reserved", "manual_review"],
  reserved: ["provider_pending", "reservation_expired", "manual_review"],
  provider_pending: ["response_held", "provider_failed", "compensation_required"],
  response_held: ["payment_pending", "response_expired", "manual_review"],
  payment_pending: ["released", "payment_rejected", "compensation_required", "manual_review"],
  released: ["completed", "compensation_required"],
  completed: [],
  provider_failed: [],
  reservation_expired: [],
  payment_rejected: [],
  response_expired: [],
  manual_review: [],
  compensation_required: [],
};

export type PaymentState =
  | "created" | "signed" | "submitted" | "accepted" | "pending_batch"
  | "finalized" | "rejected" | "expired" | "failed" | "reversed"
  | "disputed" | "unknown";

const paymentTransitions: Record<PaymentState, readonly PaymentState[]> = {
  created: ["signed", "rejected", "expired"],
  signed: ["submitted", "rejected", "expired"],
  submitted: ["accepted", "rejected", "failed", "expired", "unknown"],
  accepted: ["pending_batch", "finalized", "failed", "reversed", "unknown"],
  pending_batch: ["finalized", "failed", "reversed", "disputed", "unknown"],
  finalized: ["reversed", "disputed"],
  rejected: [],
  expired: [],
  failed: [],
  reversed: ["disputed"],
  disputed: [],
  unknown: ["accepted", "pending_batch", "finalized", "failed", "rejected", "expired", "reversed", "disputed"],
};

export type MandateState =
  | "draft" | "active" | "paused" | "closing" | "closed"
  | "exhausted" | "tripped" | "expired" | "reconciliation_hold";

const mandateTransitions: Record<MandateState, readonly MandateState[]> = {
  draft: ["active", "expired"],
  active: ["paused", "closing", "exhausted", "tripped", "expired", "reconciliation_hold"],
  paused: ["active", "closing", "expired", "reconciliation_hold"],
  closing: ["closed", "reconciliation_hold"],
  closed: [],
  exhausted: ["closing", "reconciliation_hold"],
  tripped: ["active", "closing", "reconciliation_hold"],
  expired: ["closing"],
  reconciliation_hold: ["closing"],
};

export const createRequestLifecycle = (id: string) =>
  new Lifecycle<RequestState>("request", id, "received", requestTransitions);

export const createPaymentLifecycle = (id: string) =>
  new Lifecycle<PaymentState>("payment", id, "created", paymentTransitions);

export const createMandateLifecycle = (id: string) =>
  new Lifecycle<MandateState>("mandate", id, "draft", mandateTransitions);
