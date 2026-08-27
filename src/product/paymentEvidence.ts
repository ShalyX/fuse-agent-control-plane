import type { Pool } from "pg";

export interface PaymentEvidence {
  requestId: string;
  organizationId: string;
  actualCostAtomic: string;
  payment: unknown;
  recordedAt: string;
}

export interface PaymentEvidenceStore {
  record(evidence: PaymentEvidence): Promise<void>;
  get(organizationId: string, requestId: string): Promise<PaymentEvidence | null>;
  listForRequests?(organizationId: string, requestIds: string[]): Promise<PaymentEvidence[]>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameEvidence(left: PaymentEvidence, right: PaymentEvidence): boolean {
  return left.organizationId === right.organizationId
    && left.requestId === right.requestId
    && left.actualCostAtomic === right.actualCostAtomic
    && canonicalJson(left.payment) === canonicalJson(right.payment);
}

export class MemoryPaymentEvidenceStore implements PaymentEvidenceStore {
  readonly records = new Map<string, PaymentEvidence>();

  async record(evidence: PaymentEvidence): Promise<void> {
    const key = `${evidence.organizationId}:${evidence.requestId}`;
    const existing = this.records.get(key);
    if (existing && !sameEvidence(existing, evidence)) throw new Error("PAYMENT_EVIDENCE_CONFLICT");
    if (!existing) this.records.set(key, structuredClone(evidence));
  }

  async get(organizationId: string, requestId: string): Promise<PaymentEvidence | null> {
    const evidence = this.records.get(`${organizationId}:${requestId}`);
    return evidence ? structuredClone(evidence) : null;
  }

  async listForRequests(organizationId: string, requestIds: string[]): Promise<PaymentEvidence[]> {
    return requestIds.flatMap((requestId) => {
      const evidence = this.records.get(`${organizationId}:${requestId}`);
      return evidence ? [structuredClone(evidence)] : [];
    });
  }
}

export class PostgresPaymentEvidenceStore implements PaymentEvidenceStore {
  private initialized?: Promise<void>;

  constructor(private readonly pool: Pool) {}

  private ensureSchema(): Promise<void> {
    this.initialized ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS fuse_payment_evidence (
        organization_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        actual_cost_atomic NUMERIC(78, 0) NOT NULL CHECK (actual_cost_atomic >= 0),
        payment_json JSONB NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (organization_id, request_id)
      );
    `).then(() => undefined);
    return this.initialized;
  }

  async record(evidence: PaymentEvidence): Promise<void> {
    await this.ensureSchema();
    const inserted = await this.pool.query<{ request_id: string }>(
      `INSERT INTO fuse_payment_evidence
        (organization_id, request_id, actual_cost_atomic, payment_json, recorded_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (organization_id, request_id) DO NOTHING
       RETURNING request_id`,
      [evidence.organizationId, evidence.requestId, evidence.actualCostAtomic,
        JSON.stringify(evidence.payment), evidence.recordedAt],
    );
    if (inserted.rowCount === 1) return;

    const existing = await this.pool.query<{
      organization_id: string;
      request_id: string;
      actual_cost_atomic: string;
      payment_json: unknown;
      recorded_at: string;
    }>(
      `SELECT organization_id, request_id, actual_cost_atomic, payment_json, recorded_at
       FROM fuse_payment_evidence
       WHERE organization_id = $1 AND request_id = $2`,
      [evidence.organizationId, evidence.requestId],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("PAYMENT_EVIDENCE_CONFLICT");
    const prior: PaymentEvidence = {
      requestId: row.request_id,
      organizationId: row.organization_id,
      actualCostAtomic: String(row.actual_cost_atomic),
      payment: row.payment_json,
      recordedAt: row.recorded_at,
    };
    if (!sameEvidence(prior, evidence)) throw new Error("PAYMENT_EVIDENCE_CONFLICT");
  }

  async get(organizationId: string, requestId: string): Promise<PaymentEvidence | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{
      organization_id: string;
      request_id: string;
      actual_cost_atomic: string;
      payment_json: unknown;
      recorded_at: string;
    }>(
      `SELECT organization_id, request_id, actual_cost_atomic, payment_json, recorded_at
       FROM fuse_payment_evidence
       WHERE organization_id = $1 AND request_id = $2`,
      [organizationId, requestId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      requestId: row.request_id,
      organizationId: row.organization_id,
      actualCostAtomic: String(row.actual_cost_atomic),
      payment: row.payment_json,
      recordedAt: row.recorded_at,
    };
  }

  async listForRequests(organizationId: string, requestIds: string[]): Promise<PaymentEvidence[]> {
    if (requestIds.length === 0) return [];
    await this.ensureSchema();
    const result = await this.pool.query<{
      organization_id: string;
      request_id: string;
      actual_cost_atomic: string;
      payment_json: unknown;
      recorded_at: string;
    }>(
      `SELECT organization_id, request_id, actual_cost_atomic, payment_json, recorded_at
       FROM fuse_payment_evidence
       WHERE organization_id = $1 AND request_id = ANY($2::text[])`,
      [organizationId, requestIds],
    );
    return result.rows.map((row) => ({
      requestId: row.request_id,
      organizationId: row.organization_id,
      actualCostAtomic: String(row.actual_cost_atomic),
      payment: row.payment_json,
      recordedAt: row.recorded_at,
    }));
  }
}
