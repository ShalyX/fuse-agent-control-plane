import type { FuseServiceState } from "../core/service.js";

export function serializeState(state: FuseServiceState): string {
  return JSON.stringify(state, (_key, value) =>
    typeof value === "bigint" ? { $bigint: value.toString() } : value);
}

export function deserializeState(value: string): FuseServiceState {
  return JSON.parse(value, (_key, entry) =>
    entry && typeof entry === "object" && Object.keys(entry).length === 1 && "$bigint" in entry
      ? BigInt(entry.$bigint)
      : entry) as FuseServiceState;
}

export interface PersistedReceipt {
  requestId: string;
  childId: string;
  [key: string]: unknown;
}

export interface ServiceStateStore {
  readonly kind: "memory" | "postgres";
  read(initial: () => FuseServiceState): Promise<FuseServiceState>;
  listReceipts(): Promise<PersistedReceipt[]>;
  mutate<T>(initial: () => FuseServiceState, operation: (state: FuseServiceState) => Promise<{
    state: FuseServiceState;
    result: T;
  }>): Promise<T>;
}

export class MemoryStateStore implements ServiceStateStore {
  readonly kind = "memory" as const;
  private state?: FuseServiceState;

  async read(initial: () => FuseServiceState) {
    this.state ??= initial();
    return deserializeState(serializeState(this.state));
  }

  async listReceipts(): Promise<PersistedReceipt[]> {
    if (!this.state) return [];
    return this.state.pending
      .map(([, pending]) => pending.released?.receipt)
      .filter((receipt): receipt is NonNullable<typeof receipt> => Boolean(receipt))
      .map((receipt) => JSON.parse(JSON.stringify(receipt)) as PersistedReceipt);
  }

  async mutate<T>(initial: () => FuseServiceState, operation: (state: FuseServiceState) => Promise<{
    state: FuseServiceState;
    result: T;
  }>): Promise<T> {
    const current = await this.read(initial);
    const completed = await operation(current);
    this.state = deserializeState(serializeState(completed.state));
    return completed.result;
  }
}
