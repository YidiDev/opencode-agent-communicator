import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  applyMigrations,
  migrationSqlChecksum,
  sqliteStoreMigrations,
} from "../../../../src/adapters/store/migrations";

function migratedDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, 0, 0);
  database.run("INSERT INTO workspaces(workspace_key, created_at_ms) VALUES ('schema-test', 0)");
  return database;
}

function details(
  database: Database,
  sql: string,
  parameters: readonly (string | number)[],
): string {
  return database
    .query<{ readonly detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...parameters)
    .map((row) => row.detail)
    .join(" | ");
}

describe("request migration and query plans", () => {
  test("upgrades every published schema prefix through v4 without losing legacy rows", () => {
    for (const prefix of [1, 2, 3]) {
      const database = new Database(":memory:", { strict: true });
      database.exec("PRAGMA foreign_keys = ON");
      database.exec(`CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, checksum TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
      ) STRICT;`);
      for (const migration of sqliteStoreMigrations.slice(0, prefix)) {
        database.exec(migration.sql);
        database.run(
          "INSERT INTO schema_migrations(version, checksum, applied_at_ms) VALUES (?, ?, 0)",
          [migration.version, migration.checksum],
        );
        database.exec(`PRAGMA user_version = ${migration.version}`);
      }
      database.run("INSERT INTO workspaces(workspace_key, created_at_ms) VALUES ('legacy', 1)");
      database.run(
        `INSERT INTO deliveries(id, workspace_key, source_session_id, target_session_id,
           native_message_id, state, prepared_envelope, content_byte_length, content_sha256,
           created_at_ms, updated_at_ms)
         VALUES (?, 'legacy', 'ses_source', 'ses_target', ?, 'prepared', '{}', 1, ?, 1, 1)`,
        [`dlv_${"1".repeat(32)}`, `msg_${"2".repeat(32)}`, "a".repeat(64)],
      );
      if (prefix === 3) {
        database.run(
          `INSERT INTO ownership(singleton, owner_id, fencing_token, acquired_wall_ms,
             renewed_wall_ms, expires_wall_ms, owner_label, released_wall_ms)
           VALUES (1, ?, 1, 1, 1, 2, 'legacy', 1)`,
          ["12345678-1234-1234-1234-123456789abc"],
        );
      }
      applyMigrations(database, 10, 0);
      expect(
        database
          .query<{ value: number }, []>("SELECT user_version AS value FROM pragma_user_version")
          .get()?.value,
      ).toBe(4);
      expect(
        database.query<{ count: number }, []>("SELECT count(*) AS count FROM deliveries").get()
          ?.count,
      ).toBe(1);
      if (prefix === 3) {
        expect(
          database.query<{ count: number }, []>("SELECT count(*) AS count FROM ownership").get()
            ?.count,
        ).toBe(1);
      }
      database.close(true);
    }
  });

  test("binds migration four checksum and reverses populated additive tables", () => {
    const database = migratedDatabase();
    const migration = sqliteStoreMigrations[3];
    if (!migration) throw new Error("migration four is absent");
    expect(migration.checksum).toBe(migrationSqlChecksum(migration.sql));
    database.run(
      `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
         native_message_id, kind, resolution_state, delivery_state, result_state,
         payload_byte_length, retained_content_byte_length, payload_sha256,
         created_at_ms, updated_at_ms, deadline_at_ms)
       VALUES (?, 'schema-test', 'ses_source', 'ses_target', ?, 'wait', 'pending',
         'prepared', 'none', 1, 4, ?, 1, 1, 1001)`,
      [`req_${"1".repeat(32)}`, `msg_${"2".repeat(32)}`, "a".repeat(64)],
    );
    database.run(
      "INSERT INTO request_payloads(request_id, payload_json, envelope_json) VALUES (?, '{}', '{}')",
      [`req_${"1".repeat(32)}`],
    );
    database.exec(migration.downSql);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'requests'",
        )
        .get()?.count,
    ).toBe(0);
    database.close(true);
  });

  test("uses bounded recovery, quota, edge, expiry, and resolved-GC indexes", () => {
    const database = migratedDatabase();
    const prepared = details(
      database,
      `SELECT id FROM requests INDEXED BY requests_prepared_recovery
       WHERE workspace_key = ? AND resolution_state = 'pending' AND delivery_state = 'prepared'
         AND deadline_at_ms > ? ORDER BY created_at_ms, id LIMIT ?`,
      ["schema-test", 0, 10],
    );
    const submitting = details(
      database,
      `SELECT id FROM requests INDEXED BY requests_submitting_recovery
       WHERE workspace_key = ? AND delivery_state = 'submitting' AND claimed_fencing_token != ?
       ORDER BY created_at_ms, id LIMIT ?`,
      ["schema-test", 1, 10],
    );
    const quota = details(
      database,
      `SELECT COALESCE(sum(retained_content_byte_length), 0) FROM requests
       WHERE workspace_key = ? AND resolution_state = 'pending' AND source_session_id = ?`,
      ["schema-test", "ses_source"],
    );
    const edge = details(
      database,
      `WITH RECURSIVE reachable(node) AS (
         VALUES (?) UNION SELECT edge.target_session_id FROM reachable
         JOIN request_wait_edges AS edge INDEXED BY request_edges_source
           ON edge.workspace_key = ? AND edge.source_session_id = reachable.node
         LIMIT ?
       ) SELECT node FROM reachable`,
      ["ses_source", "schema-test", 11],
    );
    const expiry = details(
      database,
      `SELECT id FROM requests WHERE workspace_key = ? AND result_state = 'available'
       ORDER BY result_expires_at_ms, id LIMIT ?`,
      ["schema-test", 10],
    );
    const gc = details(
      database,
      `SELECT id FROM requests WHERE workspace_key = ? AND resolution_state <> 'pending'
         AND result_state <> 'available' ORDER BY resolved_at_ms, id LIMIT ?`,
      ["schema-test", 10],
    );
    expect(prepared).toContain("requests_prepared_recovery");
    expect(prepared).not.toContain("TEMP B-TREE");
    expect(submitting).toContain("requests_submitting_recovery");
    expect(quota).toContain("requests_pending_source_quota");
    expect(edge).toContain("request_edges_source");
    expect(expiry).toContain("requests_result_expiry");
    expect(gc).toContain("requests_metadata_gc");
    database.close(true);
  });

  test("rejects retained-state and correlated-edge constraint violations", () => {
    const database = migratedDatabase();
    const insert = (retained: number | null) =>
      database.run(
        `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
           native_message_id, kind, resolution_state, delivery_state, result_state,
           payload_byte_length, retained_content_byte_length, payload_sha256,
           created_at_ms, updated_at_ms, deadline_at_ms)
         VALUES (?, 'schema-test', 'ses_source', 'ses_target', ?, 'wait', 'pending',
           'prepared', 'none', 1, ?, ?, 1, 1, 1001)`,
        [`req_${"3".repeat(32)}`, `msg_${"4".repeat(32)}`, retained, "b".repeat(64)],
      );
    expect(() => insert(null)).toThrow();
    insert(4);
    expect(() =>
      database.run(
        `INSERT INTO request_wait_edges(request_id, workspace_key, source_session_id, target_session_id)
         VALUES (?, 'schema-test', 'ses_other', 'ses_target')`,
        [`req_${"3".repeat(32)}`],
      ),
    ).toThrow();
    database.close(true);
  });
});
