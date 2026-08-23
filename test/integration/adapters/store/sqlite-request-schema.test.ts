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

function downgradeToMigrationFour(database: Database): void {
  const migrationFive = sqliteStoreMigrations[4];
  if (!migrationFive) throw new Error("migration five is absent");
  database.exec(migrationFive.downSql);
  database.run("DELETE FROM schema_migrations WHERE version = 5");
  database.exec("PRAGMA user_version = 4");
}

function insertLegacyPendingRequest(database: Database, requestId: string): void {
  database.run(
    `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
       native_message_id, kind, resolution_state, delivery_state, result_state,
       payload_byte_length, retained_content_byte_length, payload_sha256,
       created_at_ms, updated_at_ms, deadline_at_ms)
     VALUES (?, 'schema-test', 'ses_source', 'ses_target', ?, 'wait', 'pending',
       'prepared', 'none', 2, 4, ?, 1, 1, 1001)`,
    [requestId, `msg_${requestId.slice(4)}`, "d".repeat(64)],
  );
  database.run(
    "INSERT INTO request_payloads(request_id, payload_json, envelope_json) VALUES (?, '{}', '{}')",
    [requestId],
  );
  database.run(
    `INSERT INTO request_wait_edges(request_id, workspace_key, source_session_id, target_session_id)
     VALUES (?, 'schema-test', 'ses_source', 'ses_target')`,
    [requestId],
  );
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
  test("fresh migration records exact history and keeps published v1-v4 checksums unchanged", () => {
    const database = migratedDatabase();
    expect(sqliteStoreMigrations.slice(0, 4).map((migration) => migration.checksum)).toEqual([
      "sha256:929ff898b24a6bfefa276939fee895e41185ed9c58bd59c3f2c3359f4daa8a86",
      "sha256:01fd21d54481dc3dffea01f46da930815a5bed8f145d31397f0049d446d4e096",
      "sha256:cd0aae4f4eb012325f46a511194a4b42f34f2009a059a9ed0b130e32f41b1d84",
      "sha256:26e2bda38b4851017143a4fd0269cf542b4f6c4a96a64f1654e8b8c527219470",
    ]);
    expect(
      database
        .query<{ version: number; checksum: string }, []>(
          "SELECT version, checksum FROM schema_migrations ORDER BY version",
        )
        .all(),
    ).toEqual(sqliteStoreMigrations.map(({ version, checksum }) => ({ version, checksum })));
    database.close(true);
  });

  test("upgrades every published schema prefix through v5 without losing legacy rows", () => {
    for (const prefix of [1, 2, 3, 4]) {
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
      if (prefix >= 3) {
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
      ).toBe(5);
      expect(
        database.query<{ count: number }, []>("SELECT count(*) AS count FROM deliveries").get()
          ?.count,
      ).toBe(1);
      if (prefix >= 3) {
        expect(
          database.query<{ count: number }, []>("SELECT count(*) AS count FROM ownership").get()
            ?.count,
        ).toBe(1);
      }
      database.close(true);
    }
  });

  test("binds migrations four and five and reverses their additive objects", () => {
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
    const migrationFive = sqliteStoreMigrations[4];
    if (!migrationFive) throw new Error("migration five is absent");
    expect(migrationFive.checksum).toBe(migrationSqlChecksum(migrationFive.sql));
    database.exec(migrationFive.downSql);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE 'requests_available_%_quota'",
        )
        .get()?.count,
    ).toBe(0);
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
});

