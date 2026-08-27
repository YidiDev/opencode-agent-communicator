import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { RequestRuntime } from "../../../../src/application/request-runtime";
import { stopSession } from "../../../../src/application/stop-session";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestFixture,
  requestSession,
  requestTestWorkspace,
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
});
