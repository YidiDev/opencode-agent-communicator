import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

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