describe("request migration query plans and constraints", () => {
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
    const availableSource = details(
      database,
      `SELECT count(*), COALESCE(sum(result_byte_length), 0)
       FROM requests INDEXED BY requests_available_source_quota
       WHERE workspace_key = ? AND source_session_id = ? AND result_state = 'available'`,
      ["schema-test", "ses_source"],
    );
    const availableTarget = details(
      database,
      `SELECT count(*), COALESCE(sum(result_byte_length), 0)
       FROM requests INDEXED BY requests_available_target_quota
       WHERE workspace_key = ? AND target_session_id = ? AND result_state = 'available'`,
      ["schema-test", "ses_target"],
    );
    const availableWorkspace = details(
      database,
      `SELECT count(*), COALESCE(sum(result_byte_length), 0)
       FROM requests INDEXED BY requests_available_workspace_quota
       WHERE workspace_key = ? AND result_state = 'available'`,
      ["schema-test"],
    );
    expect(prepared).toContain("requests_prepared_recovery");
    expect(prepared).not.toContain("TEMP B-TREE");
    expect(submitting).toContain("requests_submitting_recovery");
    expect(quota).toContain("requests_pending_source_quota");
    expect(edge).toContain("request_edges_source");
    expect(expiry).toContain("requests_result_expiry");
    expect(gc).toContain("requests_metadata_gc");
    expect(availableSource).toContain("COVERING INDEX requests_available_source_quota");
    expect(availableTarget).toContain("COVERING INDEX requests_available_target_quota");
    expect(availableWorkspace).toContain("COVERING INDEX requests_available_workspace_quota");
    expect(`${availableSource} ${availableTarget} ${availableWorkspace}`).not.toContain(
      "TEMP B-TREE",
    );
    expect(`${availableSource} ${availableTarget} ${availableWorkspace}`).not.toContain(
      "SCAN requests",
    );
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

describe("request migration five lifecycle invariants", () => {
  test("migration five audits legacy rows and its lifecycle triggers fail closed", () => {
    const database = migratedDatabase();
    const requestId = `req_${"5".repeat(32)}`;
    database.run(
      `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
         native_message_id, kind, resolution_state, delivery_state, result_state,
         payload_byte_length, retained_content_byte_length, payload_sha256,
         created_at_ms, updated_at_ms, deadline_at_ms)
       VALUES (?, 'schema-test', 'ses_source', 'ses_target', ?, 'wait', 'pending',
         'prepared', 'none', 2, 4, ?, 1, 1, 1001)`,
      [requestId, `msg_${"6".repeat(32)}`, "c".repeat(64)],
    );
    database.run(
      "INSERT INTO request_payloads(request_id, payload_json, envelope_json) VALUES (?, '{}', '{}')",
      [requestId],
    );
    database.run(
      `INSERT INTO request_wait_edges(request_id, workspace_key, source_session_id, target_session_id)
       VALUES (?, 'schema-test', 'ses_source', 'ses_target')`,
      [requestId],
    );
    expect(() =>
      database.run(
        `UPDATE requests SET resolution_state = 'cancelled', resolved_at_ms = 2,
           updated_at_ms = 2, retained_content_byte_length = NULL, payload_sha256 = NULL
         WHERE id = ?`,
        [requestId],
      ),
    ).toThrow();
    expect(() =>
      database.run("INSERT INTO request_results(request_id, result_json) VALUES (?, '{}')", [
        requestId,
      ]),
    ).toThrow();

    const migrationFive = sqliteStoreMigrations[4];
    if (!migrationFive) throw new Error("migration five is absent");
    database.exec(migrationFive.downSql);
    database.run("DELETE FROM schema_migrations WHERE version = 5");
    database.exec("PRAGMA user_version = 4");
    database.run(
      `UPDATE requests SET resolution_state = 'cancelled', resolved_at_ms = 2,
         updated_at_ms = 2, retained_content_byte_length = NULL, payload_sha256 = NULL
       WHERE id = ?`,
      [requestId],
    );
    expect(() => applyMigrations(database, 10, 0)).toThrow();
    expect(
      database
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM request_payloads WHERE request_id = ?",
        )
        .get(requestId)?.count,
    ).toBe(1);
    expect(
      database
        .query<{ version: number }, []>("SELECT user_version AS version FROM pragma_user_version")
        .get()?.version,
    ).toBe(4);
    database.close(true);
  });
});

describe("request migration five audit variants and triggers", () => {
  test("v4 to v5 audit rejects a pending request missing its payload row", () => {
    const database = migratedDatabase();
    downgradeToMigrationFour(database);
    const requestId = `req_${"d".repeat(32)}`;
    insertLegacyPendingRequest(database, requestId);
    database.run("DELETE FROM request_payloads WHERE request_id = ?", [requestId]);
    expect(() => applyMigrations(database, 10, 0)).toThrow();
    expect(
      database
        .query<{ version: number }, []>("SELECT user_version AS version FROM pragma_user_version")
        .get()?.version,
    ).toBe(4);
    database.close(true);
  });

  test("v4 to v5 audit rejects a pending request missing its exact wait edge", () => {
    const database = migratedDatabase();
    downgradeToMigrationFour(database);
    const requestId = `req_${"e".repeat(32)}`;
    insertLegacyPendingRequest(database, requestId);
    database.run("DELETE FROM request_wait_edges WHERE request_id = ?", [requestId]);
    expect(() => applyMigrations(database, 10, 0)).toThrow();
    expect(
      database
        .query<{ version: number }, []>("SELECT user_version AS version FROM pragma_user_version")
        .get()?.version,
    ).toBe(4);
    database.close(true);
  });

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each legacy corruption is built and audited independently.
  test("migration audit rejects every legacy result-child and unsafe-expiry inconsistency", () => {
    for (const variant of ["unavailable-child", "missing-child", "unsafe-expiry"] as const) {
      const database = migratedDatabase();
      const migrationFive = sqliteStoreMigrations[4];
      if (!migrationFive) throw new Error("migration five is absent");
      database.exec(migrationFive.downSql);
      database.run("DELETE FROM schema_migrations WHERE version = 5");
      database.exec("PRAGMA user_version = 4");
      const requestId =
        `req_${variant === "unavailable-child" ? "7" : variant === "missing-child" ? "8" : "9"}`.padEnd(
          36,
          variant === "unsafe-expiry" ? "9" : "8",
        );
      const availableAt = variant === "unsafe-expiry" ? 9_007_199_168_340_992 : 2;
      const expiry = availableAt + 86_400_000;
      database.run(
        `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
           native_message_id, kind, resolution_state, delivery_state, result_state,
           payload_byte_length, result_byte_length, result_sha256,
           created_at_ms, updated_at_ms, deadline_at_ms, resolved_at_ms,
           result_available_at_ms, result_expires_at_ms)
         VALUES (?, 'schema-test', 'ses_source', 'ses_target', ?, 'wait', 'reached',
           'prepared', 'available', 2, 15, ?, 1, ?, ?, ?, ?, ?)`,
        [
          requestId,
          `msg_${variant === "unavailable-child" ? "7" : variant === "missing-child" ? "8" : "9"}`.padEnd(
            36,
            "0",
          ),
          "a".repeat(64),
          availableAt,
          variant === "unsafe-expiry" ? 9_007_199_254_740_991 : 100,
          availableAt,
          availableAt,
          expiry,
        ],
      );
      if (variant !== "missing-child") {
        database.run("INSERT INTO request_results(request_id, result_json) VALUES (?, ?)", [
          requestId,
          '{"kind":"wait"}',
        ]);
      }
      if (variant === "unavailable-child") {
        database.run(
          `UPDATE requests SET result_state = 'expired', result_byte_length = NULL,
             result_sha256 = NULL, result_expired_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
          [expiry, expiry, requestId],
        );
      }
      expect(() => applyMigrations(database, 10, 0)).toThrow();
      expect(
        database
          .query<{ version: number }, []>("SELECT user_version AS version FROM pragma_user_version")
          .get()?.version,
      ).toBe(4);
      database.close(true);
    }
  });

  test("direct lifecycle triggers reject each invalid insert and transition at safe-integer boundaries", () => {
    const database = migratedDatabase();
    const cancelledId = `req_${"a".repeat(32)}`;
    database.run(
      `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
         native_message_id, kind, resolution_state, delivery_state, result_state,
         payload_byte_length, created_at_ms, updated_at_ms, deadline_at_ms, resolved_at_ms)
       VALUES (?, 'schema-test', 'ses_source', 'ses_target', ?, 'wait', 'cancelled',
         'prepared', 'none', 2, 1, 2, 100, 2)`,
      [cancelledId, `msg_${"a".repeat(32)}`],
    );
    expect(() =>
      database.run(
        "INSERT INTO request_payloads(request_id, payload_json, envelope_json) VALUES (?, '{}', '{}')",
        [cancelledId],
      ),
    ).toThrow();
    expect(() =>
      database.run(
        `INSERT INTO request_wait_edges(request_id, workspace_key, source_session_id, target_session_id)
         VALUES (?, 'schema-test', 'ses_source', 'ses_target')`,
        [cancelledId],
      ),
    ).toThrow();
    expect(() =>
      database.run("INSERT INTO request_results(request_id, result_json) VALUES (?, ?)", [
        cancelledId,
        '{"kind":"wait"}',
      ]),
    ).toThrow();

    const pendingId = `req_${"b".repeat(32)}`;
    database.run(
      `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
         native_message_id, kind, resolution_state, delivery_state, result_state,
         payload_byte_length, retained_content_byte_length, payload_sha256,
         created_at_ms, updated_at_ms, deadline_at_ms)
       VALUES (?, 'schema-test', 'ses_source2', 'ses_target2', ?, 'wait', 'pending',
         'prepared', 'none', 2, 4, ?, 1, 1, 100)`,
      [pendingId, `msg_${"b".repeat(32)}`, "b".repeat(64)],
    );
    database.run(
      "INSERT INTO request_payloads(request_id, payload_json, envelope_json) VALUES (?, '{}', '{}')",
      [pendingId],
    );
    database.run(
      `INSERT INTO request_wait_edges(request_id, workspace_key, source_session_id, target_session_id)
       VALUES (?, 'schema-test', 'ses_source2', 'ses_target2')`,
      [pendingId],
    );
    expect(() =>
      database.run(
        `UPDATE requests SET resolution_state = 'cancelled', resolved_at_ms = 2,
          updated_at_ms = 2, retained_content_byte_length = NULL, payload_sha256 = NULL WHERE id = ?`,
        [pendingId],
      ),
    ).toThrow();

    database.run("DELETE FROM request_payloads WHERE request_id = ?", [pendingId]);
    database.run("DELETE FROM request_wait_edges WHERE request_id = ?", [pendingId]);
    database.run(
      `UPDATE requests SET resolution_state = 'reached', resolved_at_ms = 2, updated_at_ms = 2,
        retained_content_byte_length = NULL, payload_sha256 = NULL, result_state = 'available',
        result_byte_length = 15, result_sha256 = ?,
        result_expires_at_ms = 9007199254740991, result_available_at_ms = 9007199168340991,
        resolved_at_ms = 9007199168340991, updated_at_ms = 9007199168340991,
        deadline_at_ms = 9007199254740991 WHERE id = ?`,
      ["c".repeat(64), pendingId],
    );
    database.run("INSERT INTO request_results(request_id, result_json) VALUES (?, ?)", [
      pendingId,
      '{"kind":"wait"}',
    ]);
    expect(() =>
      database.run(
        `UPDATE requests SET result_state = 'expired', result_byte_length = NULL,
          result_sha256 = NULL, result_expired_at_ms = 3 WHERE id = ?`,
        [pendingId],
      ),
    ).toThrow();
    expect(() =>
      database.run("UPDATE requests SET result_expires_at_ms = 9007199254740992 WHERE id = ?", [
        pendingId,
      ]),
    ).toThrow();
    expect(
      database
        .query<{ expiry: number }, [string]>(
          "SELECT result_expires_at_ms AS expiry FROM requests WHERE id = ?",
        )
        .get(pendingId)?.expiry,
    ).toBe(9_007_199_254_740_991);
    database.close(true);
  });
});
