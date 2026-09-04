import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeLinuxPathSyscalls } from "../../../../src/adapters/store/linux-private-path";
import {
  applyMigrations,
  migrationSqlChecksum,
  sqliteStoreMigrations,
  validateMigrationChecksums,
} from "../../../../src/adapters/store/migrations";
import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("continuously binds every migration declaration to canonical forward SQL", () => {
  expect(() => validateMigrationChecksums()).not.toThrow();
  for (const migration of sqliteStoreMigrations) {
    expect(migration.checksum).toBe(migrationSqlChecksum(migration.sql));
    expect(migrationSqlChecksum(`${migration.sql}\n-- divergent`)).not.toBe(migration.checksum);
  }
  const mutable = sqliteStoreMigrations[0] as { checksum: string };
  const declared = mutable.checksum;
  try {
    mutable.checksum = "sha256:invalid";
    expect(() => validateMigrationChecksums()).toThrow();
  } finally {
    mutable.checksum = declared;
  }
});

test("publishes the append-only session-stop lookup migration with its exact checksum", () => {
  const migration = sqliteStoreMigrations[8];
  expect(migration).toMatchObject({
    version: 9,
    checksum: "sha256:c05c16d0b653020fc2ed304031f983d67f26edbe9f9f043ee0ffe3fdca0aa04d",
  });
  const database = new Database(":memory:", { strict: true });
  applyMigrations(database, 1, 0);
  const indexes = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'requests_stop_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  expect(indexes).toEqual(["requests_stop_source_v9", "requests_stop_target_v9"]);
  database.close(true);
});

test("appends the source-scoped session-start schema after published v9", () => {
  const migration = sqliteStoreMigrations[9];
  expect(migration).toMatchObject({
    version: 10,
    checksum: "sha256:bd82b5aa40ab8416ab7c1d44b852505880555a1cd2b119c59448157a77f11274",
  });
  const database = new Database(":memory:", { strict: true });
  applyMigrations(database, 1, 0);
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '%start%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  expect(tables).toEqual(["start_operation_payloads", "start_operations", "start_rate_events"]);
  expect(
    database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'managed_sessions'",
      )
      .get()?.name,
  ).toBe("managed_sessions");
  const recoveryPlan = database
    .query<{ detail: string }, [string, number, number]>(
      `EXPLAIN QUERY PLAN SELECT id FROM start_operations
       WHERE workspace_key = ? AND (
         creation_state IN ('prepared','submitting','outcome_unknown') OR
         title_state IN ('prepared','submitting') OR
         admission_state IN ('prepared','submitting')) AND (
          creation_state IN ('prepared','outcome_unknown') OR
         (creation_state = 'created' AND title_state = 'prepared') OR
         (creation_state = 'created' AND admission_state = 'prepared') OR
         ((creation_state = 'submitting' OR title_state = 'submitting' OR
           admission_state = 'submitting') AND claimed_fencing_token <> ?))
       ORDER BY created_at_ms, id LIMIT ?`,
    )
    .all("workspace", 1, 100)
    .map((row) => row.detail)
    .join(" | ");
  expect(recoveryPlan).toContain("start_operations_recovery_v10");
  database.close(true);
});

