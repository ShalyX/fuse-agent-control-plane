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

export interface ServiceStateStore {
  read(initial: () => FuseServiceState): Promise<FuseServiceState>;
  mutate<T>(initial: () => FuseServiceState, operation: (state: FuseServiceState) => Promise<{
    state: FuseServiceState;
    result: T;
  }>): Promise<T>;
}

export class MemoryStateStore implements ServiceStateStore {
  private state?: FuseServiceState;

  async read(initial: () => FuseServiceState) {
    this.state ??= initial();
    return deserializeState(serializeState(this.state));
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
