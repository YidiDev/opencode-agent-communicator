import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  managedSessionsPerWorkspaceHardCeiling,
  startOperationsPerWorkspaceHardCeiling,
  startOperationsRecoveryHardCeiling,
  startPayloadBytesPerWorkspaceHardCeiling,
  startRateEventsPerWorkspaceHardCeiling,
  submittingRequestsPerWorkspaceHardCeiling,
  unresolvedStartProvenancePerWorkspaceHardCeiling,
} from "../../domain/safety-ceilings";
import { StoreIntegrityError, StoreSecurityError } from "./store-types";

interface Migration {
  readonly version: number;
  readonly checksum: string;
  readonly sql: string;
  readonly downSql: string;
}

/** The exact, platform-independent byte representation covered by migration checksums. */
export function canonicalMigrationSql(sql: string): string {
  return `${sql.replaceAll("\r\n", "\n").trim()}\n`;
}

export function migrationSqlChecksum(sql: string): string {
  return `sha256:${createHash("sha256").update(canonicalMigrationSql(sql), "utf8").digest("hex")}`;
}

export const sqliteStoreMigrations: readonly Migration[] = [
  {
    version: 1,
    checksum: "sha256:929ff898b24a6bfefa276939fee895e41185ed9c58bd59c3f2c3359f4daa8a86",
    sql: `
CREATE TABLE ownership (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  acquired_wall_ms INTEGER NOT NULL CHECK (acquired_wall_ms >= 0),
  renewed_wall_ms INTEGER NOT NULL CHECK (renewed_wall_ms >= acquired_wall_ms),
  expires_wall_ms INTEGER NOT NULL CHECK (expires_wall_ms > renewed_wall_ms)
) STRICT;
CREATE TABLE workspaces (
  workspace_key TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT, WITHOUT ROWID;
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  workspace_key TEXT NOT NULL REFERENCES workspaces(workspace_key) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  native_message_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','submitting','admission_unknown','admitted','promoted','failed','cancelled')),
  prepared_envelope TEXT,
  content_byte_length INTEGER NOT NULL CHECK (content_byte_length BETWEEN 0 AND 32768),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  submitted_at_ms INTEGER,
  admission_unknown_at_ms INTEGER,
  admitted_at_ms INTEGER,
  promoted_at_ms INTEGER,
  failed_at_ms INTEGER,
  cancelled_at_ms INTEGER,
  claimed_fencing_token INTEGER CHECK (claimed_fencing_token >= 1),
  admitted_seq INTEGER CHECK (admitted_seq >= 0),
  promoted_seq INTEGER,
  evidence_observed_at_ms INTEGER,
  CHECK ((state = 'prepared') = (prepared_envelope IS NOT NULL)),
  CHECK ((state IN ('submitting','admission_unknown','admitted','promoted','failed')) = (submitted_at_ms IS NOT NULL)),
  CHECK ((state = 'admission_unknown') = (admission_unknown_at_ms IS NOT NULL)),
  CHECK ((state IN ('admitted','promoted')) = (admitted_at_ms IS NOT NULL)),
  CHECK ((state = 'promoted') = (promoted_at_ms IS NOT NULL)),
  CHECK ((state = 'failed') = (failed_at_ms IS NOT NULL)),
  CHECK ((state = 'cancelled') = (cancelled_at_ms IS NOT NULL)),
  CHECK ((state IN ('submitting','admission_unknown','admitted','promoted','failed')) = (claimed_fencing_token IS NOT NULL)),
  CHECK ((state IN ('admitted','promoted')) = (admitted_seq IS NOT NULL)),
  CHECK ((state = 'promoted') = (promoted_seq IS NOT NULL)),
  CHECK ((state IN ('admitted','promoted')) = (evidence_observed_at_ms IS NOT NULL)),
  CHECK (promoted_seq IS NULL OR promoted_seq > admitted_seq)
) STRICT, WITHOUT ROWID;
CREATE TABLE delivery_rate_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;
CREATE INDEX deliveries_workspace_created ON deliveries(workspace_key, created_at_ms);
CREATE INDEX deliveries_source_created ON deliveries(workspace_key, source_session_id, created_at_ms);
CREATE INDEX deliveries_target_created ON deliveries(workspace_key, target_session_id, created_at_ms);
CREATE INDEX deliveries_recovery ON deliveries(workspace_key, state, claimed_fencing_token, created_at_ms);
CREATE INDEX delivery_rate_workspace ON delivery_rate_events(workspace_key, occurred_at_ms);
CREATE INDEX delivery_rate_source ON delivery_rate_events(workspace_key, source_session_id, occurred_at_ms);
CREATE INDEX delivery_rate_target ON delivery_rate_events(workspace_key, target_session_id, occurred_at_ms);
`,
    downSql: `
DROP TABLE delivery_rate_events;
DROP TABLE deliveries;
DROP TABLE workspaces;
DROP TABLE ownership;
`,
  },
  {
    version: 2,
    checksum: "sha256:01fd21d54481dc3dffea01f46da930815a5bed8f145d31397f0049d446d4e096",
    sql: `CREATE UNIQUE INDEX deliveries_native_message ON deliveries(workspace_key, native_message_id);`,
    downSql: `DROP INDEX deliveries_native_message;`,
  },
  {
    version: 3,
    checksum: "sha256:cd0aae4f4eb012325f46a511194a4b42f34f2009a059a9ed0b130e32f41b1d84",
    sql: `
ALTER TABLE ownership ADD COLUMN owner_label TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE ownership ADD COLUMN released_wall_ms INTEGER CHECK (released_wall_ms IS NULL OR released_wall_ms >= 0);
UPDATE ownership SET owner_label = owner_id WHERE owner_label = 'legacy';
ALTER TABLE ownership RENAME TO ownership_v2;
CREATE TABLE ownership_new (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_id TEXT NOT NULL CHECK (
    length(owner_id) BETWEEN 32 AND 36 AND owner_id NOT GLOB '*[^0-9a-f-]*'
  ),
  fencing_token INTEGER NOT NULL CHECK (fencing_token BETWEEN 1 AND 9007199254740991),
  acquired_wall_ms INTEGER NOT NULL CHECK (acquired_wall_ms BETWEEN 0 AND 9007199254740991),
  renewed_wall_ms INTEGER NOT NULL CHECK (
    renewed_wall_ms BETWEEN acquired_wall_ms AND 9007199254740991
  ),
  expires_wall_ms INTEGER NOT NULL CHECK (
    expires_wall_ms BETWEEN renewed_wall_ms + 1 AND 9007199254740991
  ),
  owner_label TEXT NOT NULL CHECK (
    length(owner_label) BETWEEN 1 AND 128 AND
    substr(owner_label, 1, 1) GLOB '[A-Za-z0-9]' AND
    owner_label NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  released_wall_ms INTEGER CHECK (
    released_wall_ms IS NULL OR released_wall_ms BETWEEN acquired_wall_ms AND expires_wall_ms
  )
) STRICT;
INSERT INTO ownership_new
SELECT singleton,
  CASE
    WHEN length(owner_id) BETWEEN 32 AND 36 AND owner_id NOT GLOB '*[^0-9a-f-]*' THEN owner_id
    ELSE lower(hex(randomblob(16)))
  END,
  fencing_token, acquired_wall_ms, renewed_wall_ms, expires_wall_ms, owner_label, released_wall_ms
FROM ownership_v2;
DROP TABLE ownership_v2;
ALTER TABLE ownership_new RENAME TO ownership;
ALTER TABLE deliveries RENAME TO deliveries_v2;
ALTER TABLE workspaces RENAME TO workspaces_v2;
CREATE TABLE workspaces_new (
  workspace_key TEXT PRIMARY KEY CHECK (
    length(workspace_key) BETWEEN 1 AND 128 AND
    substr(workspace_key, 1, 1) GLOB '[A-Za-z0-9]' AND
    workspace_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT, WITHOUT ROWID;
INSERT INTO workspaces_new SELECT * FROM workspaces_v2;
ALTER TABLE workspaces_new RENAME TO workspaces;
CREATE TABLE deliveries_new (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 36 AND substr(id, 1, 4) = 'dlv_' AND
    substr(id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  workspace_key TEXT NOT NULL REFERENCES workspaces(workspace_key) ON DELETE CASCADE CHECK (
    length(workspace_key) BETWEEN 1 AND 128 AND
    substr(workspace_key, 1, 1) GLOB '[A-Za-z0-9]' AND
    workspace_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  source_session_id TEXT NOT NULL CHECK (
    length(source_session_id) BETWEEN 5 AND 132 AND substr(source_session_id, 1, 4) = 'ses_' AND
    substr(source_session_id, 5) NOT GLOB '*[^A-Za-z0-9]*'
  ),
  target_session_id TEXT NOT NULL CHECK (
    length(target_session_id) BETWEEN 5 AND 132 AND substr(target_session_id, 1, 4) = 'ses_' AND
    substr(target_session_id, 5) NOT GLOB '*[^A-Za-z0-9]*'
  ),
  native_message_id TEXT NOT NULL CHECK (
    length(native_message_id) = 36 AND substr(native_message_id, 1, 4) = 'msg_' AND
    substr(native_message_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('prepared','submitting','admission_unknown','admitted','promoted','failed','cancelled')),
  prepared_envelope TEXT CHECK (
    prepared_envelope IS NULL OR length(CAST(prepared_envelope AS BLOB)) <= 65536
  ),
  content_byte_length INTEGER NOT NULL CHECK (content_byte_length BETWEEN 0 AND 32768),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  submitted_at_ms INTEGER CHECK (
    submitted_at_ms IS NULL OR submitted_at_ms BETWEEN created_at_ms AND updated_at_ms
  ),
  admission_unknown_at_ms INTEGER CHECK (
    admission_unknown_at_ms IS NULL OR admission_unknown_at_ms BETWEEN submitted_at_ms AND updated_at_ms
  ),
  admitted_at_ms INTEGER CHECK (
    admitted_at_ms IS NULL OR admitted_at_ms BETWEEN submitted_at_ms AND updated_at_ms
  ),
  promoted_at_ms INTEGER CHECK (
    promoted_at_ms IS NULL OR promoted_at_ms BETWEEN admitted_at_ms AND updated_at_ms
  ),
  failed_at_ms INTEGER CHECK (
    failed_at_ms IS NULL OR failed_at_ms BETWEEN submitted_at_ms AND updated_at_ms
  ),
  cancelled_at_ms INTEGER CHECK (
    cancelled_at_ms IS NULL OR cancelled_at_ms BETWEEN created_at_ms AND updated_at_ms
  ),
  claimed_fencing_token INTEGER CHECK (
    claimed_fencing_token IS NULL OR claimed_fencing_token BETWEEN 1 AND 9007199254740991
  ),
  admitted_seq INTEGER CHECK (admitted_seq IS NULL OR admitted_seq BETWEEN 0 AND 9007199254740991),
  promoted_seq INTEGER CHECK (promoted_seq IS NULL OR promoted_seq BETWEEN 0 AND 9007199254740991),
  evidence_observed_at_ms INTEGER CHECK (
    evidence_observed_at_ms IS NULL OR evidence_observed_at_ms BETWEEN submitted_at_ms AND updated_at_ms
  ),
  CHECK ((state = 'prepared') = (prepared_envelope IS NOT NULL)),
  CHECK ((state IN ('submitting','admission_unknown','admitted','promoted','failed')) = (submitted_at_ms IS NOT NULL)),
  CHECK ((state = 'admission_unknown') = (admission_unknown_at_ms IS NOT NULL)),
  CHECK ((state IN ('admitted','promoted')) = (admitted_at_ms IS NOT NULL)),
  CHECK ((state = 'promoted') = (promoted_at_ms IS NOT NULL)),
  CHECK ((state = 'failed') = (failed_at_ms IS NOT NULL)),
  CHECK ((state = 'cancelled') = (cancelled_at_ms IS NOT NULL)),
  CHECK ((state IN ('submitting','admission_unknown','admitted','promoted','failed')) = (claimed_fencing_token IS NOT NULL)),
  CHECK ((state IN ('admitted','promoted')) = (admitted_seq IS NOT NULL)),
  CHECK ((state = 'promoted') = (promoted_seq IS NOT NULL)),
  CHECK ((state IN ('admitted','promoted')) = (evidence_observed_at_ms IS NOT NULL)),
  CHECK (promoted_seq IS NULL OR promoted_seq > admitted_seq)
) STRICT, WITHOUT ROWID;
INSERT INTO deliveries_new SELECT * FROM deliveries_v2;
DROP TABLE deliveries_v2;
DROP TABLE workspaces_v2;
ALTER TABLE deliveries_new RENAME TO deliveries;
CREATE INDEX deliveries_workspace_created ON deliveries(workspace_key, created_at_ms);
CREATE INDEX deliveries_source_created ON deliveries(workspace_key, source_session_id, created_at_ms);
CREATE INDEX deliveries_target_created ON deliveries(workspace_key, target_session_id, created_at_ms);
CREATE INDEX deliveries_recovery ON deliveries(workspace_key, state, claimed_fencing_token, created_at_ms);
CREATE UNIQUE INDEX deliveries_native_message ON deliveries(workspace_key, native_message_id);
ALTER TABLE delivery_rate_events RENAME TO delivery_rate_events_v2;
CREATE TABLE delivery_rate_events_new (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL CHECK (
    length(workspace_key) BETWEEN 1 AND 128 AND
    substr(workspace_key, 1, 1) GLOB '[A-Za-z0-9]' AND
    workspace_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  source_session_id TEXT NOT NULL CHECK (
    length(source_session_id) BETWEEN 5 AND 132 AND substr(source_session_id, 1, 4) = 'ses_' AND
    substr(source_session_id, 5) NOT GLOB '*[^A-Za-z0-9]*'
  ),
  target_session_id TEXT NOT NULL CHECK (
    length(target_session_id) BETWEEN 5 AND 132 AND substr(target_session_id, 1, 4) = 'ses_' AND
    substr(target_session_id, 5) NOT GLOB '*[^A-Za-z0-9]*'
  ),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT;
INSERT INTO delivery_rate_events_new SELECT * FROM delivery_rate_events_v2;
DROP TABLE delivery_rate_events_v2;
ALTER TABLE delivery_rate_events_new RENAME TO delivery_rate_events;
CREATE INDEX delivery_rate_workspace ON delivery_rate_events(workspace_key, occurred_at_ms);
CREATE INDEX delivery_rate_source ON delivery_rate_events(workspace_key, source_session_id, occurred_at_ms);
CREATE INDEX delivery_rate_target ON delivery_rate_events(workspace_key, target_session_id, occurred_at_ms);
`,
    downSql: `
ALTER TABLE deliveries RENAME TO deliveries_v3;
ALTER TABLE workspaces RENAME TO workspaces_v3;
CREATE TABLE workspaces_restore (
  workspace_key TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT, WITHOUT ROWID;
INSERT INTO workspaces_restore SELECT * FROM workspaces_v3;
CREATE TABLE deliveries_restore (
  id TEXT PRIMARY KEY,
  workspace_key TEXT NOT NULL REFERENCES workspaces_restore(workspace_key) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  native_message_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','submitting','admission_unknown','admitted','promoted','failed','cancelled')),
  prepared_envelope TEXT,
  content_byte_length INTEGER NOT NULL CHECK (content_byte_length BETWEEN 0 AND 32768),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  submitted_at_ms INTEGER,
  admission_unknown_at_ms INTEGER,
  admitted_at_ms INTEGER,
  promoted_at_ms INTEGER,
  failed_at_ms INTEGER,
  cancelled_at_ms INTEGER,
  claimed_fencing_token INTEGER CHECK (claimed_fencing_token >= 1),
  admitted_seq INTEGER CHECK (admitted_seq >= 0),
  promoted_seq INTEGER,
  evidence_observed_at_ms INTEGER,
  CHECK ((state = 'prepared') = (prepared_envelope IS NOT NULL)),
  CHECK ((state IN ('submitting','admission_unknown','admitted','promoted','failed')) = (submitted_at_ms IS NOT NULL)),
  CHECK ((state = 'admission_unknown') = (admission_unknown_at_ms IS NOT NULL)),
  CHECK ((state IN ('admitted','promoted')) = (admitted_at_ms IS NOT NULL)),
  CHECK ((state = 'promoted') = (promoted_at_ms IS NOT NULL)),
  CHECK ((state = 'failed') = (failed_at_ms IS NOT NULL)),
  CHECK ((state = 'cancelled') = (cancelled_at_ms IS NOT NULL)),
  CHECK ((state IN ('submitting','admission_unknown','admitted','promoted','failed')) = (claimed_fencing_token IS NOT NULL)),
  CHECK ((state IN ('admitted','promoted')) = (admitted_seq IS NOT NULL)),
  CHECK ((state = 'promoted') = (promoted_seq IS NOT NULL)),
  CHECK ((state IN ('admitted','promoted')) = (evidence_observed_at_ms IS NOT NULL)),
  CHECK (promoted_seq IS NULL OR promoted_seq > admitted_seq)
) STRICT, WITHOUT ROWID;
INSERT INTO deliveries_restore SELECT * FROM deliveries_v3;
DROP TABLE deliveries_v3;
DROP TABLE workspaces_v3;
ALTER TABLE workspaces_restore RENAME TO workspaces;
ALTER TABLE deliveries_restore RENAME TO deliveries;
CREATE INDEX deliveries_workspace_created ON deliveries(workspace_key, created_at_ms);
CREATE INDEX deliveries_source_created ON deliveries(workspace_key, source_session_id, created_at_ms);
CREATE INDEX deliveries_target_created ON deliveries(workspace_key, target_session_id, created_at_ms);
CREATE INDEX deliveries_recovery ON deliveries(workspace_key, state, claimed_fencing_token, created_at_ms);
CREATE UNIQUE INDEX deliveries_native_message ON deliveries(workspace_key, native_message_id);
ALTER TABLE delivery_rate_events RENAME TO delivery_rate_events_v3;
CREATE TABLE delivery_rate_events_restore (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;
INSERT INTO delivery_rate_events_restore SELECT * FROM delivery_rate_events_v3;
DROP TABLE delivery_rate_events_v3;
ALTER TABLE delivery_rate_events_restore RENAME TO delivery_rate_events;
CREATE INDEX delivery_rate_workspace ON delivery_rate_events(workspace_key, occurred_at_ms);
CREATE INDEX delivery_rate_source ON delivery_rate_events(workspace_key, source_session_id, occurred_at_ms);
CREATE INDEX delivery_rate_target ON delivery_rate_events(workspace_key, target_session_id, occurred_at_ms);
ALTER TABLE ownership RENAME TO ownership_v3;
CREATE TABLE ownership_restore (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  acquired_wall_ms INTEGER NOT NULL CHECK (acquired_wall_ms >= 0),
  renewed_wall_ms INTEGER NOT NULL CHECK (renewed_wall_ms >= acquired_wall_ms),
  expires_wall_ms INTEGER NOT NULL CHECK (expires_wall_ms > renewed_wall_ms)
) STRICT;
INSERT INTO ownership_restore
SELECT singleton, owner_id, fencing_token, acquired_wall_ms, renewed_wall_ms, expires_wall_ms
FROM ownership_v3;
DROP TABLE ownership_v3;
ALTER TABLE ownership_restore RENAME TO ownership;
`,
  },
  {
    version: 4,
    checksum: "sha256:26e2bda38b4851017143a4fd0269cf542b4f6c4a96a64f1654e8b8c527219470",
    sql: `
CREATE TABLE requests (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 36 AND substr(id, 1, 4) = 'req_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  workspace_key TEXT NOT NULL REFERENCES workspaces(workspace_key) ON DELETE CASCADE CHECK (
    length(workspace_key) BETWEEN 1 AND 128 AND substr(workspace_key, 1, 1) GLOB '[A-Za-z0-9]' AND
    workspace_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  source_session_id TEXT NOT NULL CHECK (
    length(source_session_id) BETWEEN 5 AND 132 AND substr(source_session_id, 1, 4) = 'ses_' AND
    substr(source_session_id, 5) NOT GLOB '*[^A-Za-z0-9]*'
  ),
  target_session_id TEXT NOT NULL CHECK (
    length(target_session_id) BETWEEN 5 AND 132 AND substr(target_session_id, 1, 4) = 'ses_' AND
    substr(target_session_id, 5) NOT GLOB '*[^A-Za-z0-9]*'
  ),
  native_message_id TEXT NOT NULL CHECK (
    length(native_message_id) = 36 AND substr(native_message_id, 1, 4) = 'msg_' AND
    substr(native_message_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('ask','wait')),
  resolution_state TEXT NOT NULL CHECK (resolution_state IN (
    'pending','answered','reached','deadline_expired','cancelled','delivery_failed',
    'target_stopped','source_stopped','target_deleted','source_deleted'
  )),
  delivery_state TEXT NOT NULL CHECK (delivery_state IN (
    'prepared','submitting','delivery_unknown','admitted','promoted','delivery_failed'
  )),
  result_state TEXT NOT NULL CHECK (result_state IN ('none','available','expired','acknowledged')),
  payload_byte_length INTEGER NOT NULL CHECK (payload_byte_length BETWEEN 1 AND 32768),
  retained_content_byte_length INTEGER CHECK (
    retained_content_byte_length IS NULL OR retained_content_byte_length BETWEEN 2 AND 98304
  ),
  payload_sha256 TEXT CHECK (
    payload_sha256 IS NULL OR (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  deadline_at_ms INTEGER NOT NULL CHECK (deadline_at_ms BETWEEN created_at_ms + 1 AND 9007199254740991),
  submitted_at_ms INTEGER CHECK (submitted_at_ms IS NULL OR submitted_at_ms BETWEEN created_at_ms AND updated_at_ms),
  delivery_unknown_at_ms INTEGER CHECK (
    delivery_unknown_at_ms IS NULL OR delivery_unknown_at_ms BETWEEN submitted_at_ms AND updated_at_ms
  ),
  admitted_at_ms INTEGER CHECK (admitted_at_ms IS NULL OR admitted_at_ms BETWEEN submitted_at_ms AND updated_at_ms),
  promoted_at_ms INTEGER CHECK (promoted_at_ms IS NULL OR promoted_at_ms BETWEEN admitted_at_ms AND updated_at_ms),
  delivery_failed_at_ms INTEGER CHECK (
    delivery_failed_at_ms IS NULL OR delivery_failed_at_ms BETWEEN submitted_at_ms AND updated_at_ms
  ),
  claimed_fencing_token INTEGER CHECK (
    claimed_fencing_token IS NULL OR claimed_fencing_token BETWEEN 1 AND 9007199254740991
  ),
  admitted_seq INTEGER CHECK (admitted_seq IS NULL OR admitted_seq BETWEEN 0 AND 9007199254740991),
  promoted_seq INTEGER CHECK (promoted_seq IS NULL OR promoted_seq BETWEEN 0 AND 9007199254740991),
  evidence_observed_at_ms INTEGER CHECK (
    evidence_observed_at_ms IS NULL OR evidence_observed_at_ms BETWEEN admitted_at_ms AND updated_at_ms
  ),
  resolved_at_ms INTEGER CHECK (resolved_at_ms IS NULL OR resolved_at_ms BETWEEN created_at_ms AND updated_at_ms),
  result_byte_length INTEGER CHECK (result_byte_length IS NULL OR result_byte_length BETWEEN 1 AND 32768),
  result_sha256 TEXT CHECK (
    result_sha256 IS NULL OR (length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  result_available_at_ms INTEGER CHECK (
    result_available_at_ms IS NULL OR result_available_at_ms BETWEEN resolved_at_ms AND updated_at_ms
  ),
  result_expires_at_ms INTEGER CHECK (
    result_expires_at_ms IS NULL OR result_expires_at_ms = result_available_at_ms + 86400000
  ),
  result_expired_at_ms INTEGER CHECK (
    result_expired_at_ms IS NULL OR result_expired_at_ms BETWEEN result_expires_at_ms AND updated_at_ms
  ),
  acknowledged_at_ms INTEGER CHECK (
    acknowledged_at_ms IS NULL OR acknowledged_at_ms BETWEEN result_available_at_ms AND updated_at_ms
  ),
  CHECK (source_session_id <> target_session_id),
  CHECK ((resolution_state = 'pending') = (payload_sha256 IS NOT NULL)),
  CHECK ((resolution_state = 'pending') = (retained_content_byte_length IS NOT NULL)),
  CHECK ((resolution_state = 'pending') = (resolved_at_ms IS NULL)),
  CHECK ((resolution_state = 'answered') = (kind = 'ask' AND result_state <> 'none')),
  CHECK ((resolution_state = 'reached') = (kind = 'wait' AND result_state <> 'none')),
  CHECK ((resolution_state IN ('answered','reached')) = (result_state <> 'none')),
  CHECK ((delivery_state = 'prepared') = (submitted_at_ms IS NULL)),
  CHECK (delivery_state <> 'delivery_unknown' OR delivery_unknown_at_ms IS NOT NULL),
  CHECK (delivery_unknown_at_ms IS NULL OR delivery_state IN ('delivery_unknown','delivery_failed')),
  CHECK ((delivery_state IN ('admitted','promoted')) = (admitted_at_ms IS NOT NULL)),
  CHECK ((delivery_state = 'promoted') = (promoted_at_ms IS NOT NULL)),
  CHECK ((delivery_state = 'delivery_failed') = (delivery_failed_at_ms IS NOT NULL)),
  CHECK ((delivery_state <> 'prepared') = (claimed_fencing_token IS NOT NULL)),
  CHECK ((delivery_state IN ('admitted','promoted')) = (admitted_seq IS NOT NULL)),
  CHECK ((delivery_state = 'promoted') = (promoted_seq IS NOT NULL)),
  CHECK ((delivery_state IN ('admitted','promoted')) = (evidence_observed_at_ms IS NOT NULL)),
  CHECK (promoted_seq IS NULL OR promoted_seq > admitted_seq),
  CHECK (delivery_state <> 'delivery_unknown' OR delivery_unknown_at_ms >= submitted_at_ms),
  CHECK (delivery_state <> 'delivery_failed' OR (
    delivery_failed_at_ms >= COALESCE(delivery_unknown_at_ms, submitted_at_ms) AND
    (resolution_state <> 'pending')
  )),
  CHECK (resolution_state <> 'delivery_failed' OR (
    delivery_state = 'delivery_failed' AND resolved_at_ms = delivery_failed_at_ms
  )),
  CHECK (delivery_state <> 'delivery_failed' OR resolution_state = 'delivery_failed' OR delivery_failed_at_ms >= resolved_at_ms),
  CHECK (resolution_state <> 'deadline_expired' OR resolved_at_ms >= deadline_at_ms),
  CHECK (resolution_state IN ('pending','deadline_expired') OR resolved_at_ms < deadline_at_ms),
  CHECK ((result_state = 'available') = (result_byte_length IS NOT NULL)),
  CHECK ((result_state = 'available') = (result_sha256 IS NOT NULL)),
  CHECK ((result_state <> 'none') = (result_available_at_ms IS NOT NULL)),
  CHECK ((result_state <> 'none') = (result_expires_at_ms IS NOT NULL)),
  CHECK (result_state <> 'expired' OR result_expired_at_ms IS NOT NULL),
  CHECK (result_expired_at_ms IS NULL OR result_state IN ('expired','acknowledged')),
  CHECK ((result_state = 'acknowledged') = (acknowledged_at_ms IS NOT NULL)),
  CHECK (result_state <> 'acknowledged' OR result_expired_at_ms IS NULL OR acknowledged_at_ms >= result_expired_at_ms),
  CHECK (result_available_at_ms IS NULL OR result_available_at_ms = resolved_at_ms),
  UNIQUE (id, workspace_key, source_session_id, target_session_id)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX requests_native_message ON requests(workspace_key, native_message_id);
CREATE INDEX requests_deadline ON requests(workspace_key, deadline_at_ms, id) WHERE resolution_state = 'pending';
CREATE INDEX requests_prepared_recovery ON requests(workspace_key, created_at_ms, id)
  WHERE resolution_state = 'pending' AND delivery_state = 'prepared';
CREATE INDEX requests_submitting_recovery ON requests(workspace_key, created_at_ms, id, claimed_fencing_token)
  WHERE delivery_state = 'submitting';
CREATE INDEX requests_source ON requests(workspace_key, source_session_id, created_at_ms, id);
CREATE INDEX requests_target ON requests(workspace_key, target_session_id, created_at_ms, id);
CREATE INDEX requests_result_expiry ON requests(workspace_key, result_expires_at_ms, id)
  WHERE result_state = 'available';
CREATE INDEX requests_metadata_gc ON requests(workspace_key, resolved_at_ms, id)
  WHERE resolution_state <> 'pending' AND result_state <> 'available';
CREATE INDEX requests_pending_workspace_quota
  ON requests(workspace_key, retained_content_byte_length) WHERE resolution_state = 'pending';
CREATE INDEX requests_pending_source_quota
  ON requests(workspace_key, source_session_id, retained_content_byte_length)
  WHERE resolution_state = 'pending';
CREATE INDEX requests_pending_target_quota
  ON requests(workspace_key, target_session_id, retained_content_byte_length)
  WHERE resolution_state = 'pending';
CREATE TABLE request_payloads (
  request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL CHECK (
    length(CAST(payload_json AS BLOB)) BETWEEN 1 AND 32768 AND json_valid(payload_json)
  ),
  envelope_json TEXT NOT NULL CHECK (
    length(CAST(envelope_json AS BLOB)) BETWEEN 1 AND 65536 AND json_valid(envelope_json)
  )
) STRICT, WITHOUT ROWID;
CREATE TABLE request_wait_edges (
  request_id TEXT PRIMARY KEY,
  workspace_key TEXT NOT NULL REFERENCES workspaces(workspace_key) ON DELETE CASCADE CHECK (
    length(workspace_key) BETWEEN 1 AND 128 AND substr(workspace_key, 1, 1) GLOB '[A-Za-z0-9]' AND
    workspace_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  source_session_id TEXT NOT NULL CHECK (
    length(source_session_id) BETWEEN 5 AND 132 AND substr(source_session_id, 1, 4) = 'ses_' AND
    substr(source_session_id, 5) NOT GLOB '*[^A-Za-z0-9]*'
  ),
  target_session_id TEXT NOT NULL CHECK (
    length(target_session_id) BETWEEN 5 AND 132 AND substr(target_session_id, 1, 4) = 'ses_' AND
    substr(target_session_id, 5) NOT GLOB '*[^A-Za-z0-9]*'
  ),
  CHECK (source_session_id <> target_session_id),
  FOREIGN KEY (request_id, workspace_key, source_session_id, target_session_id)
    REFERENCES requests(id, workspace_key, source_session_id, target_session_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX request_edges_source ON request_wait_edges(workspace_key, source_session_id, target_session_id);
CREATE INDEX request_edges_target ON request_wait_edges(workspace_key, target_session_id, source_session_id);
CREATE TABLE request_rate_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (sequence BETWEEN 1 AND 9007199254740991),
  workspace_key TEXT NOT NULL REFERENCES workspaces(workspace_key) ON DELETE CASCADE CHECK (
    length(workspace_key) BETWEEN 1 AND 128 AND substr(workspace_key, 1, 1) GLOB '[A-Za-z0-9]' AND
    workspace_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  source_session_id TEXT NOT NULL CHECK (
    length(source_session_id) BETWEEN 5 AND 132 AND substr(source_session_id, 1, 4) = 'ses_' AND
    substr(source_session_id, 5) NOT GLOB '*[^A-Za-z0-9]*'
  ),
  target_session_id TEXT NOT NULL CHECK (
    length(target_session_id) BETWEEN 5 AND 132 AND substr(target_session_id, 1, 4) = 'ses_' AND
    substr(target_session_id, 5) NOT GLOB '*[^A-Za-z0-9]*'
  ),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE INDEX request_rate_workspace ON request_rate_events(workspace_key, occurred_at_ms);
CREATE INDEX request_rate_source ON request_rate_events(workspace_key, source_session_id, occurred_at_ms);
CREATE INDEX request_rate_target ON request_rate_events(workspace_key, target_session_id, occurred_at_ms);
CREATE TABLE request_results (
  request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL CHECK (
    length(CAST(result_json AS BLOB)) BETWEEN 1 AND 32768 AND json_valid(result_json)
  )
) STRICT, WITHOUT ROWID;
`,
    downSql: `
DROP TABLE request_results;
DROP TABLE request_rate_events;
DROP TABLE request_wait_edges;
DROP TABLE request_payloads;
DROP TABLE requests;
`,
  },
  {
    version: 5,
    checksum: "sha256:500532cacd266418fc467d6052ce51ddc9551d6a9b48931c544871017f8b707b",
    sql: `
-- The pre-DDL v5 audit requires each pending parent to have its exact private child rows.
CREATE INDEX requests_available_workspace_quota
  ON requests(workspace_key, result_byte_length) WHERE result_state = 'available';
CREATE INDEX requests_available_source_quota
  ON requests(workspace_key, source_session_id, result_byte_length)
  WHERE result_state = 'available';
CREATE INDEX requests_available_target_quota
  ON requests(workspace_key, target_session_id, result_byte_length)
  WHERE result_state = 'available';
CREATE TRIGGER request_payloads_pending_insert
BEFORE INSERT ON request_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM requests WHERE id = NEW.request_id AND resolution_state = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'request payload parent must be pending');
END;
CREATE TRIGGER request_wait_edges_pending_insert
BEFORE INSERT ON request_wait_edges
WHEN NOT EXISTS (
  SELECT 1 FROM requests WHERE id = NEW.request_id AND resolution_state = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'request edge parent must be pending');
END;
CREATE TRIGGER requests_terminal_private_guard
BEFORE UPDATE OF resolution_state ON requests
WHEN OLD.resolution_state = 'pending' AND NEW.resolution_state <> 'pending' AND (
  EXISTS (SELECT 1 FROM request_payloads WHERE request_id = OLD.id) OR
  EXISTS (SELECT 1 FROM request_wait_edges WHERE request_id = OLD.id)
)
BEGIN
  SELECT RAISE(ABORT, 'terminal request private state must be erased first');
END;
CREATE TRIGGER request_results_available_insert
BEFORE INSERT ON request_results
WHEN NOT EXISTS (
  SELECT 1 FROM requests WHERE id = NEW.request_id AND result_state = 'available'
)
BEGIN
  SELECT RAISE(ABORT, 'request result parent must be available');
END;
CREATE TRIGGER requests_result_erasure_guard
BEFORE UPDATE OF result_state ON requests
WHEN OLD.result_state = 'available' AND NEW.result_state <> 'available' AND
  EXISTS (SELECT 1 FROM request_results WHERE request_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'request result must be erased first');
END;
CREATE TRIGGER requests_result_time_insert
BEFORE INSERT ON requests
WHEN NEW.result_expires_at_ms IS NOT NULL AND (
  typeof(NEW.result_expires_at_ms) <> 'integer' OR
  NEW.result_expires_at_ms < 0 OR NEW.result_expires_at_ms > 9007199254740991
)
BEGIN
  SELECT RAISE(ABORT, 'request result expiry is outside the safe integer range');
END;
CREATE TRIGGER requests_result_time_update
BEFORE UPDATE OF result_expires_at_ms ON requests
WHEN NEW.result_expires_at_ms IS NOT NULL AND (
  typeof(NEW.result_expires_at_ms) <> 'integer' OR
  NEW.result_expires_at_ms < 0 OR NEW.result_expires_at_ms > 9007199254740991
)
BEGIN
  SELECT RAISE(ABORT, 'request result expiry is outside the safe integer range');
END;
`,
    downSql: `
DROP TRIGGER requests_result_time_update;
DROP TRIGGER requests_result_time_insert;
DROP TRIGGER requests_result_erasure_guard;
DROP TRIGGER request_results_available_insert;
DROP TRIGGER requests_terminal_private_guard;
DROP TRIGGER request_wait_edges_pending_insert;
DROP TRIGGER request_payloads_pending_insert;
DROP INDEX requests_available_target_quota;
DROP INDEX requests_available_source_quota;
DROP INDEX requests_available_workspace_quota;
`,
  },
  {
    version: 6,
    checksum: "sha256:74a8aa2ee8e35ffc6632495931db32b83a2708efc496c4db1f8c8952dc5c9f5a",
    sql: `
CREATE INDEX requests_participant_inbox
  ON requests(workspace_key, target_session_id, created_at_ms DESC, id DESC)
  WHERE resolution_state = 'pending';
CREATE INDEX requests_participant_outbox
  ON requests(workspace_key, source_session_id, created_at_ms DESC, id DESC)
  WHERE resolution_state = 'pending' OR resolution_state NOT IN ('answered','reached')
    OR result_state != 'acknowledged';
CREATE INDEX requests_due_source
  ON requests(workspace_key, source_session_id, deadline_at_ms, id)
  WHERE resolution_state = 'pending';
CREATE INDEX requests_due_target
  ON requests(workspace_key, target_session_id, deadline_at_ms, id)
  WHERE resolution_state = 'pending';
CREATE INDEX requests_result_due_source
  ON requests(workspace_key, source_session_id, result_expires_at_ms, id)
  WHERE result_state = 'available';
`,
    downSql: `
DROP INDEX requests_result_due_source;
DROP INDEX requests_due_target;
DROP INDEX requests_due_source;
DROP INDEX requests_participant_outbox;
DROP INDEX requests_participant_inbox;
`,
  },
  {
    version: 7,
    checksum: "sha256:8543d47872200c45c03a5c201ef943bf6e9f1b25799078e4eb618f005b5882c9",
    sql: `
CREATE INDEX deliveries_prepared_startup_v7
  ON deliveries(workspace_key, created_at_ms, id) WHERE state = 'prepared';
CREATE INDEX deliveries_submitting_startup_v7
  ON deliveries(workspace_key, created_at_ms, id, claimed_fencing_token)
  WHERE state = 'submitting';
CREATE TRIGGER requests_submitting_ceiling_insert_v7
BEFORE INSERT ON requests
WHEN NEW.delivery_state = 'submitting' AND (
  SELECT count(*) FROM requests INDEXED BY requests_submitting_recovery
  WHERE workspace_key = NEW.workspace_key AND delivery_state = 'submitting'
) >= ${submittingRequestsPerWorkspaceHardCeiling}
BEGIN
  SELECT RAISE(ABORT, 'workspace submitting request ceiling exceeded');
END;
CREATE TRIGGER requests_submitting_ceiling_update_v7
BEFORE UPDATE OF delivery_state, workspace_key ON requests
WHEN NEW.delivery_state = 'submitting' AND (
  OLD.delivery_state <> 'submitting' OR OLD.workspace_key <> NEW.workspace_key
) AND (
  SELECT count(*) FROM requests INDEXED BY requests_submitting_recovery
  WHERE workspace_key = NEW.workspace_key AND delivery_state = 'submitting'
) >= ${submittingRequestsPerWorkspaceHardCeiling}
BEGIN
  SELECT RAISE(ABORT, 'workspace submitting request ceiling exceeded');
END;
`,
    downSql: `
DROP TRIGGER requests_submitting_ceiling_update_v7;
DROP TRIGGER requests_submitting_ceiling_insert_v7;
DROP INDEX deliveries_submitting_startup_v7;
DROP INDEX deliveries_prepared_startup_v7;
    `,
  },
  {
    version: 8,
    checksum: "sha256:f05b42c3099f5fe64243b686b1a6b54db715ae81301ed0130079ad8833a13841",
    sql: `
ALTER TABLE requests ADD COLUMN creation_operation_id TEXT
  CHECK (creation_operation_id IS NULL OR (
    length(creation_operation_id) = 35 AND
    substr(creation_operation_id, 1, 3) = 'op_' AND
    substr(creation_operation_id, 4) NOT GLOB '*[^0-9a-f]*'
  ));
CREATE UNIQUE INDEX requests_creation_operation_v8
  ON requests(workspace_key, creation_operation_id)
  WHERE creation_operation_id IS NOT NULL;
`,
    downSql: `
DROP INDEX requests_creation_operation_v8;
ALTER TABLE requests DROP COLUMN creation_operation_id;
`,
  },
  {
    version: 9,
    checksum: "sha256:c05c16d0b653020fc2ed304031f983d67f26edbe9f9f043ee0ffe3fdca0aa04d",
    sql: `
CREATE INDEX requests_stop_target_v9
  ON requests(workspace_key, target_session_id, id) WHERE resolution_state = 'pending';
CREATE INDEX requests_stop_source_v9
  ON requests(workspace_key, source_session_id, id) WHERE resolution_state = 'pending';
`,
    downSql: `
DROP INDEX requests_stop_source_v9;
DROP INDEX requests_stop_target_v9;
`,
  },
  {
    version: 10,
    checksum: "sha256:bd82b5aa40ab8416ab7c1d44b852505880555a1cd2b119c59448157a77f11274",
    sql: `
CREATE TABLE start_operations (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 35 AND substr(id, 1, 3) = 'op_' AND substr(id, 4) NOT GLOB '*[^0-9a-f]*'
  ),
  workspace_key TEXT NOT NULL REFERENCES workspaces(workspace_key) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL CHECK (
    length(source_session_id) BETWEEN 5 AND 132 AND substr(source_session_id, 1, 4) = 'ses_' AND
    substr(source_session_id, 5) NOT GLOB '*[^A-Za-z0-9]*'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 128 AND
    substr(idempotency_key, 1, 1) GLOB '[A-Za-z0-9]' AND
    idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  arguments_sha256 TEXT NOT NULL CHECK (
    length(arguments_sha256) = 64 AND arguments_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  session_id TEXT NOT NULL CHECK (
    length(session_id) = 36 AND substr(session_id, 1, 4) = 'ses_' AND
    substr(session_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  native_message_id TEXT NOT NULL CHECK (
    length(native_message_id) = 36 AND substr(native_message_id, 1, 4) = 'msg_' AND
    substr(native_message_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  requested_agent TEXT CHECK (
    requested_agent IS NULL OR (length(requested_agent) BETWEEN 1 AND 128 AND
      substr(requested_agent, 1, 1) GLOB '[A-Za-z0-9]' AND
      requested_agent NOT GLOB '*[^A-Za-z0-9._:/-]*')
  ),
  requested_model TEXT CHECK (
    requested_model IS NULL OR (length(requested_model) BETWEEN 1 AND 128 AND
      substr(requested_model, 1, 1) GLOB '[A-Za-z0-9]' AND
      requested_model NOT GLOB '*[^A-Za-z0-9._:/-]*')
  ),
  title_requested INTEGER NOT NULL CHECK (title_requested IN (0, 1)),
  unresolved_provenance_limit INTEGER NOT NULL CHECK (
    unresolved_provenance_limit BETWEEN 1 AND ${unresolvedStartProvenancePerWorkspaceHardCeiling}
  ),
  creation_state TEXT NOT NULL CHECK (creation_state IN (
    'prepared','submitting','created','failed','policy_denied','approval_rejected','outcome_unknown'
  )),
  title_state TEXT NOT NULL CHECK (title_state IN (
    'not_started','prepared','submitting','updated','failed','outcome_unknown','payload_unavailable','skipped'
  )),
  admission_state TEXT NOT NULL CHECK (admission_state IN (
    'not_started','prepared','submitting','admitted','admission_unknown','payload_unavailable','failed'
  )),
  claimed_fencing_token INTEGER CHECK (
    claimed_fencing_token IS NULL OR claimed_fencing_token BETWEEN 1 AND 9007199254740991
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  CHECK (creation_state = 'created' OR title_state NOT IN ('submitting','updated')),
  CHECK (creation_state = 'created' OR admission_state NOT IN ('submitting','admitted')),
  CHECK ((creation_state = 'submitting' OR title_state = 'submitting' OR
    admission_state = 'submitting') = (claimed_fencing_token IS NOT NULL)),
  UNIQUE (workspace_key, source_session_id, idempotency_key),
  UNIQUE (workspace_key, session_id),
  UNIQUE (workspace_key, native_message_id),
  UNIQUE (id, workspace_key, source_session_id, session_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE start_operation_payloads (
  operation_id TEXT PRIMARY KEY REFERENCES start_operations(id) ON DELETE CASCADE,
  initial_message TEXT NOT NULL CHECK (
    length(CAST(initial_message AS BLOB)) BETWEEN 1 AND 32768
  ),
  title TEXT CHECK (title IS NULL OR length(CAST(title AS BLOB)) BETWEEN 1 AND 512),
  agent TEXT CHECK (agent IS NULL OR length(agent) BETWEEN 1 AND 128),
  model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 128)
) STRICT, WITHOUT ROWID;
CREATE TABLE managed_sessions (
  session_id TEXT PRIMARY KEY,
  workspace_key TEXT NOT NULL REFERENCES workspaces(workspace_key) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  provenance_state TEXT NOT NULL CHECK (provenance_state IN ('reserved','created','unresolved','deleted')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (operation_id, workspace_key, source_session_id, session_id)
    REFERENCES start_operations(id, workspace_key, source_session_id, session_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE start_rate_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (sequence BETWEEN 1 AND 9007199254740991),
  workspace_key TEXT NOT NULL REFERENCES workspaces(workspace_key) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE INDEX start_operations_recovery_v10 ON start_operations(workspace_key, created_at_ms, id)
  WHERE creation_state IN ('prepared','submitting','outcome_unknown') OR title_state IN ('prepared','submitting') OR
    admission_state IN ('prepared','submitting');
CREATE INDEX start_operations_terminal_gc_v10
  ON start_operations(workspace_key, updated_at_ms, id)
  WHERE creation_state IN ('failed','policy_denied','approval_rejected');
CREATE INDEX start_rate_source_v10
  ON start_rate_events(workspace_key, source_session_id, occurred_at_ms);
CREATE INDEX start_rate_workspace_v10 ON start_rate_events(workspace_key, occurred_at_ms);
CREATE INDEX managed_sessions_workspace_v10 ON managed_sessions(workspace_key, created_at_ms);
CREATE TRIGGER managed_sessions_ceiling_insert_v10 BEFORE INSERT ON managed_sessions
WHEN NEW.provenance_state NOT IN ('unresolved','deleted') AND
  (SELECT count(*) FROM managed_sessions WHERE workspace_key = NEW.workspace_key
    AND provenance_state NOT IN ('unresolved','deleted'))
  >= ${managedSessionsPerWorkspaceHardCeiling}
BEGIN
  SELECT RAISE(ABORT, 'workspace managed session ceiling exceeded');
END;
CREATE TRIGGER managed_sessions_unresolved_ceiling_insert_v10 BEFORE INSERT ON managed_sessions
WHEN NEW.provenance_state = 'unresolved' AND
  (SELECT count(*) FROM managed_sessions WHERE workspace_key = NEW.workspace_key
    AND provenance_state = 'unresolved') >= ${unresolvedStartProvenancePerWorkspaceHardCeiling}
BEGIN
  SELECT RAISE(ABORT, 'workspace unresolved start provenance ceiling exceeded');
END;
CREATE TRIGGER managed_sessions_unresolved_ceiling_update_v10
BEFORE UPDATE OF provenance_state, workspace_key ON managed_sessions
WHEN NEW.provenance_state = 'unresolved' AND OLD.provenance_state <> 'unresolved' AND
  (SELECT count(*) FROM managed_sessions WHERE workspace_key = NEW.workspace_key
    AND provenance_state = 'unresolved') >= ${unresolvedStartProvenancePerWorkspaceHardCeiling}
BEGIN
  SELECT RAISE(ABORT, 'workspace unresolved start provenance ceiling exceeded');
END;
CREATE TRIGGER managed_sessions_parent_state_insert_v10 BEFORE INSERT ON managed_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM start_operations WHERE id = NEW.operation_id
    AND workspace_key = NEW.workspace_key AND creation_state = 'prepared'
)
BEGIN
  SELECT RAISE(ABORT, 'managed session reservation requires a prepared start');
END;
CREATE TRIGGER start_operations_recovery_ceiling_insert_v10 BEFORE INSERT ON start_operations
WHEN (SELECT count(*) FROM start_operations WHERE workspace_key = NEW.workspace_key AND (
  creation_state IN ('prepared','submitting') OR title_state IN ('prepared','submitting') OR
  admission_state IN ('prepared','submitting')
)) >= ${startOperationsRecoveryHardCeiling}
BEGIN
  SELECT RAISE(ABORT, 'workspace recoverable start operation ceiling exceeded');
END;
CREATE TRIGGER start_operations_unresolved_ceiling_update_v10
BEFORE UPDATE OF creation_state ON start_operations
WHEN NEW.creation_state = 'submitting' AND OLD.creation_state = 'prepared' AND
  (SELECT count(*) FROM start_operations WHERE workspace_key = NEW.workspace_key
    AND creation_state IN ('submitting','outcome_unknown'))
    >= ${unresolvedStartProvenancePerWorkspaceHardCeiling}
BEGIN
  SELECT RAISE(ABORT, 'workspace unresolved start provenance ceiling exceeded');
END;
CREATE TRIGGER start_operations_ceiling_insert_v10 BEFORE INSERT ON start_operations
WHEN (SELECT count(*) FROM start_operations WHERE workspace_key = NEW.workspace_key)
  >= ${startOperationsPerWorkspaceHardCeiling}
BEGIN
  SELECT RAISE(ABORT, 'workspace start operation ceiling exceeded');
END;
CREATE TRIGGER start_operation_payloads_ceiling_insert_v10 BEFORE INSERT ON start_operation_payloads
WHEN COALESCE((
  SELECT sum(length(CAST(p.initial_message AS BLOB)) +
    COALESCE(length(CAST(p.title AS BLOB)), 0) +
    COALESCE(length(CAST(p.agent AS BLOB)), 0) +
    COALESCE(length(CAST(p.model AS BLOB)), 0))
  FROM start_operation_payloads AS p JOIN start_operations AS existing
    ON existing.id = p.operation_id
  WHERE existing.workspace_key = (
    SELECT workspace_key FROM start_operations WHERE id = NEW.operation_id
  )
), 0) + length(CAST(NEW.initial_message AS BLOB)) +
  COALESCE(length(CAST(NEW.title AS BLOB)), 0) +
  COALESCE(length(CAST(NEW.agent AS BLOB)), 0) +
  COALESCE(length(CAST(NEW.model AS BLOB)), 0) > ${startPayloadBytesPerWorkspaceHardCeiling}
BEGIN
  SELECT RAISE(ABORT, 'workspace start payload byte ceiling exceeded');
END;
CREATE TRIGGER start_operation_payloads_parent_state_insert_v10
BEFORE INSERT ON start_operation_payloads
WHEN NOT EXISTS (
  SELECT 1 FROM start_operations WHERE id = NEW.operation_id
    AND creation_state IN ('prepared','submitting','created')
)
BEGIN
  SELECT RAISE(ABORT, 'start payload parent cannot retain private state');
END;
CREATE TRIGGER start_operations_rejection_private_guard_v10
BEFORE UPDATE OF creation_state ON start_operations
WHEN NEW.creation_state IN ('policy_denied','approval_rejected') AND (
  EXISTS (SELECT 1 FROM start_operation_payloads WHERE operation_id = OLD.id) OR
  EXISTS (SELECT 1 FROM managed_sessions WHERE operation_id = OLD.id)
)
BEGIN
  SELECT RAISE(ABORT, 'rejected start private state must be erased first');
END;
CREATE TRIGGER start_rate_events_ceiling_insert_v10 BEFORE INSERT ON start_rate_events
WHEN (SELECT count(*) FROM start_rate_events WHERE workspace_key = NEW.workspace_key)
  >= ${startRateEventsPerWorkspaceHardCeiling}
BEGIN
  SELECT RAISE(ABORT, 'workspace start rate event ceiling exceeded');
END;
`,
    downSql: `
DROP TRIGGER start_rate_events_ceiling_insert_v10;
DROP TRIGGER start_operations_recovery_ceiling_insert_v10;
DROP TRIGGER managed_sessions_ceiling_insert_v10;
DROP TABLE start_rate_events;
DROP TABLE managed_sessions;
DROP TABLE start_operation_payloads;
DROP TABLE start_operations;
    `,
  },
  {
    version: 11,
    checksum: "sha256:ed970b8cd128824271eca05049a889d225a94646c5c0f9a1810bbba788db5cf5",
    sql: `
ALTER TABLE start_operations ADD COLUMN managed_session_limit INTEGER NOT NULL
  DEFAULT ${managedSessionsPerWorkspaceHardCeiling} CHECK (
    managed_session_limit BETWEEN 1 AND ${managedSessionsPerWorkspaceHardCeiling}
  );
CREATE TRIGGER managed_sessions_ceiling_update_v11
BEFORE UPDATE OF provenance_state, workspace_key ON managed_sessions
WHEN NEW.provenance_state NOT IN ('unresolved','deleted') AND
  (OLD.provenance_state IN ('unresolved','deleted') OR OLD.workspace_key <> NEW.workspace_key) AND
  (SELECT count(*) FROM managed_sessions WHERE workspace_key = NEW.workspace_key
    AND provenance_state NOT IN ('unresolved','deleted'))
  >= ${managedSessionsPerWorkspaceHardCeiling}
BEGIN
  SELECT RAISE(ABORT, 'workspace managed session ceiling exceeded');
END;
`,
    downSql: `
DROP TRIGGER managed_sessions_ceiling_update_v11;
ALTER TABLE start_operations DROP COLUMN managed_session_limit;
`,
  },
  {
    version: 12,
    checksum: "sha256:c8d9d2485e076afb224f734525de4fdd99f5d2c2da72ed1b698275b54648e6fe",
    sql: `
ALTER TABLE deliveries RENAME TO deliveries_v11;
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 36 AND substr(id, 1, 4) = 'dlv_' AND
    substr(id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  workspace_key TEXT NOT NULL REFERENCES workspaces(workspace_key) ON DELETE CASCADE CHECK (
    length(workspace_key) BETWEEN 1 AND 128 AND
    substr(workspace_key, 1, 1) GLOB '[A-Za-z0-9]' AND
    workspace_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  source_session_id TEXT NOT NULL CHECK (
    length(source_session_id) BETWEEN 5 AND 132 AND substr(source_session_id, 1, 4) = 'ses_' AND
    substr(source_session_id, 5) NOT GLOB '*[^A-Za-z0-9]*'
  ),
  target_session_id TEXT NOT NULL CHECK (
    length(target_session_id) BETWEEN 5 AND 132 AND substr(target_session_id, 1, 4) = 'ses_' AND
    substr(target_session_id, 5) NOT GLOB '*[^A-Za-z0-9]*'
  ),
  native_message_id TEXT NOT NULL CHECK (
    length(native_message_id) = 36 AND substr(native_message_id, 1, 4) = 'msg_' AND
    substr(native_message_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('prepared','submitting','admission_unknown','admitted','promoted','failed','cancelled')),
  prepared_envelope TEXT CHECK (
    prepared_envelope IS NULL OR length(CAST(prepared_envelope AS BLOB)) <= 65536
  ),
  content_byte_length INTEGER NOT NULL CHECK (content_byte_length BETWEEN 0 AND 32768),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  submitted_at_ms INTEGER CHECK (
    submitted_at_ms IS NULL OR submitted_at_ms BETWEEN created_at_ms AND updated_at_ms
  ),
  admission_unknown_at_ms INTEGER CHECK (
    admission_unknown_at_ms IS NULL OR admission_unknown_at_ms BETWEEN submitted_at_ms AND updated_at_ms
  ),
  admitted_at_ms INTEGER CHECK (
    admitted_at_ms IS NULL OR admitted_at_ms BETWEEN submitted_at_ms AND updated_at_ms
  ),
  promoted_at_ms INTEGER CHECK (
    promoted_at_ms IS NULL OR promoted_at_ms BETWEEN admitted_at_ms AND updated_at_ms
  ),
  failed_at_ms INTEGER CHECK (
    failed_at_ms IS NULL OR failed_at_ms BETWEEN submitted_at_ms AND updated_at_ms
  ),
  cancelled_at_ms INTEGER CHECK (
    cancelled_at_ms IS NULL OR cancelled_at_ms BETWEEN created_at_ms AND updated_at_ms
  ),
  claimed_fencing_token INTEGER CHECK (
    claimed_fencing_token IS NULL OR claimed_fencing_token BETWEEN 1 AND 9007199254740991
  ),
  admission_evidence_kind TEXT CHECK (
    admission_evidence_kind IS NULL OR admission_evidence_kind IN ('v2_queue','public_message')
  ),
  admitted_seq INTEGER CHECK (admitted_seq IS NULL OR admitted_seq BETWEEN 0 AND 9007199254740991),
  promoted_seq INTEGER CHECK (promoted_seq IS NULL OR promoted_seq BETWEEN 0 AND 9007199254740991),
  evidence_observed_at_ms INTEGER CHECK (
    evidence_observed_at_ms IS NULL OR evidence_observed_at_ms BETWEEN submitted_at_ms AND updated_at_ms
  ),
  CHECK ((state = 'prepared') = (prepared_envelope IS NOT NULL)),
  CHECK ((state IN ('submitting','admission_unknown','admitted','promoted','failed')) = (submitted_at_ms IS NOT NULL)),
  CHECK ((state = 'admission_unknown') = (admission_unknown_at_ms IS NOT NULL)),
  CHECK ((state IN ('admitted','promoted')) = (admitted_at_ms IS NOT NULL)),
  CHECK ((state = 'promoted') = (promoted_at_ms IS NOT NULL)),
  CHECK ((state = 'failed') = (failed_at_ms IS NOT NULL)),
  CHECK ((state = 'cancelled') = (cancelled_at_ms IS NOT NULL)),
  CHECK ((state IN ('submitting','admission_unknown','admitted','promoted','failed')) = (claimed_fencing_token IS NOT NULL)),
  CHECK ((state IN ('admitted','promoted')) = (admission_evidence_kind IS NOT NULL)),
  CHECK ((state IN ('admitted','promoted')) = (evidence_observed_at_ms IS NOT NULL)),
  CHECK (state <> 'promoted' OR admission_evidence_kind = 'v2_queue'),
  CHECK ((admission_evidence_kind = 'v2_queue') = (admitted_seq IS NOT NULL)),
  CHECK ((state = 'promoted') = (promoted_seq IS NOT NULL)),
  CHECK (promoted_seq IS NULL OR promoted_seq > admitted_seq)
) STRICT, WITHOUT ROWID;
INSERT INTO deliveries(
  id, workspace_key, source_session_id, target_session_id, native_message_id, state,
  prepared_envelope, content_byte_length, content_sha256, created_at_ms, updated_at_ms,
  submitted_at_ms, admission_unknown_at_ms, admitted_at_ms, promoted_at_ms, failed_at_ms,
  cancelled_at_ms, claimed_fencing_token, admission_evidence_kind, admitted_seq,
  promoted_seq, evidence_observed_at_ms
)
SELECT id, workspace_key, source_session_id, target_session_id, native_message_id, state,
  prepared_envelope, content_byte_length, content_sha256, created_at_ms, updated_at_ms,
  submitted_at_ms, admission_unknown_at_ms, admitted_at_ms, promoted_at_ms, failed_at_ms,
  cancelled_at_ms, claimed_fencing_token,
  CASE WHEN state IN ('admitted','promoted') THEN 'v2_queue' END,
  admitted_seq, promoted_seq, evidence_observed_at_ms
FROM deliveries_v11;
DROP TABLE deliveries_v11;
CREATE INDEX deliveries_workspace_created ON deliveries(workspace_key, created_at_ms);
CREATE INDEX deliveries_source_created ON deliveries(workspace_key, source_session_id, created_at_ms);
CREATE INDEX deliveries_target_created ON deliveries(workspace_key, target_session_id, created_at_ms);
CREATE INDEX deliveries_recovery ON deliveries(workspace_key, state, claimed_fencing_token, created_at_ms);
CREATE UNIQUE INDEX deliveries_native_message ON deliveries(workspace_key, native_message_id);
CREATE INDEX deliveries_prepared_startup_v7
  ON deliveries(workspace_key, created_at_ms, id) WHERE state = 'prepared';
CREATE INDEX deliveries_submitting_startup_v7
  ON deliveries(workspace_key, created_at_ms, id, claimed_fencing_token)
  WHERE state = 'submitting';
`,
    downSql: `
ALTER TABLE deliveries RENAME TO deliveries_v12;
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 36 AND substr(id, 1, 4) = 'dlv_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  workspace_key TEXT NOT NULL REFERENCES workspaces(workspace_key) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  native_message_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','submitting','admission_unknown','admitted','promoted','failed','cancelled')),
  prepared_envelope TEXT,
  content_byte_length INTEGER NOT NULL CHECK (content_byte_length BETWEEN 0 AND 32768),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  submitted_at_ms INTEGER,
  admission_unknown_at_ms INTEGER,
  admitted_at_ms INTEGER,
  promoted_at_ms INTEGER,
  failed_at_ms INTEGER,
  cancelled_at_ms INTEGER,
  claimed_fencing_token INTEGER,
  admitted_seq INTEGER,
  promoted_seq INTEGER,
  evidence_observed_at_ms INTEGER,
  CHECK ((state = 'prepared') = (prepared_envelope IS NOT NULL)),
  CHECK ((state IN ('admitted','promoted')) = (admitted_seq IS NOT NULL)),
  CHECK ((state = 'promoted') = (promoted_seq IS NOT NULL))
) STRICT, WITHOUT ROWID;
INSERT INTO deliveries
SELECT id, workspace_key, source_session_id, target_session_id, native_message_id,
  CASE WHEN admission_evidence_kind = 'public_message' THEN 'admission_unknown' ELSE state END,
  prepared_envelope, content_byte_length, content_sha256, created_at_ms, updated_at_ms,
  submitted_at_ms,
  CASE WHEN admission_evidence_kind = 'public_message' THEN evidence_observed_at_ms ELSE admission_unknown_at_ms END,
  CASE WHEN admission_evidence_kind = 'public_message' THEN NULL ELSE admitted_at_ms END,
  promoted_at_ms, failed_at_ms, cancelled_at_ms, claimed_fencing_token,
  admitted_seq, promoted_seq,
  CASE WHEN admission_evidence_kind = 'public_message' THEN NULL ELSE evidence_observed_at_ms END
FROM deliveries_v12;
DROP TABLE deliveries_v12;
CREATE INDEX deliveries_workspace_created ON deliveries(workspace_key, created_at_ms);
CREATE INDEX deliveries_source_created ON deliveries(workspace_key, source_session_id, created_at_ms);
CREATE INDEX deliveries_target_created ON deliveries(workspace_key, target_session_id, created_at_ms);
CREATE INDEX deliveries_recovery ON deliveries(workspace_key, state, claimed_fencing_token, created_at_ms);
CREATE UNIQUE INDEX deliveries_native_message ON deliveries(workspace_key, native_message_id);
CREATE INDEX deliveries_prepared_startup_v7
  ON deliveries(workspace_key, created_at_ms, id) WHERE state = 'prepared';
CREATE INDEX deliveries_submitting_startup_v7
  ON deliveries(workspace_key, created_at_ms, id, claimed_fencing_token)
  WHERE state = 'submitting';
`,
  },
] as const;

