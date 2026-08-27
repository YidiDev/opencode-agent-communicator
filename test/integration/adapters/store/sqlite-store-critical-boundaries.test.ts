import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { classifySqliteStorageError } from "../../../../src/adapters/store/delivery-repository";
import { checkRequestCycle } from "../../../../src/adapters/store/request-quotas";
import {
  requestPageLimitReached,
  selectRequest,
} from "../../../../src/adapters/store/request-repository-shared";
import type { StoreContext } from "../../../../src/adapters/store/store-types";
import { StoreIntegrityError } from "../../../../src/adapters/store/store-types";
import { validateDeliveryId, validateNativeMessageId } from "../../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../../src/domain/message-payload";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestClock,
  requestFixture,
  requestFixtureForPayload,
  requestSession,
  requestTestWorkspace,
  requestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

function raw(databasePath: string): Database {
  return new Database(databasePath, { strict: true });
}

function participant(
  fixture: Awaited<ReturnType<typeof requestFixture>>,
  role: "source" | "target",
) {
  return {
    fencingToken: fixture.fencingToken,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
    callerSessionId:
      role === "source" ? fixture.request.sourceSessionId : fixture.request.targetSessionId,
  };
}

function contextOf(store: ReturnType<typeof openRequestStore>): StoreContext {
  return (store as unknown as { readonly context: StoreContext }).context;
}