test("appends managed-session reconciliation quota enforcement without rewriting v10", () => {
  const migration = sqliteStoreMigrations[10];
  expect(migration).toMatchObject({
    version: 11,
    checksum: "sha256:ed970b8cd128824271eca05049a889d225a94646c5c0f9a1810bbba788db5cf5",
  });
  expect(sqliteStoreMigrations[9]?.checksum).toBe(
    "sha256:bd82b5aa40ab8416ab7c1d44b852505880555a1cd2b119c59448157a77f11274",
  );
  const database = new Database(":memory:", { strict: true });
  applyMigrations(database, 1, 0);
  expect(
    database
      .query<{ name: string }, []>(
        `SELECT name FROM pragma_table_info('start_operations')
         WHERE name = 'managed_session_limit'`,
      )
      .get()?.name,
  ).toBe("managed_session_limit");
  expect(
    database
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_schema WHERE type = 'trigger'
         AND name = 'managed_sessions_ceiling_update_v11'`,
      )
      .get()?.name,
  ).toBe("managed_sessions_ceiling_update_v11");
  database.close(true);
});

test("appends checked terminal-linked start provenance without rewriting start state history", () => {
  const migration = sqliteStoreMigrations[14];
  expect(migration).toMatchObject({
    version: 15,
    checksum: "sha256:f4ab984ddfa044ca0b203bbb0d9b35cbc63b8a2cc004d2402bdf723c33047c09",
  });
  const database = new Database(":memory:", { strict: true });
  applyMigrations(database, 1, 0);
  expect(
    database
      .query<{ name: string }, []>(
        `SELECT name FROM pragma_table_info('start_operations') WHERE name = 'terminal_reason'`,
      )
      .get()?.name,
  ).toBe("terminal_reason");
  const triggers = database
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_schema WHERE type = 'trigger'
       AND name LIKE 'start_operations_terminal_%_v15' ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
  expect(triggers).toEqual([
    "start_operations_terminal_private_guard_v15",
    "start_operations_terminal_reason_insert_v15",
    "start_operations_terminal_reason_update_v15",
  ]);
  database.close(true);
});

test("v11 safely assigns the hard ceiling to preexisting v10 operations", () => {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, checksum TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
  ) STRICT;`);
  for (const migration of sqliteStoreMigrations.slice(0, 10)) {
    database.exec(migration.sql);
    database.run(
      "INSERT INTO schema_migrations(version, checksum, applied_at_ms) VALUES (?, ?, 0)",
      [migration.version, migration.checksum],
    );
    database.exec(`PRAGMA user_version = ${migration.version}`);
  }
  database.run("INSERT INTO workspaces(workspace_key, created_at_ms) VALUES ('legacy-start', 1)");
  database.run(
    `INSERT INTO start_operations(id, workspace_key, source_session_id, idempotency_key,
       arguments_sha256, session_id, native_message_id, title_requested,
       unresolved_provenance_limit, creation_state, title_state, admission_state,
       created_at_ms, updated_at_ms)
     VALUES (?, 'legacy-start', 'ses_source', 'legacy', ?, ?, ?, 0, 1,
       'failed', 'not_started', 'not_started', 1, 1)`,
    [`op_${"1".repeat(32)}`, "a".repeat(64), `ses_${"2".repeat(32)}`, `msg_${"3".repeat(32)}`],
  );

  applyMigrations(database, 2, 0);
  expect(
    database
      .query<{ limit: number }, []>("SELECT managed_session_limit AS `limit` FROM start_operations")
      .get()?.limit,
  ).toBe(1_024);
  expect(
    database
      .query<{ version: number }, []>("SELECT user_version AS version FROM pragma_user_version")
      .get()?.version,
  ).toBe(16);
  database.close(true);
});

