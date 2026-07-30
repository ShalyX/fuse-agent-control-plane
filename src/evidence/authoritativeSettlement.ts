import { createHash } from "node:crypto";

export const SETTLEMENT_OFFSETS_SECONDS = Object.freeze(Array.from({ length: 25 }, (_, index) => index * 5));
export const SETTLEMENT_WINDOW_MS = 120_000;
export const SETTLEMENT_DATABASE_OPERATION_MS = 30_000;

export interface SettlementSnapshot {
  complete: boolean;
  rows: Readonly<Record<string, readonly unknown[]>>;
}

export interface SettlementTransactionOptions {
  isolationLevel: "REPEATABLE READ";
  readOnly: true;
  startDeadlineMs: number;
  queryDeadlineMs: number;
}

export interface SettlementTransactionResult<T> {
  value: T;
  databaseStartedAtMs: number;
  queryFinishedAtMs: number;
}

export interface SettlementTransactionPrimitives<TTransaction = unknown> {
  nowMs(): number;
  sleepUntil(epochMs: number): Promise<void>;
  transaction<T>(
    options: SettlementTransactionOptions,
    operation: (transaction: TTransaction) => Promise<T>,
  ): Promise<SettlementTransactionResult<T>>;
}

export interface SettlementPollJournalEntry {
  pollNo: number;
  offsetSeconds: number;
  scheduledAtMs: number;
  databaseStartedAtMs: number | null;
  queryFinishedAtMs: number | null;
  deadlineEligible: boolean;
  complete: boolean;
  snapshotDigest: string | null;
  rowCardinality: number;
  errorCode: "SETTLEMENT_DATABASE_OPERATION_FAILED" | null;
}

export interface AuthoritativeSettlementResult {
  runId: string;
  settlementStartedAtMs: number;
  settlementDeadlineMs: number;
  passed: boolean;
  acceptedOffsetSeconds: number | null;
  journal: readonly SettlementPollJournalEntry[];
  finalSnapshot: {
    digest: string | null;
    rowCardinality: number;
    journalCardinality: number;
  };
  acceptedSnapshot: null | {
    digest: string;
    databaseStartedAtMs: number;
    rows: Readonly<Record<string, readonly unknown[]>>;
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
}

function canonicalInventory(rows: Readonly<Record<string, readonly unknown[]>>): string {
  const normalized = Object.fromEntries(Object.keys(rows).sort().map((table) => {
    const values = [...(rows[table] ?? [])].map((row) => ({ bytes: canonical(row), row }));
    values.sort((left, right) => left.bytes.localeCompare(right.bytes));
    return [table, values.map((value) => value.row)];
  }));
  return canonical(normalized);
}

export function authoritativeSnapshotDigest(rows: Readonly<Record<string, readonly unknown[]>>): string {
  return `sha256:${createHash("sha256").update(canonicalInventory(rows)).digest("hex")}`;
}

export function authoritativeSnapshotCardinality(rows: Readonly<Record<string, readonly unknown[]>>): number {
  return Object.values(rows).reduce((total, inventory) => total + inventory.length, 0);
}

export async function runAuthoritativeSettlement<TTransaction>(input: {
  runId: string;
  primitives: SettlementTransactionPrimitives<TTransaction>;
  readSnapshot(transaction: TTransaction): Promise<SettlementSnapshot>;
}): Promise<AuthoritativeSettlementResult> {
  if (!input.runId) throw new Error("SETTLEMENT_RUN_ID_REQUIRED");
  const settlementStartedAtMs = input.primitives.nowMs();
  if (!Number.isFinite(settlementStartedAtMs)) throw new Error("SETTLEMENT_CLOCK_INVALID");
  const settlementDeadlineMs = settlementStartedAtMs + SETTLEMENT_WINDOW_MS;
  const journal: SettlementPollJournalEntry[] = [];
  let acceptedOffsetSeconds: number | null = null;
  let finalDigest: string | null = null;
  let finalRowCardinality = 0;
  let acceptedSnapshot: AuthoritativeSettlementResult["acceptedSnapshot"] = null;

  for (const [index, offsetSeconds] of SETTLEMENT_OFFSETS_SECONDS.entries()) {
    const scheduledAtMs = settlementStartedAtMs + offsetSeconds * 1_000;
    await input.primitives.sleepUntil(scheduledAtMs);
    try {
      const observed = await input.primitives.transaction(
        {
          isolationLevel: "REPEATABLE READ",
          readOnly: true,
          startDeadlineMs: settlementDeadlineMs,
          queryDeadlineMs: settlementDeadlineMs + SETTLEMENT_DATABASE_OPERATION_MS,
        },
        input.readSnapshot,
      );
      const digest = authoritativeSnapshotDigest(observed.value.rows);
      const rowCardinality = authoritativeSnapshotCardinality(observed.value.rows);
      const startEligible = observed.databaseStartedAtMs >= scheduledAtMs
        && observed.databaseStartedAtMs <= settlementDeadlineMs;
      const finishEligible = observed.queryFinishedAtMs >= observed.databaseStartedAtMs
        && observed.queryFinishedAtMs <= observed.databaseStartedAtMs + SETTLEMENT_DATABASE_OPERATION_MS;
      const deadlineEligible = startEligible && finishEligible;
      const complete = deadlineEligible && observed.value.complete === true;
      journal.push({
        pollNo: index + 1, offsetSeconds, scheduledAtMs,
        databaseStartedAtMs: observed.databaseStartedAtMs,
        queryFinishedAtMs: observed.queryFinishedAtMs,
        deadlineEligible, complete, snapshotDigest: digest, rowCardinality, errorCode: null,
      });
      finalDigest = digest;
      finalRowCardinality = rowCardinality;
      if (complete) {
        acceptedOffsetSeconds = offsetSeconds;
        acceptedSnapshot = { digest, databaseStartedAtMs: observed.databaseStartedAtMs, rows: observed.value.rows };
        break;
      }
    } catch {
      journal.push({
        pollNo: index + 1, offsetSeconds, scheduledAtMs,
        databaseStartedAtMs: null, queryFinishedAtMs: null,
        deadlineEligible: false, complete: false, snapshotDigest: null, rowCardinality: 0,
        errorCode: "SETTLEMENT_DATABASE_OPERATION_FAILED",
      });
    }
  }

  return {
    runId: input.runId,
    settlementStartedAtMs,
    settlementDeadlineMs,
    passed: acceptedOffsetSeconds !== null,
    acceptedOffsetSeconds,
    journal,
    finalSnapshot: { digest: finalDigest, rowCardinality: finalRowCardinality, journalCardinality: journal.length },
    acceptedSnapshot,
  };
}