describe("request query and repository rejection boundaries", () => {
  test("rejects malformed recovery inputs and corrupt deadline schedule rows", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);

    for (const input of [
      {
        fencingToken: token,
        workspaceKey: requestWorkspace("foreign-recovery"),
        state: "prepared" as const,
        limit: 1,
      },
      {
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        state: "prepared" as const,
        limit: 0,
      },
      {
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        state: "prepared" as const,
        limit: 1,
        cursor: { createdAtMs: -1, id: fixture.request.id },
      },
    ]) {
      await expect(store.listRecoverableRequests(input)).rejects.toBeInstanceOf(
        StoreIntegrityError,
      );
    }
    await expect(
      store.listRecoverableRequests({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        state: "submitting",
        limit: 1,
      } as Parameters<typeof store.listRecoverableRequests>[0]),
    ).rejects.toThrow();

    const database = raw(store.databasePath);
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.run("UPDATE requests SET deadline_at_ms = -1 WHERE id = ?", [fixture.request.id]);
    database.close(true);
    await expect(
      store.readNextPendingDeadline({ fencingToken: token, workspaceKey: requestTestWorkspace() }),
    ).rejects.toBeInstanceOf(StoreIntegrityError);
    store.close();
  });

  test("rejects invalid creation/claim/expiry inputs without mutating an existing request", async () => {
    const clock = requestClock();
    const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
    const token = await store.acquire();
    const fixture = await requestFixture(token);

    expect(await store.createPrepared({ ...fixture, creationOperationId: "bad" as never })).toEqual(
      { ok: false, code: "state_conflict" },
    );
    expect((await store.createPrepared(fixture)).ok).toBeTrue();
    const collision = await requestFixture(token, 1_001, "ses_othersource", "ses_othertarget");
    expect(
      await store.createPrepared({
        ...collision,
        request: { ...collision.request, nativeMessageId: fixture.request.nativeMessageId },
      }),
    ).toEqual({ ok: false, code: "state_conflict" });

    const absent = `req_${"f".repeat(32)}` as typeof fixture.request.id;
    expect(
      await store.reconcilePreparedClaim({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        requestId: absent,
      }),
    ).toEqual({ outcome: "absent_or_other_claim" });
    expect(
      await store.claimPrepared({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        requestId: absent,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    expect(
      await store.claimPrepared({
        fencingToken: token,
        workspaceKey: requestWorkspace("foreign-claim"),
        requestId: fixture.request.id,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });

    clock.set(fixture.request.updatedAtMs - 1);
    expect(
      await store.claimPrepared({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        requestId: fixture.request.id,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    expect(
      await store.expireDueRequests({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 0,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    clock.set(25_000);
    store.close();
  });

  test("fails closed for an invalid store clock and actual closed SQLite diagnostics", async () => {
    const clock = requestClock();
    const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    clock.set(-1);
    expect(await store.createPrepared(fixture)).toEqual({ ok: false, code: "state_conflict" });
    clock.set(25_000);
    store.close();

    const diagnosticStore = openRequestStore();
    const context = (diagnosticStore as unknown as { readonly context: StoreContext }).context;
    expect(selectRequest(context, requestTestWorkspace(), fixture.request.id)).toBeUndefined();
    diagnosticStore.close();
    expect(requestPageLimitReached(context)).toBeFalse();
  });

  test("runs cycle checks at the repository boundary and detects a self edge", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    expect(
      checkRequestCycle(contextOf(store), {
        ...fixture,
        request: { ...fixture.request, targetSessionId: fixture.request.sourceSessionId },
      }),
    ).toBe("cycle");

    const context = contextOf(store);
    const pages = context.database
      .query<{ value: number }, []>("SELECT page_count AS value FROM pragma_page_count")
      .get()?.value;
    if (pages === undefined) throw new Error("page count unavailable");
    context.maximumPageCount = pages;
    expect(requestPageLimitReached(context)).toBeTrue();
    context.database.exec(
      "CREATE TABLE coverage_free_page(value TEXT); DROP TABLE coverage_free_page",
    );
    context.maximumPageCount =
      context.database
        .query<{ value: number }, []>("SELECT page_count AS value FROM pragma_page_count")
        .get()?.value ?? 0;
    expect(requestPageLimitReached(context)).toBeFalse();
    store.close();
  });

  test("reconciliation refuses private content changed after a successful prepare", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    const database = raw(store.databasePath);
    database.run("UPDATE request_payloads SET envelope_json = '{}' WHERE request_id = ?", [
      fixture.request.id,
    ]);
    database.close(true);
    expect(await store.reconcilePreparedCreation(fixture)).toEqual({ outcome: "conflict" });
    store.close();
  });
});

describe("request delivery validation", () => {
  test("rejects malformed identity, regressed store time, and mismatched native evidence", async () => {
    const clock = requestClock();
    const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    await store.claimPrepared({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      requestId: fixture.request.id,
    });
    expect(
      await store.completeDelivery({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        requestId: "bad" as never,
        outcome: "delivery_failed",
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    clock.set(0);
    expect(
      await store.completeDelivery({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        requestId: fixture.request.id,
        outcome: "delivery_failed",
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    clock.set(25_000);
    expect(
      await store.completeDelivery({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        requestId: fixture.request.id,
        outcome: "admitted",
        nativeMessageId: validNativeMessage("msg_ffffffffffffffffffffffffffffffff"),
        admittedSeq: 1,
        evidenceObservedAtMs: 25_000,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    store.close();
  });
});

function validNativeMessage(value: string) {
  const result = validateNativeMessageId(value);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

describe("participant query hostile boundaries", () => {
  test("validates list/get inputs and fences a foreign workspace before returning no rows", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);

    await expect(
      store.listForParticipant({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        callerSessionId: fixture.request.sourceSessionId,
        role: "all",
        limit: 0,
      }),
    ).rejects.toBeInstanceOf(StoreIntegrityError);
    expect(
      await store.listForParticipant({
        fencingToken: token,
        workspaceKey: requestWorkspace("foreign-list"),
        callerSessionId: fixture.request.sourceSessionId,
        role: "all",
        limit: 1,
      }),
    ).toEqual({ items: [], hasMore: false, terminalized: [] });
    await expect(
      store.getParticipantRequest({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        requestId: "bad" as never,
        callerSessionId: fixture.request.sourceSessionId,
      }),
    ).rejects.toBeInstanceOf(StoreIntegrityError);
    store.close();
  });

  test("fails closed if exact-query authorization and the selected row disagree", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    const repository = (
      store as unknown as {
        readonly requestParticipantQueryRepository: {
          getOwned(
            workspace: string,
            requestId: string,
            caller: string,
            role: "source" | "target",
          ): unknown;
          queryList(
            index: string,
            participantColumn: "source_session_id" | "target_session_id",
            predicate: string,
            role: "source" | "target",
            caller: string,
            boundary: undefined,
            limit: number,
          ): unknown;
        };
      }
    ).requestParticipantQueryRepository;
    expect(
      repository.getOwned(
        requestTestWorkspace(),
        `req_${"f".repeat(32)}`,
        fixture.request.sourceSessionId,
        "source",
      ),
    ).toBeUndefined();
    expect(() =>
      repository.getOwned(
        requestTestWorkspace(),
        fixture.request.id,
        fixture.request.sourceSessionId,
        "target",
      ),
    ).toThrow("authorization changed");
    expect(() =>
      repository.queryList(
        "requests_participant_outbox",
        "source_session_id",
        "resolution_state = 'pending'",
        "intruder" as never,
        fixture.request.sourceSessionId,
        undefined,
        1,
      ),
    ).toThrow("participant role was invalid");
    store.close();
  });

  test("rejects a terminal resolution/result correlation corrupted below the query API", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    await store.signalWait(participant(fixture, "target"));
    const database = raw(store.databasePath);
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.run("UPDATE requests SET resolution_state = 'answered' WHERE id = ?", [
      fixture.request.id,
    ]);
    database.close(true);
    await expect(
      store.getParticipantRequest(participant(fixture, "source")),
    ).rejects.toBeInstanceOf(StoreIntegrityError);
    store.close();
  });

  for (const dimension of ["source", "target", "result"] as const) {
    test(`fails closed when corrupt ${dimension} maintenance exceeds its hard batch bound`, async () => {
      const maintenanceNowMs = dimension === "result" ? 100_000_000 : 25_000;
      const store = openRequestStore({
        nowWallMs: () => maintenanceNowMs,
        nowMonotonicMs: () => maintenanceNowMs,
      });
      const token = await store.acquire();
      const database = raw(store.databasePath);
      database.run(
        "INSERT OR IGNORE INTO workspaces(workspace_key, created_at_ms) VALUES ('request-test', 0)",
      );
      database.exec("PRAGMA ignore_check_constraints = ON");
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each corrupt bounded dimension is materialized explicitly.
      const insertCorruptRows = () => {
        const rowCount = dimension === "result" ? 700 : 400;
        for (let index = 0; index < rowCount; index++) {
          const suffix = (
            index + (dimension === "source" ? 1 : dimension === "target" ? 501 : 1001)
          )
            .toString(16)
            .padStart(32, "0");
          const source =
            dimension === "source" || dimension === "result" ? "ses_boundcaller" : `ses_s${index}`;
          const target = dimension === "target" ? "ses_boundcaller" : `ses_t${index}`;
          if (dimension === "result") {
            database.run(
              `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
                 native_message_id, kind, resolution_state, delivery_state, result_state,
                 payload_byte_length, created_at_ms, updated_at_ms, deadline_at_ms, resolved_at_ms,
                 result_byte_length, result_sha256, result_available_at_ms, result_expires_at_ms)
               VALUES (?, 'request-test', ?, ?, ?, 'wait', 'reached', 'prepared', 'available',
                 1, 1, 3, 10, 2, 15, ?, 2, 86400002)`,
              [`req_${suffix}`, source, target, `msg_${suffix}`, "a".repeat(64)],
            );
            database.run(
              'INSERT INTO request_results(request_id, result_json) VALUES (?, \'{"kind":"wait"}\')',
              [`req_${suffix}`],
            );
          } else {
            database.run(
              `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
                 native_message_id, kind, resolution_state, delivery_state, result_state,
                 payload_byte_length, retained_content_byte_length, payload_sha256,
                 created_at_ms, updated_at_ms, deadline_at_ms)
               VALUES (?, 'request-test', ?, ?, ?, 'wait', 'pending', 'prepared', 'none',
                 1, 2, ?, 0, 0, 1)`,
              [`req_${suffix}`, source, target, `msg_${suffix}`, "a".repeat(64)],
            );
          }
        }
      };
      database.transaction(insertCorruptRows).immediate();
      database.close(true);
      await expect(
        store.listForParticipant({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          callerSessionId: requestSession("ses_boundcaller"),
          role: dimension === "target" ? "inbox" : "outbox",
          limit: 1,
        }),
      ).rejects.toThrow(
        dimension === "source"
          ? "Source request expiry exceeded its hard bound."
          : dimension === "target"
            ? "Target request expiry exceeded its hard bound."
            : "Source result expiry exceeded its hard bound.",
      );
      store.close();
    });
  }
});

describe("terminal mutation fail-closed behavior", () => {
  test("rejects throwing result accessors and participant operations observed before updated time", async () => {
    const clock = requestClock();
    const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
    const token = await store.acquire();
    const ask = await requestFixtureForPayload(token, {
      kind: "ask",
      questions: [{ prompt: "q", options: ["a"] }],
      timeoutSeconds: 30,
    });
    await store.createPrepared(ask);
    const throwingAnswers = { ...participant(ask as never, "target") } as Record<string, unknown>;
    Object.defineProperty(throwingAnswers, "answers", {
      get: () => {
        throw new Error("hostile getter");
      },
    });
    expect(await store.answerAsk(throwingAnswers as never)).toMatchObject({
      ok: false,
      code: "state_conflict",
    });

    const wait = await requestFixture(token, 1_001, "ses_waitsource", "ses_waittarget");
    await store.createPrepared(wait);
    const throwingEvidence = { ...participant(wait, "target") } as Record<string, unknown>;
    Object.defineProperty(throwingEvidence, "evidence", {
      get: () => {
        throw new Error("hostile getter");
      },
    });
    expect(await store.signalWait(throwingEvidence as never)).toMatchObject({
      ok: false,
      code: "state_conflict",
    });

    clock.set(999);
    expect(await store.signalWait(participant(wait, "target"))).toMatchObject({
      ok: false,
      code: "state_conflict",
    });
    expect(await store.cancelPending(participant(wait, "source"))).toMatchObject({
      ok: false,
      code: "state_conflict",
    });
    clock.set(25_000);
    store.close();
  });

  test("acknowledging a pending request validates its private state before refusing", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    expect(await store.acknowledgeResult(participant(fixture, "source"))).toEqual({
      ok: false,
      code: "state_conflict",
    });
    const database = raw(store.databasePath);
    database.run("DELETE FROM request_payloads WHERE request_id = ?", [fixture.request.id]);
    database.close(true);
    expect(await store.cancelPending(participant(fixture, "source"))).toEqual({
      ok: false,
      code: "state_conflict",
    });
    store.close();
  });
});

describe("session stop fail-closed behavior", () => {
  test("stop validates identities and rejects incoherent or missing private pending state", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    expect(
      await store.stopPendingRequests({
        fencingToken: token,
        workspaceKey: requestWorkspace("foreign-stop"),
        stoppedSessionId: requestSession("ses_stopped"),
      }),
    ).toEqual({ ok: false, code: "storage_unavailable" });

    const future = await requestFixture(token, 1_000, "ses_futuresource", "ses_stopped");
    await store.createPrepared(future);
    const futureDatabase = raw(store.databasePath);
    futureDatabase.run("UPDATE requests SET updated_at_ms = 26000 WHERE id = ?", [
      future.request.id,
    ]);
    futureDatabase.close(true);
    expect(
      await store.stopPendingRequests({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        stoppedSessionId: future.request.targetSessionId,
      }),
    ).toEqual({ ok: false, code: "storage_unavailable" });

    const missing = await requestFixture(token, 1_001, "ses_missingsource", "ses_missingtarget");
    await store.createPrepared(missing);
    const database = raw(store.databasePath);
    database.run("DELETE FROM request_payloads WHERE request_id = ?", [missing.request.id]);
    database.close(true);
    expect(
      await store.stopPendingRequests({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        stoppedSessionId: missing.request.targetSessionId,
      }),
    ).toEqual({ ok: false, code: "storage_unavailable" });
    store.close();
  });

  test("stop rolls back when a hostile trigger suppresses the atomic parent transition", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    const database = raw(store.databasePath);
    database.exec(`CREATE TRIGGER suppress_stop_update BEFORE UPDATE OF resolution_state ON requests
      WHEN NEW.resolution_state IN ('target_stopped','source_stopped')
      BEGIN SELECT RAISE(IGNORE); END;`);
    database.close(true);
    expect(
      await store.stopPendingRequests({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        stoppedSessionId: fixture.request.targetSessionId,
      }),
    ).toEqual({ ok: false, code: "storage_unavailable" });
    store.close();
  });

  test("stop refuses a corrupt backlog beyond the immutable notification bound", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const stopped = requestSession("ses_stopbound");
    const database = raw(store.databasePath);
    database.run(
      "INSERT OR IGNORE INTO workspaces(workspace_key, created_at_ms) VALUES ('request-test', 0)",
    );
    database.exec("PRAGMA ignore_check_constraints = ON");
    database
      .transaction(() => {
        for (let index = 0; index < 1_025; index++) {
          const suffix = (index + 2_000).toString(16).padStart(32, "0");
          database.run(
            `INSERT INTO requests(id, workspace_key, source_session_id, target_session_id,
             native_message_id, kind, resolution_state, delivery_state, result_state,
             payload_byte_length, retained_content_byte_length, payload_sha256,
             created_at_ms, updated_at_ms, deadline_at_ms)
           VALUES (?, 'request-test', ?, ?, ?, 'wait', 'pending', 'prepared', 'none',
             1, 2, ?, 1, 1, 30000)`,
            [`req_${suffix}`, `ses_s${index}`, stopped, `msg_${suffix}`, "a".repeat(64)],
          );
        }
      })
      .immediate();
    database.close(true);
    expect(
      await store.stopPendingRequests({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        stoppedSessionId: stopped,
      }),
    ).toEqual({ ok: false, code: "storage_unavailable" });
    store.close();
  });
});

describe("terminal compare-and-swap fail-closed behavior", () => {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each terminal CAS is exercised through its public operation.
  test("terminal CAS suppression never publishes an uncommitted winner", async () => {
    for (const operation of ["result", "cancel", "ack", "deadline"] as const) {
      const clock = requestClock();
      const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
      const token = await store.acquire();
      const fixture = await requestFixture(token, 1_000 + operation.length);
      await store.createPrepared(fixture);
      if (operation === "ack") {
        await store.signalWait(participant(fixture, "target"));
      }
      if (operation === "deadline") clock.set(fixture.request.deadlineAtMs);
      const database = raw(store.databasePath);
      database.exec(
        operation === "ack"
          ? `CREATE TRIGGER suppress_terminal_cas BEFORE UPDATE OF result_state ON requests
             WHEN NEW.result_state = 'acknowledged' BEGIN SELECT RAISE(IGNORE); END;`
          : `CREATE TRIGGER suppress_terminal_cas BEFORE UPDATE OF resolution_state ON requests
             WHEN NEW.resolution_state = '${
               operation === "result"
                 ? "reached"
                 : operation === "cancel"
                   ? "cancelled"
                   : "deadline_expired"
}' BEGIN SELECT RAISE(IGNORE); END;`,
      );
      database.close(true);
      const result =
        operation === "result"
          ? await store.signalWait(participant(fixture, "target"))
          : operation === "cancel"
            ? await store.cancelPending(participant(fixture, "source"))
            : operation === "ack"
              ? await store.acknowledgeResult(participant(fixture, "source"))
              : await store.signalWait(participant(fixture, "target"));
      expect(result).toEqual({ ok: false, code: "state_conflict" });
      store.close();
    }
  });
});

test("delivery claim CAS suppression is classified as a state conflict", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const deliveryId = validateDeliveryId("dlv_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  if (!deliveryId.ok) throw new Error(deliveryId.message);
  const prepared = {
    fencingToken: token,
    id: deliveryId.value,
    workspaceKey: requestTestWorkspace(),
    sourceSessionId: requestSession("ses_deliverysource"),
    targetSessionId: requestSession("ses_deliverytarget"),
    nativeMessageId: validNativeMessage("msg_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
    envelope: '{"payload":{"content":"bounded"}}',
    contentByteLength: 7,
    contentSha256: "e".repeat(64) as Sha256Digest,
    nowMs: 25_000,
  };
  expect(await store.createPrepared(prepared)).toMatchObject({ ok: true });
  const database = raw(store.databasePath);
  database.exec(`CREATE TRIGGER suppress_delivery_claim BEFORE UPDATE OF state ON deliveries
    WHEN NEW.state = 'submitting' BEGIN SELECT RAISE(IGNORE); END;`);
  database.close(true);
  expect(
    await store.claimPrepared({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      deliveryId: deliveryId.value,
      nowMs: 25_001,
    }),
  ).toEqual({ ok: false, code: "state_conflict" });
  store.close();
});

test("structured SQLite storage codes distinguish deterministic full, I/O, and read-only failures", () => {
  expect(classifySqliteStorageError({ code: "SQLITE_FULL", errno: 13 }, () => true)).toBe(
    "quota_exceeded",
  );
  expect(classifySqliteStorageError({ code: "SQLITE_FULL", errno: 13 }, () => false)).toBe(
    "storage_unavailable",
  );
  expect(classifySqliteStorageError({ code: "SQLITE_IOERR", errno: 10 }, () => false)).toBe(
    "storage_unavailable",
  );
  expect(classifySqliteStorageError({ code: "SQLITE_READONLY", errno: 8 }, () => false)).toBe(
    "storage_unavailable",
  );
});