test("v11 refuses to bless legacy managed provenance already above the hard ceiling", () => {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, checksum TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
  ) STRICT;`);
  for (const migration of sqliteStoreMigrations.slice(0, 10)) {
    database.exec(migration.sql);
    database.run(
      "INSERT INTO schema_migrations(version, checksum, applied_at_ms) VALUES (?, ?, 0)",
      [migration.version, migration.checksum],
    );
    database.exec(`PRAGMA user_version = ${migration.version}`);
  }
  database.run(
    "INSERT INTO workspaces(workspace_key, created_at_ms) VALUES ('legacy-overflow', 1)",
  );
  const insertOperation = database.prepare(
    `INSERT INTO start_operations(id, workspace_key, source_session_id, idempotency_key,
       arguments_sha256, session_id, native_message_id, title_requested,
       unresolved_provenance_limit, creation_state, title_state, admission_state,
       created_at_ms, updated_at_ms)
     VALUES (?, 'legacy-overflow', 'ses_source', ?, ?, ?, ?, 0, 128,
       'prepared', 'not_started', 'not_started', 1, 1)`,
  );
  const insertProvenance = database.prepare(
    `INSERT INTO managed_sessions(session_id, workspace_key, source_session_id, operation_id,
       provenance_state, created_at_ms)
     VALUES (?, 'legacy-overflow', 'ses_source', ?, 'unresolved', 1)`,
  );
  database.transaction(() => {
    for (let index = 0; index <= 1_024; index += 1) {
      const encoded = index.toString(16).padStart(32, "0");
      insertOperation.run(
        `op_${encoded}`,
        `legacy:${index}`,
        index.toString(16).padStart(64, "0"),
        `ses_${encoded}`,
        `msg_${encoded}`,
      );
      insertProvenance.run(`ses_${encoded}`, `op_${encoded}`);
      database.run("UPDATE start_operations SET creation_state = 'created' WHERE id = ?", [
        `op_${encoded}`,
      ]);
      // This transition had no managed hard-ceiling trigger in v10.
      database.run(
        "UPDATE managed_sessions SET provenance_state = 'created' WHERE session_id = ?",
        [`ses_${encoded}`],
      );
    }
  })();

  expect(() => applyMigrations(database, 2, 0)).toThrow(
    "Legacy managed-session provenance exceeds its hard ceiling.",
  );
  expect(
    database
      .query<{ version: number }, []>("SELECT user_version AS version FROM pragma_user_version")
      .get()?.version,
  ).toBe(10);
  expect(
    database
      .query<{ found: number }, []>(
        `SELECT EXISTS (
           SELECT 1 FROM pragma_table_info('start_operations')
           WHERE name = 'managed_session_limit'
         ) AS found`,
      )
      .get()?.found,
  ).toBe(0);
  database.close(true);
});

test("the hard ceiling trigger rejects a non-counted to counted provenance transition", () => {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, 1, 0);
  database.run("INSERT INTO workspaces(workspace_key, created_at_ms) VALUES ('hard-trigger', 1)");
  const insertOperation = database.prepare(
    `INSERT INTO start_operations(id, workspace_key, source_session_id, idempotency_key,
       arguments_sha256, session_id, native_message_id, title_requested,
       unresolved_provenance_limit, creation_state, title_state, admission_state,
       created_at_ms, updated_at_ms, managed_session_limit)
     VALUES (?, 'hard-trigger', 'ses_source', ?, ?, ?, ?, 0, 128,
       'prepared', 'not_started', 'not_started', 1, 1, 1024)`,
  );
  const insertProvenance = database.prepare(
    `INSERT INTO managed_sessions(session_id, workspace_key, source_session_id, operation_id,
       provenance_state, created_at_ms) VALUES (?, 'hard-trigger', 'ses_source', ?, ?, 1)`,
  );
  database.transaction(() => {
    for (let index = 0; index <= 1_024; index += 1) {
      const encoded = index.toString(16).padStart(32, "0");
      const operationId = `op_${encoded}`;
      const sessionId = `ses_${encoded}`;
      insertOperation.run(
        operationId,
        `hard:${index}`,
        index.toString(16).padStart(64, "0"),
        sessionId,
        `msg_${encoded}`,
      );
      insertProvenance.run(sessionId, operationId, index === 1_024 ? "unresolved" : "reserved");
      if (index < 1_024) {
        database.run("UPDATE start_operations SET creation_state = 'created' WHERE id = ?", [
          operationId,
        ]);
      }
    }
  })();

  expect(() =>
    database.run("UPDATE managed_sessions SET provenance_state = 'created' WHERE session_id = ?", [
      `ses_${(1_024).toString(16).padStart(32, "0")}`,
    ]),
  ).toThrow("workspace managed session ceiling exceeded");
  expect(
    database
      .query<{ state: string }, [string]>(
        "SELECT provenance_state AS state FROM managed_sessions WHERE session_id = ?",
      )
      .get(`ses_${(1_024).toString(16).padStart(32, "0")}`)?.state,
  ).toBe("unresolved");
  database.close(true);
});

test("an over-ceiling current-owner close invokes checkpointing before release", async () => {
  const root = mkdtempSync(join(tmpdir(), "communicator-close-capacity-"));
  roots.push(root);
  const workspace = validateWorkspaceKey("workspace:close-capacity");
  if (!workspace.ok) throw new Error("invalid fixture");
  const descriptors = new Map<number, string>();
  let oversized = false;
  const store = new LinuxBunSqliteStore({
    stateDirectory: join(root, "state"),
    workspaceKey: workspace.value,
    ownerId: "close-capacity",
    limits: { databaseBytes: 8 * 1024 * 1024 },
    linuxPathSyscalls: {
      ...nodeLinuxPathSyscalls,
      open: (path, flags, mode) => {
        const descriptor = nodeLinuxPathSyscalls.open(path, flags, mode);
        descriptors.set(descriptor, path);
        return descriptor;
      },
      fstat: (descriptor) => {
        const value = nodeLinuxPathSyscalls.fstat(descriptor);
        return oversized && descriptors.get(descriptor)?.endsWith("/communicator.sqlite3")
          ? { ...value, size: 9 * 1024 * 1024 }
          : value;
      },
    },
  });
  await store.acquire();
  oversized = true;
  expect(() => store.close()).toThrow("configured byte ceiling");
});

test("stale-token ownership inspection never checkpoints an over-ceiling store", async () => {
  const root = mkdtempSync(join(tmpdir(), "communicator-stale-inspection-"));
  roots.push(root);
  const workspace = validateWorkspaceKey("workspace:stale-inspection");
  if (!workspace.ok) throw new Error("invalid fixture");
  const descriptors = new Map<number, string>();
  let oversized = false;
  const store = new LinuxBunSqliteStore({
    stateDirectory: join(root, "state"),
    workspaceKey: workspace.value,
    ownerId: "stale-inspection",
    limits: { databaseBytes: 8 * 1024 * 1024 },
    linuxPathSyscalls: {
      ...nodeLinuxPathSyscalls,
      open: (path, flags, mode) => {
        const descriptor = nodeLinuxPathSyscalls.open(path, flags, mode);
        descriptors.set(descriptor, path);
        return descriptor;
      },
      fstat: (descriptor) => {
        const value = nodeLinuxPathSyscalls.fstat(descriptor);
        return oversized && descriptors.get(descriptor)?.endsWith("/communicator.sqlite3")
          ? { ...value, size: 9 * 1024 * 1024 }
          : value;
      },
    },
  });
  const token = await store.acquire();
  oversized = true;
  const blocker = new Database(store.databasePath, { strict: true });
  blocker.exec("BEGIN IMMEDIATE");
  expect(await store.isCurrent((Number(token) + 1) as typeof token)).toBeFalse();
  blocker.exec("ROLLBACK");
  blocker.close(true);
  oversized = false;
  store.close();
});

test("current-token renewal retains fail-closed capacity protection", async () => {
  const root = mkdtempSync(join(tmpdir(), "communicator-renewal-capacity-"));
  roots.push(root);
  const workspace = validateWorkspaceKey("workspace:renewal-capacity");
  if (!workspace.ok) throw new Error("invalid fixture");
  const descriptors = new Map<number, string>();
  let oversized = false;
  let now = 10_000;
  const store = new LinuxBunSqliteStore({
    stateDirectory: join(root, "state"),
    workspaceKey: workspace.value,
    ownerId: "renewal-capacity",
    leaseDurationMs: 1_000,
    takeoverGraceMs: 100,
    nowWallMs: () => now,
    nowMonotonicMs: () => now,
    limits: { databaseBytes: 8 * 1024 * 1024 },
    linuxPathSyscalls: {
      ...nodeLinuxPathSyscalls,
      open: (path, flags, mode) => {
        const descriptor = nodeLinuxPathSyscalls.open(path, flags, mode);
        descriptors.set(descriptor, path);
        return descriptor;
      },
      fstat: (descriptor) => {
        const value = nodeLinuxPathSyscalls.fstat(descriptor);
        return oversized && descriptors.get(descriptor)?.endsWith("/communicator.sqlite3")
          ? { ...value, size: 9 * 1024 * 1024 }
          : value;
      },
    },
  });
  const token = await store.acquire();
  const initialInspection = new Database(store.databasePath, { readonly: true, strict: true });
  const before = initialInspection
    .query<{ readonly renewedAtMs: number }, []>(
      "SELECT renewed_wall_ms AS renewedAtMs FROM ownership WHERE singleton = 1",
    )
    .get();
  initialInspection.close(true);
  now += 400;
  oversized = true;
  await expect(store.isCurrent(token)).rejects.toThrow("configured byte ceiling");
  const inspection = new Database(store.databasePath, { readonly: true, strict: true });
  expect(
    inspection
      .query<{ readonly renewedAtMs: number }, []>(
        "SELECT renewed_wall_ms AS renewedAtMs FROM ownership WHERE singleton = 1",
      )
      .get(),
  ).toEqual(before);
  inspection.close(true);
  oversized = false;
  store.close();
});

test("an explicit release permits migration immediately without waiting for grace", async () => {
  const root = mkdtempSync(join(tmpdir(), "communicator-release-migration-"));
  roots.push(root);
  const workspace = validateWorkspaceKey("workspace:migration-release");
  if (!workspace.ok) throw new Error("invalid fixture");
  const now = 10_000;
  const owner = new LinuxBunSqliteStore({
    stateDirectory: join(root, "state"),
    workspaceKey: workspace.value,
    ownerId: "release-before-migration",
    leaseDurationMs: 1_000,
    takeoverGraceMs: 100,
    nowWallMs: () => now,
    nowMonotonicMs: () => now,
  });
  await owner.acquire();
  owner.close();

  const sql = "CREATE TABLE released_migration_probe(id INTEGER PRIMARY KEY) STRICT;";
  const fixture = {
    version: sqliteStoreMigrations.length + 1,
    checksum: migrationSqlChecksum(sql),
    sql,
    downSql: "DROP TABLE released_migration_probe;",
  };
  const mutable = sqliteStoreMigrations as Array<typeof fixture>;
  mutable.push(fixture);
  const database = new Database(owner.databasePath, { strict: true });
  try {
    expect(() => applyMigrations(database, now, 100)).not.toThrow();
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE name = 'released_migration_probe'",
        )
        .get()?.name,
    ).toBe("released_migration_probe");
  } finally {
    database.close(true);
    mutable.pop();
  }
});
