export const REPLAY_AUDITED_TABLES = [
  "inference_executions", "policy_decisions", "control_mandates", "mandate_branches",
  "reconciliation_resolutions", "mandate_reconciliation_holds", "shadow_evaluation_queue",
  "shadow_evaluations", "shadow_cohort_counters",
  "reliability_protocol_controls", "reliability_protocol_lanes", "reliability_sealed_calls",
  "reliability_block_claims", "reliability_protocol_attempts", "reliability_protocol_events",
  "reliability_dispatch_tokens", "reliability_burst_barriers", "reliability_protocol_holds",
  "reliability_hold_members", "reliability_setup_readiness_receipts",
  "reliability_authorization_operations",
  "reliability_authorization_nonces", "reliability_authorization_decisions",
  "reliability_authorization_outbox", "reliability_reconciliation_attempts",
  "reliability_reconciliation_evidence", "reliability_scheduler_claims",
  "reliability_replay_cancellations", "reliability_artifact_bindings", "reliability_final_report_outbox",
  "reliability_report_publication_outbox", "reliability_report_publication_events", "reliability_report_publication_receipts",
  "reliability_settlement_journal", "reliability_settlement_final_snapshots",
] as const;

export interface ReplayAuditCatalogClient {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

function assertAuditedTables(tables: readonly string[]): void {
  const allowed = new Set<string>(REPLAY_AUDITED_TABLES);
  if (!tables.length || tables.some((table) => !allowed.has(table))) {
    throw new Error("REPLAY_AUDIT_TABLE_SET_INVALID");
  }
}

export function replayAuditTriggerSql(tables: readonly string[] = REPLAY_AUDITED_TABLES): string {
  assertAuditedTables(tables);
  return tables.map((table) => `
DO $audit$
BEGIN
 IF to_regclass(current_schema() || '.${table}') IS NOT NULL THEN
   DROP TRIGGER IF EXISTS reliability_replay_audit_${table} ON ${table};
   CREATE TRIGGER reliability_replay_audit_${table}
     AFTER INSERT OR UPDATE OR DELETE ON ${table}
     FOR EACH ROW EXECUTE FUNCTION reliability_capture_replay_write();
 END IF;
END $audit$;`).join("\n");
}

const replayAuditTriggersSql = replayAuditTriggerSql();

/** Re-run after any ordinary schema bootstrap so tables created later receive coverage. */
export async function installReplayAuditTriggers(
  client: ReplayAuditCatalogClient,
  tables: readonly string[] = REPLAY_AUDITED_TABLES,
): Promise<void> {
  await client.query(replayAuditTriggerSql(tables));
}

/** Refuse protocol readiness unless every audited table that exists has the exact trigger. */
export async function verifyReplayAuditTriggerCatalog(
  client: ReplayAuditCatalogClient,
  tables: readonly string[] = REPLAY_AUDITED_TABLES,
): Promise<void> {
  assertAuditedTables(tables);
  const result = await client.query(`SELECT table_class.relname AS table_name
    FROM pg_catalog.pg_class table_class
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid=table_class.relnamespace
    JOIN pg_catalog.pg_trigger trigger ON trigger.tgrelid=table_class.oid
    JOIN pg_catalog.pg_proc function ON function.oid=trigger.tgfoid
    WHERE namespace.nspname=current_schema()
      AND table_class.relname = ANY($1::text[])
      AND trigger.tgname=('reliability_replay_audit_' || table_class.relname)
      AND function.proname='reliability_capture_replay_write'
      AND NOT trigger.tgisinternal`, [tables]);
  const covered = new Set(result.rows.map((row) => String(row["table_name"])));
  const missing = tables.filter((table) => !covered.has(table));
  if (missing.length) throw new Error(`REPLAY_AUDIT_TRIGGER_COVERAGE_INCOMPLETE:${missing.sort().join(",")}`);
}

export const RELIABILITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reliability_protocol_controls (
 run_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('preparing','active','failed','complete')),
 durable_stage TEXT NOT NULL DEFAULT 'running' CHECK(durable_stage IN ('running','fresh_terminal','replay_terminal','artifact_bound','settled','final_committed')),
 plan_fingerprint TEXT NOT NULL,
 protocol_version SMALLINT NOT NULL DEFAULT 2,
 evidence_type TEXT NOT NULL DEFAULT 'held-out-reliability',
 plan_schema_version SMALLINT NOT NULL DEFAULT 2,
 mapping_version SMALLINT NOT NULL DEFAULT 2,
 profile_fingerprint TEXT NOT NULL DEFAULT 'legacy-v2',
 failure_sequence BIGINT NOT NULL DEFAULT 0,
 next_event_sequence BIGINT NOT NULL DEFAULT 1, next_incident_sequence BIGINT NOT NULL DEFAULT 1,
 next_report_intent_sequence BIGINT NOT NULL DEFAULT 1,
 nonusable_allowance_owner TEXT, dispatch_token_count INTEGER NOT NULL DEFAULT 0,
 gate_classification_count INTEGER NOT NULL DEFAULT 0, ambiguity_count INTEGER NOT NULL DEFAULT 0,
 usable_count INTEGER NOT NULL DEFAULT 0, replay_passed_count INTEGER NOT NULL DEFAULT 0,
 reconciliation_credential_id TEXT, failed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS protocol_version SMALLINT NOT NULL DEFAULT 2;
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS evidence_type TEXT NOT NULL DEFAULT 'held-out-reliability';
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS plan_schema_version SMALLINT NOT NULL DEFAULT 2;
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS mapping_version SMALLINT NOT NULL DEFAULT 2;
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS profile_fingerprint TEXT NOT NULL DEFAULT 'legacy-v2';
CREATE TABLE IF NOT EXISTS reliability_protocol_lanes (
 run_id TEXT NOT NULL REFERENCES reliability_protocol_controls(run_id) ON DELETE CASCADE, lane_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'ready', resume_at TIMESTAMPTZ, allowance_owner TEXT,
 PRIMARY KEY(run_id,lane_id)
);
CREATE TABLE IF NOT EXISTS reliability_sealed_calls (
 run_id TEXT NOT NULL, request_id TEXT NOT NULL, block_no SMALLINT NOT NULL, lane_id TEXT NOT NULL,
 call_ordinal SMALLINT NOT NULL, body_commitment TEXT NOT NULL, organization_id TEXT NOT NULL,
 agent_id TEXT NOT NULL, credential_id TEXT NOT NULL, mandate_id TEXT NOT NULL, branch_id TEXT NOT NULL, workload_class TEXT NOT NULL,
 provider TEXT NOT NULL, model TEXT NOT NULL, max_output_tokens INTEGER NOT NULL,
 reservation_cost_micros BIGINT NOT NULL, claim_fingerprint TEXT NOT NULL, request_body JSONB NOT NULL DEFAULT '{}'::jsonb,
 PRIMARY KEY(run_id,request_id), UNIQUE(run_id,block_no,lane_id,call_ordinal),
 FOREIGN KEY(run_id,lane_id) REFERENCES reliability_protocol_lanes(run_id,lane_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS reliability_block_claims (
 run_id TEXT NOT NULL, lane_id TEXT, block_no SMALLINT NOT NULL, owner_id TEXT NOT NULL,
 opens_at TIMESTAMPTZ NOT NULL, launch_deadline TIMESTAMPTZ NOT NULL, claimed_at TIMESTAMPTZ NOT NULL,
 plan_fingerprint TEXT, state TEXT NOT NULL DEFAULT 'claimed', PRIMARY KEY(run_id,block_no)
);
CREATE TABLE IF NOT EXISTS reliability_protocol_attempts (
 run_id TEXT NOT NULL, request_id TEXT NOT NULL, lane_id TEXT NOT NULL, block_no SMALLINT NOT NULL,
 state TEXT NOT NULL, request_commitment TEXT NOT NULL, response_commitment TEXT, provider_generation_id TEXT,
 reserved_cost_micros BIGINT NOT NULL, actual_cost_micros BIGINT, ambiguity_entered_at TIMESTAMPTZ,
 admission_started_at TIMESTAMPTZ, gate_classified_at TIMESTAMPTZ, terminal_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,request_id), FOREIGN KEY(run_id,lane_id) REFERENCES reliability_protocol_lanes(run_id,lane_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS reliability_protocol_events (
 run_id TEXT NOT NULL, event_sequence BIGINT NOT NULL, request_id TEXT, event_type TEXT NOT NULL,
 payload JSONB NOT NULL DEFAULT '{}'::jsonb, occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,event_sequence)
);
CREATE TABLE IF NOT EXISTS reliability_dispatch_tokens (
 run_id TEXT NOT NULL, request_id TEXT NOT NULL, token_id UUID NOT NULL, lane_id TEXT NOT NULL,
 owner_id TEXT NOT NULL, primitive_entered_at TIMESTAMPTZ, canceled_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,request_id), UNIQUE(run_id,token_id), FOREIGN KEY(run_id,request_id) REFERENCES reliability_protocol_attempts(run_id,request_id)
);
CREATE TABLE IF NOT EXISTS reliability_scheduler_claims (
 run_id TEXT NOT NULL, request_id TEXT NOT NULL, lane_id TEXT NOT NULL, block_no SMALLINT NOT NULL,
 owner_id TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL
   CHECK(state IN ('claimed','admission_started','awaiting_outcome','terminal')),
 claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), lease_expires_at TIMESTAMPTZ NOT NULL,
 heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), manifest_path TEXT NOT NULL,
 manifest_digest TEXT, manifest_fsynced_at TIMESTAMPTZ, terminal_at TIMESTAMPTZ,
 PRIMARY KEY(run_id,request_id),
 FOREIGN KEY(run_id,request_id) REFERENCES reliability_protocol_attempts(run_id,request_id)
);
CREATE TABLE IF NOT EXISTS reliability_burst_barriers (
 run_id TEXT NOT NULL, lane_id TEXT NOT NULL, block_no SMALLINT NOT NULL, state TEXT NOT NULL,
 planned_request_ids JSONB NOT NULL, released_at TIMESTAMPTZ, canceled_at TIMESTAMPTZ,
 PRIMARY KEY(run_id,lane_id,block_no), FOREIGN KEY(run_id,lane_id) REFERENCES reliability_protocol_lanes(run_id,lane_id)
);
CREATE TABLE IF NOT EXISTS reliability_protocol_holds (
 run_id TEXT NOT NULL, lane_id TEXT NOT NULL, hold_id UUID NOT NULL, held_unresolved JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), resolved_at TIMESTAMPTZ,
 PRIMARY KEY(run_id,lane_id,hold_id), FOREIGN KEY(run_id,lane_id) REFERENCES reliability_protocol_lanes(run_id,lane_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS reliability_one_open_hold_per_lane ON reliability_protocol_holds(run_id,lane_id) WHERE resolved_at IS NULL;
CREATE TABLE IF NOT EXISTS reliability_hold_members (
 run_id TEXT NOT NULL, lane_id TEXT NOT NULL, hold_id UUID NOT NULL, request_id TEXT NOT NULL,
 member_sequence BIGINT NOT NULL, member_state TEXT NOT NULL DEFAULT 'ordinary_inflight'
   CHECK(member_state IN ('ordinary_inflight','reconciliation_pending')), resolved_at TIMESTAMPTZ,
 PRIMARY KEY(run_id,lane_id,hold_id,request_id), UNIQUE(run_id,lane_id,hold_id,member_sequence),
 FOREIGN KEY(run_id,lane_id,hold_id) REFERENCES reliability_protocol_holds(run_id,lane_id,hold_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS reliability_lane_backlog (
 run_id TEXT NOT NULL, lane_id TEXT NOT NULL, block_no SMALLINT NOT NULL, call_ordinal SMALLINT NOT NULL,
 request_id TEXT NOT NULL, nominal_scheduled_at TIMESTAMPTZ NOT NULL, actual_scheduled_at TIMESTAMPTZ,
 pause_duration_seconds BIGINT, state TEXT NOT NULL DEFAULT 'queued'
   CHECK(state IN ('queued','scheduled','claimed','terminal','canceled')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), claimed_at TIMESTAMPTZ, terminal_at TIMESTAMPTZ,
 PRIMARY KEY(run_id,lane_id,block_no,call_ordinal), UNIQUE(run_id,request_id),
 FOREIGN KEY(run_id,request_id) REFERENCES reliability_sealed_calls(run_id,request_id)
);
CREATE TABLE IF NOT EXISTS reliability_authorization_operations (
 run_id TEXT PRIMARY KEY REFERENCES reliability_protocol_controls(run_id),
 started_at TIMESTAMPTZ NOT NULL, validation_deadline TIMESTAMPTZ NOT NULL,
 decision_deadline TIMESTAMPTZ NOT NULL, publication_deadline TIMESTAMPTZ NOT NULL,
 transition_deadline TIMESTAMPTZ NOT NULL, publication_completed_at TIMESTAMPTZ,
 transition_completed_at TIMESTAMPTZ, failure_reason TEXT,
 CHECK(validation_deadline=started_at+interval '5 seconds'),
 CHECK(decision_deadline=started_at+interval '20 seconds'),
 CHECK(publication_deadline=started_at+interval '50 seconds'),
 CHECK(transition_deadline=started_at+interval '55 seconds')
);
CREATE TABLE IF NOT EXISTS reliability_authorization_nonces (
 issuer_id TEXT NOT NULL, nonce TEXT NOT NULL, run_id TEXT NOT NULL, consumed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(issuer_id,nonce), UNIQUE(run_id)
);
CREATE TABLE IF NOT EXISTS reliability_authorization_decisions (
 run_id TEXT PRIMARY KEY REFERENCES reliability_protocol_controls(run_id), decision_id UUID NOT NULL UNIQUE,
 verdict JSONB NOT NULL, operator_nonce TEXT, decided_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS reliability_authorization_outbox (
 run_id TEXT NOT NULL, receipt_kind TEXT NOT NULL CHECK(receipt_kind IN ('operator','reconciliation')),
 receipt JSONB NOT NULL, published_at TIMESTAMPTZ,
 PRIMARY KEY(run_id,receipt_kind), FOREIGN KEY(run_id) REFERENCES reliability_authorization_decisions(run_id)
);
CREATE TABLE IF NOT EXISTS reliability_reconciliation_attempts (
 run_id TEXT NOT NULL, request_id TEXT NOT NULL, offset_seconds INTEGER NOT NULL, phase TEXT NOT NULL,
 scheduled_at TIMESTAMPTZ NOT NULL, evidence_cutoff TIMESTAMPTZ NOT NULL, classification_deadline TIMESTAMPTZ NOT NULL,
 credential_id TEXT, authorization_sha256 TEXT, authorized_at TIMESTAMPTZ,
 lookup_started_at TIMESTAMPTZ, lookup_finished_at TIMESTAMPTZ, failure_code TEXT,
 started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, canceled_at TIMESTAMPTZ,
 PRIMARY KEY(run_id,request_id,offset_seconds)
);
CREATE TABLE IF NOT EXISTS reliability_reconciliation_evidence (
 run_id TEXT NOT NULL, request_id TEXT NOT NULL, offset_seconds INTEGER NOT NULL,
 metadata JSONB NOT NULL, content JSONB NOT NULL, disposition TEXT NOT NULL,
 credential_id TEXT, generation_id TEXT, accepted BOOLEAN NOT NULL DEFAULT false,
 conflict BOOLEAN NOT NULL DEFAULT false, reason TEXT, accepted_binding JSONB,
 committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(run_id,request_id,offset_seconds),
 FOREIGN KEY(run_id,request_id,offset_seconds) REFERENCES reliability_reconciliation_attempts(run_id,request_id,offset_seconds)
);
CREATE TABLE IF NOT EXISTS reliability_setup_readiness_receipts (
 run_id TEXT PRIMARY KEY REFERENCES reliability_protocol_controls(run_id) ON DELETE CASCADE,
 expected_snapshot JSONB NOT NULL, actual_snapshot JSONB NOT NULL, differing_fields JSONB NOT NULL,
 snapshot_digest TEXT NOT NULL, ready BOOLEAN NOT NULL, checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS reliability_replay_authorizations (
 run_id TEXT NOT NULL, replay_ordinal SMALLINT NOT NULL CHECK(replay_ordinal BETWEEN 1 AND 20),
 request_id TEXT NOT NULL, operation_id TEXT NOT NULL, authorization_decision_id UUID NOT NULL,
 signed_authorization_sha256 TEXT, state TEXT NOT NULL DEFAULT 'authorized'
   CHECK(state IN ('authorized','transport_started','passed','failed')),
 transport_started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, response_projection JSONB,
 PRIMARY KEY(run_id,request_id), UNIQUE(run_id,replay_ordinal), UNIQUE(operation_id),
 FOREIGN KEY(run_id,request_id) REFERENCES reliability_sealed_calls(run_id,request_id),
 FOREIGN KEY(authorization_decision_id) REFERENCES reliability_authorization_decisions(decision_id)
);
ALTER TABLE reliability_replay_authorizations ALTER COLUMN signed_authorization_sha256 DROP NOT NULL;
CREATE TABLE IF NOT EXISTS reliability_replay_mutex (
 run_id TEXT PRIMARY KEY, request_id TEXT, owner_id TEXT NOT NULL, operation_id TEXT,
 acquired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS reliability_replay_audits (
 run_id TEXT NOT NULL, request_id TEXT NOT NULL, replay_no SMALLINT NOT NULL, original_response_commitment TEXT NOT NULL,
 replay_response_commitment TEXT NOT NULL, write_set JSONB NOT NULL, audited_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,request_id,replay_no)
);
CREATE TABLE IF NOT EXISTS reliability_replay_write_audit (
 audit_id BIGSERIAL PRIMARY KEY, operation_id TEXT NOT NULL, table_name TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')), row_identity TEXT NOT NULL,
 audited_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS reliability_replay_write_audit_operation_idx
 ON reliability_replay_write_audit(operation_id,audit_id);
CREATE OR REPLACE FUNCTION reliability_capture_replay_write() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE replay_operation TEXT;
DECLARE identity JSONB;
BEGIN
 replay_operation := current_setting('fuse.replay_operation_id', true);
 IF replay_operation IS NULL OR replay_operation = '' THEN
   RETURN COALESCE(NEW, OLD);
 END IF;
 identity := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 INSERT INTO reliability_replay_write_audit(operation_id,table_name,operation,row_identity)
 VALUES(replay_operation,TG_TABLE_NAME,TG_OP,identity::text);
 RETURN COALESCE(NEW, OLD);
END $function$;
CREATE TABLE IF NOT EXISTS reliability_protocol_incidents (
 run_id TEXT NOT NULL, incident_sequence BIGINT NOT NULL, event_type TEXT NOT NULL, evidence JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(run_id,incident_sequence)
);
CREATE TABLE IF NOT EXISTS reliability_settlement_journal (
 run_id TEXT NOT NULL, poll_no SMALLINT NOT NULL, offset_seconds INTEGER NOT NULL, snapshot_digest TEXT,
 complete BOOLEAN NOT NULL, scheduled_at TIMESTAMPTZ, started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 query_finished_at TIMESTAMPTZ, deadline_eligible BOOLEAN NOT NULL DEFAULT false, row_cardinality INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, PRIMARY KEY(run_id,poll_no)
);
CREATE TABLE IF NOT EXISTS reliability_settlement_final_snapshots (
 run_id TEXT PRIMARY KEY, snapshot_digest TEXT, journal_cardinality SMALLINT NOT NULL,
 accepted_offset_seconds INTEGER, row_cardinality INTEGER NOT NULL DEFAULT 0, passed BOOLEAN NOT NULL DEFAULT false,
 accepted_database_started_at TIMESTAMPTZ, snapshot_rows JSONB,
 committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS reliability_replay_cancellations (
 run_id TEXT NOT NULL, replay_no SMALLINT NOT NULL CHECK(replay_no BETWEEN 1 AND 20), request_id TEXT NOT NULL,
 reason TEXT NOT NULL, canceled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(run_id,replay_no)
);
CREATE TABLE IF NOT EXISTS reliability_artifact_bindings (
 run_id TEXT NOT NULL REFERENCES reliability_protocol_controls(run_id) ON DELETE CASCADE,
 path TEXT NOT NULL, digest TEXT NOT NULL CHECK(digest ~ '^sha256:[a-f0-9]{64}$'),
 bound_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(run_id,path)
);
CREATE TABLE IF NOT EXISTS reliability_final_report_outbox (
 run_id TEXT PRIMARY KEY REFERENCES reliability_protocol_controls(run_id) ON DELETE CASCADE,
 canonical_path TEXT NOT NULL, report_bytes TEXT NOT NULL, report_digest TEXT NOT NULL,
 published_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS reliability_failure_report_outbox (
 run_id TEXT PRIMARY KEY, report_intent JSONB NOT NULL, publication_items JSONB NOT NULL DEFAULT '[]'::jsonb,
 publish_by TIMESTAMPTZ, published_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(run_id) REFERENCES reliability_protocol_controls(run_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS reliability_report_publication_outbox (
 run_id TEXT NOT NULL REFERENCES reliability_protocol_controls(run_id) ON DELETE CASCADE,
 intent_sequence BIGINT NOT NULL,
 profile_fingerprint TEXT NOT NULL,
 report_kind TEXT NOT NULL CHECK(report_kind IN ('pass','failure')),
 destination TEXT NOT NULL,
 report_sha256 TEXT NOT NULL CHECK(report_sha256 ~ '^sha256:[a-f0-9]{64}$'),
 report_bytes_base64 TEXT NOT NULL,
 intent_path TEXT NOT NULL,
 intent_sha256 TEXT NOT NULL CHECK(intent_sha256 ~ '^sha256:[a-f0-9]{64}$'),
 intent_bytes_base64 TEXT NOT NULL,
 artifact_inventory_sha256 TEXT NOT NULL CHECK(artifact_inventory_sha256 ~ '^sha256:[a-f0-9]{64}$'),
 accepted_snapshot_sha256 TEXT CHECK(accepted_snapshot_sha256 IS NULL OR accepted_snapshot_sha256 ~ '^sha256:[a-f0-9]{64}$'),
 committed_at TIMESTAMPTZ NOT NULL,
 publication_deadline TIMESTAMPTZ NOT NULL,
 supersedes_intent_sequence BIGINT,
 next_event_sequence BIGINT NOT NULL DEFAULT 1,
 state TEXT NOT NULL DEFAULT 'committed' CHECK(state IN ('committed','published','superseded','publication_failed','artifact_conflict')),
 PRIMARY KEY(run_id,intent_sequence),
 UNIQUE(run_id,destination,intent_sequence),
 FOREIGN KEY(run_id,supersedes_intent_sequence) REFERENCES reliability_report_publication_outbox(run_id,intent_sequence)
);
CREATE TABLE IF NOT EXISTS reliability_report_publication_events (
 run_id TEXT NOT NULL, intent_sequence BIGINT NOT NULL, event_sequence BIGINT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('committed','published','superseded','publication_failed','artifact_conflict')),
 evidence JSONB NOT NULL DEFAULT '{}'::jsonb, occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,intent_sequence,event_sequence),
 FOREIGN KEY(run_id,intent_sequence) REFERENCES reliability_report_publication_outbox(run_id,intent_sequence)
);
CREATE TABLE IF NOT EXISTS reliability_report_publication_receipts (
 run_id TEXT NOT NULL, intent_sequence BIGINT NOT NULL, destination TEXT NOT NULL,
 report_sha256 TEXT NOT NULL, intent_path TEXT NOT NULL, intent_sha256 TEXT NOT NULL, filesystem_completed_at TIMESTAMPTZ NOT NULL,
 committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,intent_sequence),
 FOREIGN KEY(run_id,intent_sequence) REFERENCES reliability_report_publication_outbox(run_id,intent_sequence)
);

-- Idempotent forward migrations are intentionally kept in the bootstrap SQL.  Early
-- no-spend tests created older table shapes in Neon; CREATE TABLE IF NOT EXISTS does
-- not upgrade those tables.
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS next_event_sequence BIGINT NOT NULL DEFAULT 1;
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS next_incident_sequence BIGINT NOT NULL DEFAULT 1;
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS next_report_intent_sequence BIGINT NOT NULL DEFAULT 1;
ALTER TABLE reliability_report_publication_outbox ADD COLUMN IF NOT EXISTS next_event_sequence BIGINT NOT NULL DEFAULT 1;
ALTER TABLE reliability_report_publication_outbox ADD COLUMN IF NOT EXISTS intent_path TEXT;
ALTER TABLE reliability_report_publication_outbox ADD COLUMN IF NOT EXISTS intent_sha256 TEXT;
ALTER TABLE reliability_report_publication_outbox ADD COLUMN IF NOT EXISTS intent_bytes_base64 TEXT;
ALTER TABLE reliability_report_publication_receipts ADD COLUMN IF NOT EXISTS intent_path TEXT;
ALTER TABLE reliability_report_publication_receipts ADD COLUMN IF NOT EXISTS intent_sha256 TEXT;
ALTER TABLE reliability_report_publication_outbox DROP CONSTRAINT IF EXISTS reliability_report_publication_outbox_state_check;
ALTER TABLE reliability_report_publication_outbox ADD CONSTRAINT reliability_report_publication_outbox_state_check CHECK(state IN ('committed','published','superseded','publication_failed','artifact_conflict'));
ALTER TABLE reliability_report_publication_events DROP CONSTRAINT IF EXISTS reliability_report_publication_events_state_check;
ALTER TABLE reliability_report_publication_events ADD CONSTRAINT reliability_report_publication_events_state_check CHECK(state IN ('committed','published','superseded','publication_failed','artifact_conflict'));
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS nonusable_allowance_owner TEXT;
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS dispatch_token_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS gate_classification_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS ambiguity_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS usable_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS replay_passed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS reconciliation_credential_id TEXT;
ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS durable_stage TEXT NOT NULL DEFAULT 'running';
ALTER TABLE reliability_failure_report_outbox ADD COLUMN IF NOT EXISTS publication_items JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE reliability_failure_report_outbox ADD COLUMN IF NOT EXISTS publish_by TIMESTAMPTZ;
ALTER TABLE reliability_sealed_calls ADD COLUMN IF NOT EXISTS credential_id TEXT;
ALTER TABLE reliability_sealed_calls ADD COLUMN IF NOT EXISTS request_body JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE reliability_replay_mutex ADD COLUMN IF NOT EXISTS operation_id TEXT;
ALTER TABLE reliability_replay_authorizations ADD COLUMN IF NOT EXISTS response_projection JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS reliability_replay_mutex_operation_idx ON reliability_replay_mutex(operation_id) WHERE operation_id IS NOT NULL;
ALTER TABLE reliability_protocol_attempts ADD COLUMN IF NOT EXISTS ambiguity_entered_at TIMESTAMPTZ;
ALTER TABLE reliability_protocol_attempts ADD COLUMN IF NOT EXISTS admission_started_at TIMESTAMPTZ;
ALTER TABLE reliability_protocol_attempts ADD COLUMN IF NOT EXISTS gate_classified_at TIMESTAMPTZ;
ALTER TABLE reliability_protocol_attempts ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ;
ALTER TABLE reliability_block_claims ADD COLUMN IF NOT EXISTS plan_fingerprint TEXT;
ALTER TABLE reliability_burst_barriers ADD COLUMN IF NOT EXISTS planned_request_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE reliability_burst_barriers ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
ALTER TABLE reliability_hold_members ADD COLUMN IF NOT EXISTS member_state TEXT NOT NULL DEFAULT 'ordinary_inflight';
ALTER TABLE reliability_reconciliation_attempts ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE reliability_reconciliation_attempts ADD COLUMN IF NOT EXISTS evidence_cutoff TIMESTAMPTZ;
ALTER TABLE reliability_reconciliation_attempts ADD COLUMN IF NOT EXISTS classification_deadline TIMESTAMPTZ;
ALTER TABLE reliability_reconciliation_attempts ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
ALTER TABLE reliability_reconciliation_attempts ADD COLUMN IF NOT EXISTS credential_id TEXT;
ALTER TABLE reliability_reconciliation_attempts ADD COLUMN IF NOT EXISTS authorization_sha256 TEXT;
ALTER TABLE reliability_reconciliation_attempts ADD COLUMN IF NOT EXISTS authorized_at TIMESTAMPTZ;
ALTER TABLE reliability_reconciliation_attempts ADD COLUMN IF NOT EXISTS lookup_started_at TIMESTAMPTZ;
ALTER TABLE reliability_reconciliation_attempts ADD COLUMN IF NOT EXISTS lookup_finished_at TIMESTAMPTZ;
ALTER TABLE reliability_reconciliation_attempts ADD COLUMN IF NOT EXISTS failure_code TEXT;
ALTER TABLE reliability_reconciliation_attempts ALTER COLUMN started_at DROP NOT NULL;
ALTER TABLE reliability_reconciliation_attempts ALTER COLUMN started_at DROP DEFAULT;
UPDATE reliability_reconciliation_attempts SET
  scheduled_at=COALESCE(scheduled_at,started_at),
  evidence_cutoff=COALESCE(evidence_cutoff,started_at + interval '86400 seconds'),
  classification_deadline=COALESCE(classification_deadline,started_at + interval '86431 seconds')
WHERE scheduled_at IS NULL OR evidence_cutoff IS NULL OR classification_deadline IS NULL;
ALTER TABLE reliability_reconciliation_attempts ALTER COLUMN scheduled_at SET NOT NULL;
ALTER TABLE reliability_reconciliation_attempts ALTER COLUMN evidence_cutoff SET NOT NULL;
ALTER TABLE reliability_reconciliation_attempts ALTER COLUMN classification_deadline SET NOT NULL;
ALTER TABLE reliability_reconciliation_evidence ADD COLUMN IF NOT EXISTS credential_id TEXT;
ALTER TABLE reliability_reconciliation_evidence ADD COLUMN IF NOT EXISTS generation_id TEXT;
ALTER TABLE reliability_reconciliation_evidence ADD COLUMN IF NOT EXISTS accepted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE reliability_reconciliation_evidence ADD COLUMN IF NOT EXISTS conflict BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE reliability_reconciliation_evidence ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE reliability_reconciliation_evidence ADD COLUMN IF NOT EXISTS accepted_binding JSONB;
ALTER TABLE reliability_settlement_journal ALTER COLUMN snapshot_digest DROP NOT NULL;
ALTER TABLE reliability_settlement_journal ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE reliability_settlement_journal ADD COLUMN IF NOT EXISTS query_finished_at TIMESTAMPTZ;
ALTER TABLE reliability_settlement_journal ADD COLUMN IF NOT EXISTS deadline_eligible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE reliability_settlement_journal ADD COLUMN IF NOT EXISTS row_cardinality INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reliability_settlement_journal ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE reliability_settlement_final_snapshots ADD COLUMN IF NOT EXISTS row_cardinality INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reliability_settlement_final_snapshots ADD COLUMN IF NOT EXISTS passed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE reliability_settlement_final_snapshots ADD COLUMN IF NOT EXISTS accepted_database_started_at TIMESTAMPTZ;
ALTER TABLE reliability_settlement_final_snapshots ADD COLUMN IF NOT EXISTS snapshot_rows JSONB;
ALTER TABLE reliability_settlement_final_snapshots ALTER COLUMN snapshot_digest DROP NOT NULL;
ALTER TABLE reliability_scheduler_claims ADD COLUMN IF NOT EXISTS generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reliability_scheduler_claims ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE reliability_scheduler_claims ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
ALTER TABLE reliability_scheduler_claims ADD COLUMN IF NOT EXISTS manifest_path TEXT;
ALTER TABLE reliability_scheduler_claims ADD COLUMN IF NOT EXISTS manifest_digest TEXT;
ALTER TABLE reliability_scheduler_claims ADD COLUMN IF NOT EXISTS manifest_fsynced_at TIMESTAMPTZ;
ALTER TABLE reliability_scheduler_claims ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS reliability_one_block_claim_per_run_block ON reliability_block_claims(run_id,block_no);
CREATE UNIQUE INDEX IF NOT EXISTS reliability_one_replay_mutex_per_run ON reliability_replay_mutex(run_id);
${replayAuditTriggersSql}
`;
