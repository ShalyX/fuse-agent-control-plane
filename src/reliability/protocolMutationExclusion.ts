export const PROTOCOL_MUTATION_EXCLUSION_KEY = "fuse-reliability-v2-protocol-mutation";

export interface AdvisoryLockClient {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Ordinary accounting/protocol mutations take the shared side of the one
 * protocol-wide transaction lock. Replays take the exclusive side, so no new
 * mutation can begin until the replay transaction has committed or rolled back.
 */
export async function acquireOrdinaryMutationExclusion(client: AdvisoryLockClient): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock_shared(hashtextextended('${PROTOCOL_MUTATION_EXCLUSION_KEY}',0))`,
  );
}

export async function acquireReplayExclusion(client: AdvisoryLockClient): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('${PROTOCOL_MUTATION_EXCLUSION_KEY}',0))`,
  );
}

/** Retains exclusive exclusion across the replay claim commit, transport, and completion. */
export async function acquireReplaySessionExclusion(client: AdvisoryLockClient): Promise<void> {
  await client.query(
    `SELECT pg_advisory_lock(hashtextextended('${PROTOCOL_MUTATION_EXCLUSION_KEY}',0))`,
  );
}

export async function releaseReplaySessionExclusion(client: AdvisoryLockClient): Promise<void> {
  const result = await client.query(
    `SELECT pg_advisory_unlock(hashtextextended('${PROTOCOL_MUTATION_EXCLUSION_KEY}',0)) AS unlocked`,
  );
  if ((result.rows[0] as { unlocked?: boolean } | undefined)?.unlocked !== true) {
    throw new Error("REPLAY_EXCLUSION_UNLOCK_FAILED");
  }
}