interface VersionRow {
  readonly userVersion: number;
}

interface AppliedRow {
  readonly version: number;
  readonly checksum: string;
}

interface TableNameRow {
  readonly name: string;
}

interface TableColumnRow {
  readonly name: string;
}

interface LeaseRow {
  readonly expiresWallMs: number;
  readonly releasedWallMs?: number | null;
}

export function validateMigrationChecksums(): void {
  for (const [index, migration] of sqliteStoreMigrations.entries()) {
    if (
      migration.version !== index + 1 ||
      migration.checksum !== migrationSqlChecksum(migration.sql)
    ) {
      throw new StoreIntegrityError("A declared SQLite migration checksum is invalid.");
    }
  }
}

function tableExists(database: Database, name: string): boolean {
  return (
    database
      .query<TableNameRow, [string]>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
      )
      .get(name)?.name === name
  );
}

function assertNoActiveOwnershipLease(
  database: Database,
  nowMs: number,
  takeoverGraceMs: number,
): void {
  if (!tableExists(database, "ownership")) return;
  const columns = database
    .query<TableColumnRow, []>("SELECT name FROM pragma_table_info('ownership')")
    .all();
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("expires_wall_ms")) {
    throw new StoreIntegrityError("SQLite ownership metadata cannot guard schema migration.");
  }
  const hasReleased = names.has("released_wall_ms");
  const row = database
    .query<LeaseRow, []>(
      hasReleased
        ? `SELECT expires_wall_ms AS expiresWallMs, released_wall_ms AS releasedWallMs
           FROM ownership WHERE singleton = 1`
        : `SELECT expires_wall_ms AS expiresWallMs FROM ownership WHERE singleton = 1`,
    )
    .get();
  if (!row) return;
  if (!Number.isSafeInteger(row.expiresWallMs)) {
    throw new StoreIntegrityError("SQLite ownership lease metadata is malformed.");
  }
  if (hasReleased && row.releasedWallMs !== null && !Number.isSafeInteger(row.releasedWallMs)) {
    throw new StoreIntegrityError("SQLite ownership lease metadata is malformed.");
  }
  if (
    row.expiresWallMs + takeoverGraceMs > nowMs &&
    (!hasReleased || row.releasedWallMs === null)
  ) {
    throw new StoreSecurityError("An active SQLite owner prevents schema migration.");
  }
}

