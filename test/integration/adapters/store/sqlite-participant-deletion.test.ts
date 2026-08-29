import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { ParticipantDeletionLifecycle } from "../../../../src/application/participant-deletion-lifecycle";
import { RequestRuntime } from "../../../../src/application/request-runtime";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestFixture,
  requestSession,
  requestTestWorkspace,
  requestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

function privateState(databasePath: string, requestId: string) {
  const database = new Database(databasePath, { readonly: true, strict: true });
  const row = database
    .query<{ resolution: string; payloads: number; edges: number; results: number }, [string]>(
      `SELECT resolution_state AS resolution,
       (SELECT count(*) FROM request_payloads WHERE request_id = ?1) AS payloads,
       (SELECT count(*) FROM request_wait_edges WHERE request_id = ?1) AS edges,
       (SELECT count(*) FROM request_results WHERE request_id = ?1) AS results
       FROM requests WHERE id = ?1`,
    )
    .get(requestId);
  database.close(true);
  return row;
}

function mutateStore(
  databasePath: string,
  sql: string,
  parameters: readonly SQLQueryBindings[] = [],
): void {
  const database = new Database(databasePath, { strict: true });
  database.run(sql, [...parameters]);
  database.close(true);
}

function installCorruptionTrigger(
  databasePath: string,
  mode: "count" | "missing" | "role",
  firstId: string,
  secondId?: string,
): void {
  const body =
    mode === "count"
      ? `DELETE FROM requests WHERE id = '${secondId}';`
      : mode === "missing"
        ? `DELETE FROM requests WHERE id = NEW.id;`
        : `UPDATE requests SET resolution_state = 'source_deleted' WHERE id = NEW.id;`;
  const timing = mode === "count" ? "BEFORE" : "AFTER";
  const condition = mode === "count" ? ` AND OLD.id = '${firstId}'` : "";
  mutateStore(
    databasePath,
    `CREATE TRIGGER corrupt_participant_delete ${timing} UPDATE OF resolution_state ON requests
     WHEN NEW.resolution_state = 'target_deleted'${condition}
     BEGIN ${body} END`,
  );
}

describe("fenced participant deletion persistence", () => {
  test("queries the bounded candidate union with pending targets before sources and available sources", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const pending = await requestFixture(token, 1_020, "ses_pendingSource", "ses_pendingTarget");
    const available = await requestFixture(
      token,
      1_021,
      "ses_availableSource",
      "ses_availableTarget",
    );
    expect((await store.createPrepared(pending)).ok).toBe(true);
    expect((await store.createPrepared(available)).ok).toBe(true);
    expect(
      (
        await store.signalWait({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          requestId: available.request.id,
          callerSessionId: available.request.targetSessionId,
        })
      ).ok,
    ).toBe(true);
    const listed = await store.listParticipantDeletionCandidates({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
    });
    expect(listed).toEqual({
      ok: true,
      sessionIds: [
        pending.request.targetSessionId,
        pending.request.sourceSessionId,
        available.request.sourceSessionId,
      ],
    });
    await store.deleteParticipantRequests({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      deletedSessionId: available.request.sourceSessionId,
    });
    expect(
      await store.listParticipantDeletionCandidates({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
      }),
    ).toEqual({
      ok: true,
      sessionIds: [pending.request.targetSessionId, pending.request.sourceSessionId],
    });
    store.close();
  });

  test("atomically resolves crossed participant roles by complete-set target membership", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const a = requestSession("ses_absentA");
    const b = requestSession("ses_absentB");
    const c = requestSession("ses_absentC");
    const aToB = await requestFixture(token, 1_030, a, b);
    const bToC = await requestFixture(token, 1_031, b, c);
    for (const fixture of [aToB, bToC]) expect((await store.createPrepared(fixture)).ok).toBe(true);

    const applied = await store.deleteAbsentParticipantRequests({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      absentSessionIds: [a, b, c],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error(applied.code);
    expect(applied.terminalized.map((request) => [request.id, request.resolutionState])).toEqual([
      [aToB.request.id, "target_deleted"],
      [bToC.request.id, "target_deleted"],
    ]);
    expect(privateState(store.databasePath, aToB.request.id)?.resolution).toBe("target_deleted");
    expect(privateState(store.databasePath, bToC.request.id)?.resolution).toBe("target_deleted");
    store.close();
  });

  test("accepts an empty set and rejects duplicate or hostile absent sets without mutation", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    expect((await store.createPrepared(fixture)).ok).toBe(true);
    expect(
      await store.deleteAbsentParticipantRequests({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        absentSessionIds: [],
      }),
    ).toEqual({ ok: true, terminalized: [] });
    const hostile: unknown[] = [];
    Object.defineProperty(hostile, "0", {
      enumerable: true,
      get: () => fixture.request.targetSessionId,
    });
    Object.defineProperty(hostile, "length", { value: 1 });
    for (const absentSessionIds of [
      [fixture.request.targetSessionId, fixture.request.targetSessionId],
      hostile,
    ]) {
      expect(
        await store.deleteAbsentParticipantRequests({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          absentSessionIds,
        } as never),
      ).toEqual({ ok: false, code: "storage_unavailable" });
    }
    expect(privateState(store.databasePath, fixture.request.id)).toMatchObject({
      resolution: "pending",
      payloads: 1,
      edges: 1,
    });
    store.close();
  });
});

