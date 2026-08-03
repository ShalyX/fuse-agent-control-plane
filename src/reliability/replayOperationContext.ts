import { AsyncLocalStorage } from "node:async_hooks";

const replayOperation = new AsyncLocalStorage<string>();

export function withTrustedReplayOperation<T>(operationId: string, operation: () => T): T {
  if (!/^replay-[0-9a-f]{64}$/.test(operationId)) throw new Error("REPLAY_OPERATION_ID_INVALID");
  return replayOperation.run(operationId, operation);
}

export function currentTrustedReplayOperation(): string | undefined {
  return replayOperation.getStore();
}