function readCurrentVersion(database: Database): number {
  const current = database
    .query<VersionRow, []>("SELECT user_version AS userVersion FROM pragma_user_version")
    .get()?.userVersion;
  if (current === undefined || current < 0 || current > sqliteStoreMigrations.length) {
    throw new StoreIntegrityError("The SQLite schema version is unsupported.");
  }
  return current;
}

function validateAppliedHistory(database: Database, current: number): void {
  const applied = database
    .query<AppliedRow, []>("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all();
  if (applied.length !== current) {
    throw new StoreIntegrityError("SQLite migration metadata is incomplete.");
  }
  for (const row of applied) {
    const expected = sqliteStoreMigrations[row.version - 1];
    if (!expected || expected.version !== row.version || expected.checksum !== row.checksum) {
      throw new StoreIntegrityError("Published SQLite migration history does not match.");
    }
  }
}

function auditRequestLifecycleInvariants(database: Database): void {
  const invalid = database
    .query<{ readonly invalid: number }, []>(
      `SELECT EXISTS (
         SELECT 1 FROM request_payloads AS p JOIN requests AS r ON r.id = p.request_id
         WHERE r.resolution_state <> 'pending'
       ) OR EXISTS (
         SELECT 1 FROM request_wait_edges AS e JOIN requests AS r ON r.id = e.request_id
         WHERE r.resolution_state <> 'pending'
       ) OR EXISTS (
         SELECT 1 FROM request_results AS rr JOIN requests AS r ON r.id = rr.request_id
         WHERE r.result_state <> 'available'
       ) OR EXISTS (
         SELECT 1 FROM requests AS r
         WHERE (r.resolution_state = 'pending' AND (
           NOT EXISTS (SELECT 1 FROM request_payloads WHERE request_id = r.id) OR
           NOT EXISTS (
             SELECT 1 FROM request_wait_edges AS edge
             WHERE edge.request_id = r.id AND edge.workspace_key = r.workspace_key
               AND edge.source_session_id = r.source_session_id
               AND edge.target_session_id = r.target_session_id
           )
         )) OR (r.resolution_state <> 'pending' AND (
           EXISTS (SELECT 1 FROM request_payloads WHERE request_id = r.id) OR
           EXISTS (SELECT 1 FROM request_wait_edges WHERE request_id = r.id)
         )) OR (r.result_state = 'available') <> EXISTS (
           SELECT 1 FROM request_results WHERE request_id = r.id
         ) OR (r.result_expires_at_ms IS NOT NULL AND (
           typeof(r.result_expires_at_ms) <> 'integer' OR
           r.result_expires_at_ms < 0 OR r.result_expires_at_ms > 9007199254740991
         ))
       ) AS invalid`,
    )
    .get()?.invalid;
  if (invalid !== 0) {
    throw new StoreIntegrityError("Legacy request lifecycle state failed migration audit.");
  }
}

function auditRequestSubmittingCeiling(database: Database): void {
  const exceeded = database
    .query<{ readonly exceeded: number }, []>(
      `SELECT EXISTS (
         SELECT workspace_key FROM requests INDEXED BY requests_submitting_recovery
         WHERE delivery_state = 'submitting' GROUP BY workspace_key
         HAVING count(*) > ${submittingRequestsPerWorkspaceHardCeiling}
       ) AS exceeded`,
    )
    .get()?.exceeded;
  if (exceeded !== 0) {
    throw new StoreIntegrityError("Legacy submitting request state exceeds its hard ceiling.");
  }
}

function auditManagedSessionCeiling(database: Database): void {
  const exceeded = database
    .query<{ readonly exceeded: number }, []>(
      `SELECT EXISTS (
         SELECT workspace_key FROM managed_sessions
         WHERE provenance_state NOT IN ('unresolved','deleted') GROUP BY workspace_key
         HAVING count(*) > ${managedSessionsPerWorkspaceHardCeiling}
       ) AS exceeded`,
    )
    .get()?.exceeded;
  if (exceeded !== 0) {
    throw new StoreIntegrityError("Legacy managed-session provenance exceeds its hard ceiling.");
  }
}

function auditBeforeMigration(database: Database, version: number): void {
  if (version === 5) auditRequestLifecycleInvariants(database);
  if (version === 7) auditRequestSubmittingCeiling(database);
  if (version === 11) auditManagedSessionCeiling(database);
}

export function applyMigrations(database: Database, nowMs: number, takeoverGraceMs: number): void {
  validateMigrationChecksums();
  const bootstrap = database.transaction(() => {
    const current = readCurrentVersion(database);
    const hasMigrationTable = tableExists(database, "schema_migrations");
    if (!hasMigrationTable && current !== 0) {
      throw new StoreIntegrityError("SQLite migration metadata is incomplete.");
    }
    if (current < sqliteStoreMigrations.length) {
      // This check is deliberately before the first DDL statement. BEGIN IMMEDIATE serializes
      // bootstrappers, while the persisted lease prevents schema changes beneath a live owner.
      assertNoActiveOwnershipLease(database, nowMs, takeoverGraceMs);
    }
    if (!hasMigrationTable) {
      database.exec(`CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
      ) STRICT;`);
    }
    validateAppliedHistory(database, current);
    for (const migration of sqliteStoreMigrations) {
      if (migration.version <= current) continue;
      auditBeforeMigration(database, migration.version);
      database.exec(migration.sql);
      database.run(
        "INSERT INTO schema_migrations(version, checksum, applied_at_ms) VALUES (?, ?, ?)",
        [migration.version, migration.checksum, nowMs],
      );
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
  });
  bootstrap.immediate();
}
