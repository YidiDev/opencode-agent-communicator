import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations, sqliteStoreMigrations } from "../../../../src/adapters/store/migrations";
import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import { participantRegistryPolicy, validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspace = valid(validateWorkspaceKey("workspace:registry"));
const source = valid(validateSessionId("ses_source"));
const target = valid(validateSessionId("ses_target"));
const child = valid(validateSessionId("ses_child"));

describe("communicator participant registry", () => {
  test("v17 deterministically backfills historical roots without inventing current activity", () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
    ) STRICT;`);
    for (const migration of sqliteStoreMigrations.slice(0, 16)) {
      database.exec(migration.sql);
      database.run(
        "INSERT INTO schema_migrations(version, checksum, applied_at_ms) VALUES (?, ?, 0)",
        [migration.version, migration.checksum],
      );
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    database.run("INSERT INTO workspaces(workspace_key, created_at_ms) VALUES (?, 1)", [workspace]);
    database.run(
      `INSERT INTO deliveries(id, workspace_key, source_session_id, target_session_id,
         native_message_id, state, prepared_envelope, content_byte_length, content_sha256,
         created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, 'prepared', '{}', 1, ?, 10, 20)`,
      [`dlv_${"1".repeat(32)}`, workspace, source, target, `msg_${"2".repeat(32)}`, "a".repeat(64)],
    );
    database.run(
      `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
         native_message_id, kind, resolution_state, delivery_state, result_state,
         payload_byte_length, created_at_ms, updated_at_ms, deadline_at_ms, resolved_at_ms)
       VALUES (?, ?, 'ses_requestSource', 'ses_requestTarget', ?, 'wait', 'cancelled',
         'prepared', 'none', 1, 5, 25, 30, 25)`,
      [`req_${"3".repeat(32)}`, workspace, `msg_${"4".repeat(32)}`],
    );
    const managedSessionId = `ses_${"5".repeat(32)}`;
    const operationId = `op_${"6".repeat(32)}`;
    database.run(
      `INSERT INTO start_operations(
         id, workspace_key, source_session_id, idempotency_key, arguments_sha256, session_id,
         native_message_id, title_requested, unresolved_provenance_limit, creation_state,
         title_state, admission_state, created_at_ms, updated_at_ms
       ) VALUES (?, ?, 'ses_managedSource', 'managed-key', ?, ?, ?, 0, 1, 'prepared',
         'not_started', 'not_started', 7, 7)`,
      [operationId, workspace, "b".repeat(64), managedSessionId, `msg_${"7".repeat(32)}`],
    );
    database.run(
      `INSERT INTO managed_sessions(session_id, workspace_key, source_session_id, operation_id,
         provenance_state, created_at_ms)
       VALUES (?, ?, 'ses_managedSource', ?, 'reserved', 7)`,
      [managedSessionId, workspace, operationId],
    );

    applyMigrations(database, 30, 0);
    expect(
      database
        .query<
          {
            sessionId: string;
            activity: string;
            visibility: string;
            firstMs: number;
            lastMs: number;
          },
          []
        >(
          `SELECT session_id AS sessionId, activity_status AS activity,
             visibility_state AS visibility, first_observed_at_ms AS firstMs,
             last_observed_at_ms AS lastMs
           FROM communicator_participants ORDER BY session_id`,
        )
        .all(),
    ).toEqual([
      {
        sessionId: managedSessionId,
        activity: "unknown",
        visibility: "unknown",
        firstMs: 7,
        lastMs: 7,
      },
      {
        sessionId: "ses_managedSource",
        activity: "unknown",
        visibility: "unknown",
        firstMs: 7,
        lastMs: 7,
      },
      {
        sessionId: "ses_requestSource",
        activity: "unknown",
        visibility: "unknown",
        firstMs: 5,
        lastMs: 25,
      },
      {
        sessionId: "ses_requestTarget",
        activity: "unknown",
        visibility: "unknown",
        firstMs: 5,
        lastMs: 25,
      },
      {
        sessionId: "ses_source",
        activity: "unknown",
        visibility: "unknown",
        firstMs: 10,
        lastMs: 20,
      },
      {
        sessionId: "ses_target",
        activity: "unknown",
        visibility: "unknown",
        firstMs: 10,
        lastMs: 20,
      },
    ]);
    expect(sqliteStoreMigrations[15]?.checksum).toBe(
      "sha256:6eea2005434a094e5db55f04c1fa41a0976a66c30c4c1f23cf54e277ae6d83e8",
    );
    database.close(true);
  });
});

describe("participant registry repository", () => {
  test("records fenced bounded observations and lists only root revalidation candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "communicator-participants-"));
    roots.push(root);
    let now = 1_000;
    const store = new LinuxBunSqliteStore({
      stateDirectory: join(root, "state"),
      workspaceKey: workspace,
      nowWallMs: () => now,
      nowMonotonicMs: () => now,
      leaseDurationMs: 10_000,
      takeoverGraceMs: 0,
    });
    const token = await store.acquire();
    expect(
      await store.recordParticipantObservations({
        fencingToken: token,
        workspaceKey: workspace,
        observedAtMs: now,
        observations: [
          {
            sessionId: source,
            rootKind: "root",
            parentSessionId: null,
            title: "Source",
            isArchived: false,
            activityStatus: "busy",
            visibility: "visible",
          },
          {
            sessionId: child,
            rootKind: "child",
            parentSessionId: source,
            activityStatus: "unknown",
            visibility: "visible",
          },
        ],
      }),
    ).toEqual({ ok: true, recorded: 2 });
    expect(
      await store.listParticipantRootCandidates({
        fencingToken: token,
        workspaceKey: workspace,
        limit: 10,
      }),
    ).toMatchObject([
      {
        id: "ses_source",
        rootKind: "root",
        title: "Source",
        activityStatus: "busy",
        activityObservedAtMs: 1_000,
        visibility: "visible",
      },
    ]);

    now = 1_100;
    expect(
      await store.recordParticipantObservations({
        fencingToken: token,
        workspaceKey: workspace,
        observedAtMs: 900,
        observations: [
          { sessionId: source, rootKind: "root", parentSessionId: null, activityStatus: "idle" },
        ],
      }),
    ).toEqual({ ok: true, recorded: 0 });
    expect(
      await store.recordParticipantObservations({
        fencingToken: token,
        workspaceKey: workspace,
        observedAtMs: now,
        observations: [
          { sessionId: source, rootKind: "root", parentSessionId: null, title: "Renamed" },
        ],
      }),
    ).toEqual({ ok: true, recorded: 1 });
    now = 1_200;
    expect(
      await store.recordParticipantObservations({
        fencingToken: token,
        workspaceKey: workspace,
        observedAtMs: now,
        observations: [
          { sessionId: target, rootKind: "root", parentSessionId: null, title: "bad\u001b[31m" },
        ],
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    expect(
      await store.getParticipantRootCandidate({
        fencingToken: token,
        workspaceKey: workspace,
        sessionId: source,
      }),
    ).toMatchObject({
      title: "Renamed",
      activityStatus: "busy",
      activityObservedAtMs: 1_000,
      lastObservedAtMs: 1_100,
    });
    const page = await store.listParticipantRootCandidates({
      fencingToken: token,
      workspaceKey: workspace,
      limit: 1,
    });
    const last = page.at(-1);
    if (!last) throw new Error("missing root candidate");
    expect(
      await store.listParticipantRootCandidates({
        fencingToken: token,
        workspaceKey: workspace,
        limit: 1,
        cursor: { id: last.id, lastObservedAtMs: last.lastObservedAtMs },
      }),
    ).toEqual([]);
    await expect(
      store.listParticipantRootCandidates({
        fencingToken: token,
        workspaceKey: workspace,
        limit: 1,
        cursor: { id: source, lastObservedAtMs: -1 },
      }),
    ).rejects.toThrow("cursor is malformed");
    store.close();
  });
});

describe("participant registry retention", () => {
  test("evicts an old discovery row at capacity while preserving protocol records", async () => {
    const root = mkdtempSync(join(tmpdir(), "communicator-participant-ceiling-"));
    roots.push(root);
    const store = new LinuxBunSqliteStore({
      stateDirectory: join(root, "state"),
      workspaceKey: workspace,
      nowWallMs: () => 1_000,
      nowMonotonicMs: () => 1_000,
    });
    try {
      const token = await store.acquire();
      const database = new Database(store.databasePath, { strict: true });
      try {
        database.run(
          "INSERT OR IGNORE INTO workspaces(workspace_key, created_at_ms) VALUES (?, 1)",
          [workspace],
        );
        // Seed the policy-sized fixture without quadratic per-row count-trigger cost, then restore
        // the production trigger before exercising the public fenced repository operation.
        const trigger = database
          .query<{ sql: string }, []>(
            "SELECT sql FROM sqlite_schema WHERE name = 'communicator_participants_ceiling_insert_v17'",
          )
          .get();
        if (!trigger) throw new Error("missing production ceiling trigger");
        database.exec("DROP TRIGGER communicator_participants_ceiling_insert_v17");
        database.run(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?)
          INSERT INTO communicator_participants(workspace_key, session_id, root_kind, archived_state,
            activity_status, visibility_state, first_observed_at_ms, last_observed_at_ms, observation_source)
          SELECT ?, 'ses_seed' || i, 'root', 'unknown', 'unknown', 'unknown', 1, i, 'historical' FROM n`,
          [participantRegistryPolicy.maximumRowsPerWorkspace, workspace],
        );
        database.exec(trigger.sql);
        const requestId = `req_${"a".repeat(32)}`;
        database.run(
          `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
          native_message_id, kind, resolution_state, delivery_state, result_state, payload_byte_length,
          created_at_ms, updated_at_ms, deadline_at_ms, resolved_at_ms)
          VALUES (?, ?, 'ses_seed1', ?, ?, 'wait', 'cancelled', 'prepared', 'none', 1, 5, 25, 30, 25)`,
          [requestId, workspace, target, `msg_${"b".repeat(32)}`],
        );
        expect(
          await store.recordParticipantObservations({
            fencingToken: token,
            workspaceKey: workspace,
            observedAtMs: 1_000_000,
            observations: [{ sessionId: target, rootKind: "root", parentSessionId: null }],
          }),
        ).toEqual({ ok: true, recorded: 1 });
        expect(
          database
            .query<{ count: number }, []>("SELECT count(*) AS count FROM communicator_participants")
            .get()?.count,
        ).toBe(participantRegistryPolicy.maximumRowsPerWorkspace);
        expect(
          await store.getParticipantRootCandidate({
            fencingToken: token,
            workspaceKey: workspace,
            sessionId: target,
          }),
        ).toBeDefined();
        expect(
          database
            .query("SELECT 1 FROM communicator_participants WHERE session_id = 'ses_seed1'")
            .get(),
        ).toBeNull();
        expect(database.query("SELECT 1 FROM requests WHERE id = ?").get(requestId)).not.toBeNull();
      } finally {
        database.close();
      }
    } finally {
      store.close();
    }
  }, 15_000);
});
