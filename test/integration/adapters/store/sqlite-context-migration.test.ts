import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { applyMigrations, sqliteStoreMigrations } from "../../../../src/adapters/store/migrations";

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

test("v16 preserves ambiguous native admissions and fails only prepared work", () => {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, checksum TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
  ) STRICT;`);
  for (const migration of sqliteStoreMigrations.slice(0, 15)) {
    database.exec(migration.sql);
    database.run(
      "INSERT INTO schema_migrations(version, checksum, applied_at_ms) VALUES (?, ?, 0)",
      [migration.version, migration.checksum],
    );
    database.exec(`PRAGMA user_version = ${migration.version}`);
  }
  database.run("INSERT INTO workspaces(workspace_key, created_at_ms) VALUES ('schema-test', 0)");
  const prepared = `req_${"1".repeat(32)}`;
  const submitting = `req_${"2".repeat(32)}`;
  const unknown = `req_${"3".repeat(32)}`;
  for (const requestId of [prepared, submitting, unknown]) {
    insertLegacyPendingRequest(database, requestId);
  }
  for (const requestId of [submitting, unknown]) {
    database.run(
      `UPDATE requests SET delivery_state = 'submitting', submitted_at_ms = 2,
         claimed_fencing_token = 1, updated_at_ms = 2 WHERE id = ?`,
      [requestId],
    );
  }
  database.run(
    `UPDATE requests SET delivery_state = 'delivery_unknown', delivery_unknown_at_ms = 3,
       updated_at_ms = 3 WHERE id = ?`,
    [unknown],
  );

  applyMigrations(database, 10, 0);
  expect(
    database
      .query<{ id: string; state: string; resolution: string }, []>(
        `SELECT id, delivery_state AS state, resolution_state AS resolution
         FROM requests ORDER BY id`,
      )
      .all(),
  ).toEqual([
    { id: prepared, state: "delivery_failed", resolution: "delivery_failed" },
    { id: submitting, state: "submitting", resolution: "pending" },
    { id: unknown, state: "delivery_unknown", resolution: "pending" },
  ]);
  expect(
    database
      .query<{ requestId: string }, []>(
        "SELECT request_id AS requestId FROM request_payloads ORDER BY request_id",
      )
      .all(),
  ).toEqual([{ requestId: submitting }, { requestId: unknown }]);
  database.close(true);
});
