import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { ParticipantOperationGate } from "../../../../src/application/participant-operation-gate";
import { RequestRuntime } from "../../../../src/application/request-runtime";
import { stopSession } from "../../../../src/application/stop-session";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestClock,
  requestFixture,
  requestSession,
  requestTestWorkspace,
  requestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

function privateCounts(databasePath: string, requestId: string) {
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
  if (!row) throw new Error("request row absent");
  return row;
}

describe("fenced session stop request terminalization", () => {
  test("notifies RequestRuntime only from committed, erased metadata during a self stop", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const stoppedSessionId = requestSession("ses_stopped");
    const fixture = await requestFixture(token, 1_000, "ses_peer", "ses_stopped");
    expect((await store.createPrepared(fixture)).ok).toBe(true);
    const runtime = new RequestRuntime();
    const registration = runtime.attach({
      requestId: fixture.request.id,
      expectedKind: fixture.request.kind,
      sourceSessionId: fixture.request.sourceSessionId,
      workspaceKey: requestTestWorkspace(),
    });
    let didInterrupt = false;
    const result = await stopSession(
      {
        readiness: { fencingToken: token, assertReady: () => undefined },
        activity: {
          observeRequestParticipants: async () => ({
            sourceVisible: true,
            targetVisible: true,
            targetStatus: "idle",
          }),
        },
        approval: { requestStopApproval: async () => "approved" },
        requests: store,
        nativeInterrupt: {
          interruptSession: async () => {
            didInterrupt = true;
            return "interrupted";
          },
        },
        ownership: store,
        notifications: runtime,
        participantOperations: new ParticipantOperationGate(),
        digest: {
          async sha256(bytes) {
            return new Uint8Array(createHash("sha256").update(bytes).digest());
          },
        },
      },
      {
        workspaceKey: requestTestWorkspace(),
        sourceSessionId: stoppedSessionId,
        abort: new AbortController().signal,
      },
      { session_id: stoppedSessionId },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        communicatorState: { requestsTerminalized: 1, targetStopped: 1, sourceStopped: 0 },
        nativeOutcome: "already_idle",
      },
    });
    expect(await registration.outcome).toMatchObject({
      outcome: "terminal",
      event: { requestId: fixture.request.id, resolutionState: "target_stopped" },
    });
    expect(privateCounts(store.databasePath, fixture.request.id)).toEqual({
      resolution: "target_stopped",
      payloads: 0,
      edges: 0,
      results: 0,
    });
    expect(didInterrupt).toBe(false);
    registration.detach();
    store.close();
  });

  test("atomically applies role-specific outcomes, erases payloads, and is idempotent", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const stopped = requestSession("ses_stopped");
    const asTarget = await requestFixture(token, 1_000, "ses_peerA", "ses_stopped");
    const asSource = await requestFixture(token, 1_001, "ses_stopped", "ses_peerB");
    const unrelated = await requestFixture(token, 1_002, "ses_peerC", "ses_peerD");
    for (const fixture of [asTarget, asSource, unrelated]) {
      expect((await store.createPrepared(fixture)).ok).toBe(true);
    }

    const applied = await store.stopPendingRequests({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      stoppedSessionId: stopped,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error(applied.code);
    expect(applied.terminalized.map((request) => request.resolutionState).sort()).toEqual([
      "source_stopped",
      "target_stopped",
    ]);
    expect(privateCounts(store.databasePath, asTarget.request.id)).toEqual({
      resolution: "target_stopped",
      payloads: 0,
      edges: 0,
      results: 0,
    });
    expect(privateCounts(store.databasePath, asSource.request.id)).toEqual({
      resolution: "source_stopped",
      payloads: 0,
      edges: 0,
      results: 0,
    });
    expect(privateCounts(store.databasePath, unrelated.request.id)).toMatchObject({
      resolution: "pending",
      payloads: 1,
      edges: 1,
    });
    const repeated = await store.stopPendingRequests({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      stoppedSessionId: stopped,
    });
    expect(repeated).toEqual({ ok: true, terminalized: [] });

    const lateSignal = await store.signalWait({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      requestId: asTarget.request.id,
      callerSessionId: asTarget.request.targetSessionId,
    });
    expect(lateSignal).toMatchObject({
      ok: false,
      code: "state_conflict",
      request: { resolutionState: "target_stopped" },
    });
    store.close();
  });

  test("idle reconciliation stops only blocking requests while explicit stop remains broad", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const stopped = requestSession("ses_stopped");
    const blocking = await requestFixture(token, 1_000, "ses_peerA", "ses_stopped");
    const queued = {
      ...(await requestFixture(token, 1_001, "ses_peerB", "ses_stopped")),
      deliveryMode: "queue" as const,
    };
    expect((await store.createPrepared(blocking)).ok).toBe(true);
    expect((await store.createPrepared(queued)).ok).toBe(true);

    const candidates = await store.listParticipantStopCandidates({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
    });
    expect(candidates).toEqual({
      ok: true,
      sessionIds: [blocking.request.sourceSessionId, stopped].sort(),
    });

    const idle = await store.stopPendingBlockingRequests({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      stoppedSessionId: stopped,
    });
    expect(idle.ok).toBe(true);
    if (!idle.ok) throw new Error(idle.code);
    expect(idle.terminalized.map((request) => request.id)).toEqual([blocking.request.id]);
    expect(privateCounts(store.databasePath, blocking.request.id)).toMatchObject({
      resolution: "target_stopped",
      payloads: 0,
    });
    expect(privateCounts(store.databasePath, queued.request.id)).toMatchObject({
      resolution: "pending",
      payloads: 1,
    });

    const explicit = await store.stopPendingRequests({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      stoppedSessionId: stopped,
    });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) throw new Error(explicit.code);
    expect(explicit.terminalized.map((request) => request.id)).toEqual([queued.request.id]);
    store.close();
  });
});