describe("fenced participant deletion persistence", () => {
  test("publishes committed terminal metadata to RequestRuntime only after content erasure", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    expect((await store.createPrepared(fixture)).ok).toBe(true);
    const runtime = new RequestRuntime();
    const registration = runtime.attach({
      requestId: fixture.request.id,
      expectedKind: fixture.request.kind,
      sourceSessionId: fixture.request.sourceSessionId,
      workspaceKey: requestTestWorkspace(),
    });
    const handler = new ParticipantDeletionLifecycle({
      requests: store,
      presence: { readParticipantPresence: async () => "absent" },
      notifications: runtime,
      lifecycle: { fencingToken: token, status: "ready", stop: () => undefined } as never,
      workspaceKey: requestTestWorkspace(),
      directory: "/workspace",
      projectId: "project",
    });
    await handler.handle({
      type: "session.deleted",
      properties: {
        info: {
          id: fixture.request.targetSessionId,
          projectID: "project",
          directory: "/workspace",
          title: "Deleted",
          version: "1.18.23",
          time: { created: 1, updated: 2 },
        },
      },
    });
    expect(await registration.outcome).toMatchObject({
      outcome: "terminal",
      event: { requestId: fixture.request.id, resolutionState: "target_deleted" },
    });
    expect(privateState(store.databasePath, fixture.request.id)).toEqual({
      resolution: "target_deleted",
      payloads: 0,
      edges: 0,
      results: 0,
    });
    registration.detach();
    await handler.dispose();
    store.close();
  });

  test("terminalizes every pending role atomically and replays idempotently", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const deleted = requestSession("ses_deleted");
    const target = await requestFixture(token, 1_000, "ses_sourceA", "ses_deleted");
    const source = await requestFixture(token, 1_001, "ses_deleted", "ses_targetB");
    const unrelated = await requestFixture(token, 1_003, "ses_sourceC", "ses_targetC");
    for (const fixture of [target, source, unrelated])
      expect((await store.createPrepared(fixture)).ok).toBe(true);

    const applied = await store.deleteParticipantRequests({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      deletedSessionId: deleted,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error(applied.code);
    expect(applied.terminalized.map((value) => value.resolutionState).sort()).toEqual([
      "source_deleted",
      "target_deleted",
    ]);
    expect(privateState(store.databasePath, target.request.id)).toEqual({
      resolution: "target_deleted",
      payloads: 0,
      edges: 0,
      results: 0,
    });
    expect(privateState(store.databasePath, source.request.id)).toEqual({
      resolution: "source_deleted",
      payloads: 0,
      edges: 0,
      results: 0,
    });
    expect(privateState(store.databasePath, unrelated.request.id)).toMatchObject({
      resolution: "pending",
      payloads: 1,
      edges: 1,
    });
    expect(
      await store.deleteParticipantRequests({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        deletedSessionId: deleted,
      }),
    ).toEqual({ ok: true, terminalized: [] });
    store.close();
  });

  test("erases an available result for a deleted source but retains it for a deleted target", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const sourceDeleted = await requestFixture(token, 1_010, "ses_deletedSource", "ses_targetA");
    const targetDeleted = await requestFixture(token, 1_011, "ses_sourceB", "ses_deletedTarget");
    for (const fixture of [sourceDeleted, targetDeleted]) {
      expect((await store.createPrepared(fixture)).ok).toBe(true);
      expect(
        (
          await store.signalWait({
            fencingToken: token,
            workspaceKey: requestTestWorkspace(),
            requestId: fixture.request.id,
            callerSessionId: fixture.request.targetSessionId,
          })
        ).ok,
      ).toBe(true);
    }
    await store.deleteParticipantRequests({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      deletedSessionId: sourceDeleted.request.sourceSessionId,
    });
    await store.deleteParticipantRequests({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      deletedSessionId: targetDeleted.request.targetSessionId,
    });
    expect(privateState(store.databasePath, sourceDeleted.request.id)).toEqual({
      resolution: "reached",
      payloads: 0,
      edges: 0,
      results: 0,
    });
    expect(privateState(store.databasePath, targetDeleted.request.id)).toEqual({
      resolution: "reached",
      payloads: 0,
      edges: 0,
      results: 1,
    });
    const database = new Database(store.databasePath, { readonly: true, strict: true });
    const states = database
      .query<
        {
          id: string;
          state: string;
          byteLength: number | null;
          sha256: string | null;
          expiredAtMs: number | null;
        },
        []
      >(
        `SELECT id, result_state AS state, result_byte_length AS byteLength,
          result_sha256 AS sha256, result_expired_at_ms AS expiredAtMs
         FROM requests ORDER BY id`,
      )
      .all();
    database.close(true);
    expect(states.find((row) => row.id === sourceDeleted.request.id)).toMatchObject({
      state: "expired",
      byteLength: null,
      sha256: null,
      expiredAtMs: expect.any(Number),
    });
    expect(states.find((row) => row.id === targetDeleted.request.id)?.state).toBe("available");
    store.close();
  });
});

