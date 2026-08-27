export type OnboardingState =
  | "created"
  | "identity_ready"
  | "provider_pending"
  | "provider_verified"
  | "payment_pending"
  | "payment_ready"
  | "agent_pending"
  | "mandate_pending"
  | "ready_to_run"
  | "first_run_completed"
  | "blocked";

export type OnboardingEvent =
  | { type: "identity_ready"; actorId: string; requestId: string }
  | { type: "provider_pending"; actorId: string; requestId: string }
  | { type: "provider_verified"; actorId: string; requestId: string }
  | { type: "payment_pending"; actorId: string; requestId: string }
  | { type: "payment_ready"; actorId: string; requestId: string }
  | { type: "agent_pending"; actorId: string; requestId: string }
  | { type: "agent_ready"; actorId: string; requestId: string }
  | { type: "mandate_pending"; actorId: string; requestId: string }
  | { type: "mandate_ready"; actorId: string; requestId: string }
  | { type: "first_run_completed"; actorId: string; requestId: string }
  | { type: "suspended"; actorId: string; requestId: string; reason: string }
  | { type: "unblocked"; actorId: string; requestId: string };

export interface OnboardingTransition {
  from: OnboardingState;
  to: OnboardingState;
  event: OnboardingEvent["type"];
  actorId: string;
  requestId: string;
  occurredAt: string;
  reason: string | null;
}

export interface OnboardingSnapshot {
  workspaceId: string;
  state: OnboardingState;
  blockReason: string | null;
  transitions: OnboardingTransition[];
}

const nextStates: Partial<Record<OnboardingState, Partial<Record<OnboardingEvent["type"], OnboardingState>>>> = {
  created: { identity_ready: "identity_ready", suspended: "blocked" },
  identity_ready: { provider_pending: "provider_pending", provider_verified: "provider_verified", suspended: "blocked" },
  provider_pending: { provider_verified: "provider_verified", suspended: "blocked" },
  provider_verified: { payment_pending: "payment_pending", payment_ready: "payment_ready", suspended: "blocked" },
  payment_pending: { payment_ready: "payment_ready", suspended: "blocked" },
  payment_ready: { agent_pending: "agent_pending", agent_ready: "agent_pending", suspended: "blocked" },
  agent_pending: { agent_ready: "mandate_pending", mandate_pending: "mandate_pending", mandate_ready: "ready_to_run", suspended: "blocked" },
  mandate_pending: { mandate_ready: "ready_to_run", suspended: "blocked" },
  ready_to_run: { first_run_completed: "first_run_completed", suspended: "blocked" },
  first_run_completed: { suspended: "blocked" },
  blocked: { unblocked: "created" },
};

export function initialOnboardingState(workspaceId: string): OnboardingSnapshot {
  const normalized = workspaceId.trim();
  if (!normalized) throw new Error("ONBOARDING_WORKSPACE_REQUIRED");
  return { workspaceId: normalized, state: "created", blockReason: null, transitions: [] };
}

export function advanceOnboarding(
  snapshot: OnboardingSnapshot,
  event: OnboardingEvent,
  now = () => new Date().toISOString(),
): OnboardingSnapshot {
  const target = nextStates[snapshot.state]?.[event.type];
  if (!target) {
    throw new Error(snapshot.state === "blocked" && event.type !== "unblocked"
      ? "ONBOARDING_WORKSPACE_BLOCKED"
      : "ONBOARDING_INVALID_TRANSITION");
  }
  const transition: OnboardingTransition = {
    from: snapshot.state,
    to: target,
    event: event.type,
    actorId: event.actorId,
    requestId: event.requestId,
    occurredAt: now(),
    reason: event.type === "suspended" ? event.reason : null,
  };
  return {
    workspaceId: snapshot.workspaceId,
    state: target,
    blockReason: event.type === "suspended" ? event.reason : null,
    transitions: [...snapshot.transitions, transition],
  };
}