test("rejects a stale owner without changing pending content", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const fixture = await requestFixture(token);
  expect((await store.createPrepared(fixture)).ok).toBe(true);
  const stale = (token + 1) as typeof token;
  expect(
    await store.stopPendingRequests({
      fencingToken: stale,
      workspaceKey: requestTestWorkspace(),
      stoppedSessionId: fixture.request.targetSessionId,
    }),
  ).toEqual({ ok: false, code: "ownership_lost" });
  expect(privateCounts(store.databasePath, fixture.request.id)).toMatchObject({
    resolution: "pending",
    payloads: 1,
    edges: 1,
  });
  store.close();
});

test("leaves overdue pending requests for deadline expiry", async () => {
  const clock = requestClock();
  const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
  const token = await store.acquire();
  const fixture = await requestFixture(token, 1_000);
  expect((await store.createPrepared(fixture)).ok).toBe(true);
  clock.set(fixture.request.deadlineAtMs);

  expect(
    await store.stopPendingRequests({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      stoppedSessionId: fixture.request.targetSessionId,
    }),
  ).toEqual({ ok: true, terminalized: [] });
  expect(privateCounts(store.databasePath, fixture.request.id)).toMatchObject({
    resolution: "pending",
    payloads: 1,
    edges: 1,
  });

  const expired = await store.expireDueRequests({
    fencingToken: token,
    workspaceKey: requestTestWorkspace(),
    limit: 10,
  });
  expect(expired).toMatchObject({ ok: true });
  expect(privateCounts(store.databasePath, fixture.request.id)).toMatchObject({
    resolution: "deadline_expired",
    payloads: 0,
    edges: 0,
  });
  store.close();
});

test("fails closed for invalid, stale, and malformed participant stop candidate reads", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  expect(
    await store.listParticipantStopCandidates({
      fencingToken: token,
      workspaceKey: requestWorkspace("other-workspace"),
    }),
  ).toEqual({ ok: false, code: "storage_unavailable" });
  expect(
    await store.listParticipantStopCandidates({
      fencingToken: (token + 1) as typeof token,
      workspaceKey: requestTestWorkspace(),
    }),
  ).toEqual({ ok: false, code: "ownership_lost" });

  const fixture = await requestFixture(token);
  expect((await store.createPrepared(fixture)).ok).toBe(true);
  const corruption = new Database(store.databasePath, { strict: true });
  corruption.exec("PRAGMA ignore_check_constraints = ON");
  corruption.run("UPDATE requests SET source_session_id = 'bad' WHERE id = ?", [
    fixture.request.id,
  ]);
  corruption.close(true);
  expect(
    await store.listParticipantStopCandidates({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
    }),
  ).toEqual({ ok: false, code: "storage_unavailable" });
  store.close();
});