describe("participant deletion result erasure fault boundaries", () => {
  test("rolls back result erasure when the metadata compare-and-set cannot commit", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(
      token,
      1_012,
      "ses_deletedResultSource",
      "ses_targetResult",
    );
    expect((await store.createPrepared(fixture)).ok).toBeTrue();
    expect(
      (
        await store.signalWait({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          requestId: fixture.request.id,
          callerSessionId: fixture.request.targetSessionId,
        })
      ).ok,
    ).toBeTrue();
    mutateStore(
      store.databasePath,
      `CREATE TRIGGER ignore_deleted_source_result BEFORE UPDATE OF result_state ON requests
       WHEN OLD.result_state = 'available' AND NEW.result_state = 'expired'
       BEGIN SELECT RAISE(IGNORE); END`,
    );

    expect(
      await store.deleteParticipantRequests({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        deletedSessionId: fixture.request.sourceSessionId,
      }),
    ).toEqual({ ok: false, code: "storage_unavailable" });
    expect(privateState(store.databasePath, fixture.request.id)).toMatchObject({
      resolution: "reached",
      results: 1,
    });
    store.close();
  }, 15_000);

  test("leaves private state untouched behind a stale ownership fence", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    expect((await store.createPrepared(fixture)).ok).toBe(true);
    expect(
      await store.deleteParticipantRequests({
        fencingToken: (token + 1) as typeof token,
        workspaceKey: requestTestWorkspace(),
        deletedSessionId: fixture.request.targetSessionId,
      }),
    ).toEqual({ ok: false, code: "ownership_lost" });
    expect(privateState(store.databasePath, fixture.request.id)).toMatchObject({
      resolution: "pending",
      payloads: 1,
      edges: 1,
    });
    store.close();
  });

  test("rolls back when erased result metadata disappears before postcondition validation", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(
      token,
      1_013,
      "ses_deletedResultSource",
      "ses_targetResult",
    );
    expect((await store.createPrepared(fixture)).ok).toBeTrue();
    expect(
      (
        await store.signalWait({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          requestId: fixture.request.id,
          callerSessionId: fixture.request.targetSessionId,
        })
      ).ok,
    ).toBeTrue();
    mutateStore(
      store.databasePath,
      `CREATE TRIGGER remove_erased_result_metadata AFTER UPDATE OF result_state ON requests
       WHEN NEW.result_state = 'expired' BEGIN DELETE FROM requests WHERE id = NEW.id; END`,
    );
    expect(
      await store.deleteParticipantRequests({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        deletedSessionId: fixture.request.sourceSessionId,
      }),
    ).toEqual({ ok: false, code: "storage_unavailable" });
    expect(privateState(store.databasePath, fixture.request.id)).toMatchObject({
      resolution: "reached",
      results: 1,
    });
    store.close();
  });
});

describe("participant deletion validation and corruption boundaries", () => {
  test("rejects mismatched workspace and malformed participant identities before mutation", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    expect((await store.createPrepared(fixture)).ok).toBe(true);
    for (const input of [
      {
        workspaceKey: requestWorkspace("another-workspace"),
        deletedSessionId: fixture.request.targetSessionId,
      },
      { workspaceKey: "invalid workspace", deletedSessionId: fixture.request.targetSessionId },
      { workspaceKey: requestTestWorkspace(), deletedSessionId: "invalid" },
    ]) {
      expect(
        await store.deleteParticipantRequests({ fencingToken: token, ...input } as never),
      ).toEqual({ ok: false, code: "storage_unavailable" });
    }
    expect(privateState(store.databasePath, fixture.request.id)).toMatchObject({
      resolution: "pending",
      payloads: 1,
      edges: 1,
    });
    store.close();
  });

  test("fails closed and rolls back incoherent pending metadata and private child corruption", async () => {
    for (const corruption of [
      (path: string, id: string) =>
        mutateStore(path, "UPDATE requests SET updated_at_ms = 26000 WHERE id = ?", [id]),
      (path: string, id: string) =>
        mutateStore(path, "DELETE FROM request_wait_edges WHERE request_id = ?", [id]),
      (path: string, id: string) =>
        mutateStore(path, "DELETE FROM request_payloads WHERE request_id = ?", [id]),
      (path: string, id: string) => {
        mutateStore(path, "DROP TRIGGER request_results_available_insert");
        mutateStore(path, "INSERT INTO request_results(request_id, result_json) VALUES (?, '{}')", [
          id,
        ]);
      },
    ]) {
      const store = openRequestStore();
      const token = await store.acquire();
      const fixture = await requestFixture(token);
      expect((await store.createPrepared(fixture)).ok).toBe(true);
      corruption(store.databasePath, fixture.request.id);
      expect(
        await store.deleteParticipantRequests({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          deletedSessionId: fixture.request.targetSessionId,
        }),
      ).toEqual({ ok: false, code: "storage_unavailable" });
      expect(privateState(store.databasePath, fixture.request.id)?.resolution).toBe("pending");
      store.close();
    }
  });

  test("detects atomic count, missing metadata, and participant-role corruption from store triggers", async () => {
    for (const mode of ["count", "missing", "role"] as const) {
      const store = openRequestStore();
      const token = await store.acquire();
      const first = await requestFixture(token, 1_000, "ses_sourceA", "ses_deleted");
      expect((await store.createPrepared(first)).ok).toBe(true);
      let second: Awaited<ReturnType<typeof requestFixture>> | undefined;
      if (mode === "count") {
        second = await requestFixture(token, 1_001, "ses_sourceB", "ses_deleted");
        expect((await store.createPrepared(second)).ok).toBe(true);
      }
      installCorruptionTrigger(store.databasePath, mode, first.request.id, second?.request.id);
      expect(
        await store.deleteParticipantRequests({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          deletedSessionId: first.request.targetSessionId,
        }),
      ).toEqual({ ok: false, code: "storage_unavailable" });
      expect(privateState(store.databasePath, first.request.id)).toMatchObject({
        resolution: "pending",
        payloads: 1,
        edges: 1,
      });
      if (second)
        expect(privateState(store.databasePath, second.request.id)?.resolution).toBe("pending");
      store.close();
    }
  });

  test("rolls back terminalization whose stored participant identity changes after update", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    expect((await store.createPrepared(fixture)).ok).toBe(true);
    mutateStore(
      store.databasePath,
      `CREATE TRIGGER change_deleted_target AFTER UPDATE OF resolution_state ON requests
       WHEN NEW.resolution_state = 'target_deleted'
       BEGIN UPDATE requests SET target_session_id = 'ses_unrelated' WHERE id = NEW.id; END`,
    );
    expect(
      await store.deleteParticipantRequests({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        deletedSessionId: fixture.request.targetSessionId,
      }),
    ).toEqual({ ok: false, code: "storage_unavailable" });
    expect(privateState(store.databasePath, fixture.request.id)?.resolution).toBe("pending");
    store.close();
  });
});
