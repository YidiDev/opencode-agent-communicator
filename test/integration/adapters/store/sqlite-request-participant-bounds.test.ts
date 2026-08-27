import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { dirname } from "node:path";

import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestClock,
  requestFixture,
  requestFixtureForPayload,
  requestSession,
  requestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

test.each(["exact-get", "participant-list"] as const)(
  "%s expiry survives wall-clock regression behind a later delivery update",
  async (mode) => {
    let wallMs = 25_000;
    const store = openRequestStore({ nowWallMs: () => wallMs, nowMonotonicMs: () => 25_000 });
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    await store.claimPrepared({
      fencingToken: token,
      workspaceKey: fixture.request.workspaceKey,
      requestId: fixture.request.id,
    });
    const reached = await store.signalWait({
      fencingToken: token,
      workspaceKey: fixture.request.workspaceKey,
      requestId: fixture.request.id,
      callerSessionId: fixture.request.targetSessionId,
      evidence: "retained",
    });
    if (!reached.ok || reached.outcome !== "applied") throw new Error("missing result fixture");
    const expiresAtMs = reached.request.resultExpiresAtMs;
    const lateUpdatedAtMs = expiresAtMs + 1_000;
    wallMs = lateUpdatedAtMs;
    const lease = new Database(store.databasePath, { strict: true });
    lease.run("UPDATE ownership SET renewed_wall_ms = ?, expires_wall_ms = ? WHERE singleton = 1", [
      wallMs,
      wallMs + 300_000,
    ]);
    lease.close(true);
    expect(
      await store.completeDelivery({
        fencingToken: token,
        workspaceKey: fixture.request.workspaceKey,
        requestId: fixture.request.id,
        outcome: "delivery_unknown",
      }),
    ).toMatchObject({ ok: true, request: { updatedAtMs: lateUpdatedAtMs } });

    wallMs = expiresAtMs;
    if (mode === "exact-get") {
      expect(
        await store.getParticipantRequest({
          fencingToken: token,
          workspaceKey: fixture.request.workspaceKey,
          requestId: fixture.request.id,
          callerSessionId: fixture.request.sourceSessionId,
        }),
      ).toMatchObject({
        outcome: "result_expired",
        metadata: {
          resultState: "expired",
          resultExpiredAtMs: expiresAtMs,
          updatedAtMs: lateUpdatedAtMs,
        },
      });
    } else {
      expect(
        (
          await store.listForParticipant({
            fencingToken: token,
            workspaceKey: fixture.request.workspaceKey,
            callerSessionId: fixture.request.sourceSessionId,
            role: "outbox",
            limit: 50,
          })
        ).items[0],
      ).toMatchObject({
        resultState: "expired",
        resultExpiredAtMs: expiresAtMs,
        updatedAtMs: lateUpdatedAtMs,
      });
    }
    const database = new Database(store.databasePath, { readonly: true, strict: true });
    expect(
      database
        .query<{ updatedAtMs: number; resultExpiredAtMs: number; results: number }, [string]>(
          `SELECT updated_at_ms AS updatedAtMs, result_expired_at_ms AS resultExpiredAtMs,
             (SELECT count(*) FROM request_results rr WHERE rr.request_id = r.id) AS results
           FROM requests r WHERE id = ?`,
        )
        .get(fixture.request.id),
    ).toEqual({ updatedAtMs: lateUpdatedAtMs, resultExpiredAtMs: expiresAtMs, results: 0 });
    database.close();
    store.close();
  },
);

test("reopening with lower pending limits still drains an exact 100-row target backlog", async () => {
  const clock = requestClock();
  const initial = openRequestStore({
    nowWallMs: clock.wall,
    nowMonotonicMs: clock.monotonic,
    limits: {
      pendingRequestsPerTarget: 256,
      pendingRequestsPerWorkspace: 1_024,
      requestsPerTargetWindow: 300,
      requestsPerWorkspaceWindow: 1_000,
    },
  });
  const token = await initial.acquire();
  const target = requestSession("ses_reopenpendingtarget");
  let deadlineAtMs = 0;
  for (let index = 1; index <= 100; index++) {
    const fixture = await requestFixtureForPayload(
      token,
      { kind: "wait", milestone: `pending${index}`, timeoutSeconds: 30 },
      { identitySeed: index, sourceName: `ses_reopensource${index}`, targetName: target },
    );
    deadlineAtMs = fixture.request.deadlineAtMs;
    expect((await initial.createPrepared(fixture)).ok).toBe(true);
  }
  const stateDirectory = dirname(initial.databasePath);
  const workspaceKey = requestWorkspace("request-test");
  initial.close();
  clock.set(deadlineAtMs);
  const reopened = openRequestStore({
    stateDirectory,
    nowWallMs: clock.wall,
    nowMonotonicMs: clock.monotonic,
    limits: {
      pendingRequestsPerTarget: 1,
      pendingRequestsPerWorkspace: 1,
      requestsPerTargetWindow: 1,
      requestsPerWorkspaceWindow: 1,
    },
  });
  const reopenedToken = await reopened.acquire();
  expect(
    (
      await reopened.listForParticipant({
        fencingToken: reopenedToken,
        workspaceKey,
        callerSessionId: target,
        role: "inbox",
        limit: 1,
      })
    ).items,
  ).toEqual([]);
  const database = new Database(reopened.databasePath, { readonly: true, strict: true });
  expect(
    database
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM requests WHERE resolution_state = 'pending'",
      )
      .get()?.count,
  ).toBe(0);
  database.close();
  reopened.close();
}, 60_000);

test("reopening with lower result limits still drains an exact 100-row source backlog", async () => {
  let wallMs = 25_000;
  const initial = openRequestStore({
    nowWallMs: () => wallMs,
    nowMonotonicMs: () => 25_000,
    limits: {
      requestsPerSourceWindow: 100,
      requestsPerWorkspaceWindow: 1_000,
      availableResultsPerSource: 512,
      availableResultsPerWorkspace: 4_096,
    },
  });
  const token = await initial.acquire();
  const source = requestSession("ses_reopenresultsource");
  let expiresAtMs = 0;
  for (let index = 1; index <= 100; index++) {
    const fixture = await requestFixtureForPayload(
      token,
      { kind: "wait", milestone: `result${index}`, timeoutSeconds: 30 },
      { identitySeed: index, sourceName: source, targetName: `ses_reopenresulttarget${index}` },
    );
    expect((await initial.createPrepared(fixture)).ok).toBe(true);
    const reached = await initial.signalWait({
      fencingToken: token,
      workspaceKey: fixture.request.workspaceKey,
      requestId: fixture.request.id,
      callerSessionId: fixture.request.targetSessionId,
    });
    if (!reached.ok || reached.outcome !== "applied") throw new Error("missing result backlog");
    expiresAtMs = reached.request.resultExpiresAtMs;
  }
  const stateDirectory = dirname(initial.databasePath);
  const workspaceKey = requestWorkspace("request-test");
  initial.close();
  wallMs = expiresAtMs;
  const reopened = openRequestStore({
    stateDirectory,
    nowWallMs: () => wallMs,
    nowMonotonicMs: () => 25_000,
    limits: {
      requestsPerSourceWindow: 1,
      requestsPerWorkspaceWindow: 1,
      availableResultsPerSource: 1,
      availableResultsPerWorkspace: 1,
    },
  });
  const reopenedToken = await reopened.acquire();
  await reopened.listForParticipant({
    fencingToken: reopenedToken,
    workspaceKey,
    callerSessionId: source,
    role: "outbox",
    limit: 1,
  });
  const database = new Database(reopened.databasePath, { readonly: true, strict: true });
  expect(
    database
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM requests WHERE result_state = 'available'",
      )
      .get()?.count,
  ).toBe(0);
  database.close();
  reopened.close();
});

test("first and deep participant pages seek v6 indexes without scans or temporary sorts", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const fixture = await requestFixture(token);
  await store.createPrepared(fixture);
  const database = new Database(store.databasePath, { readonly: true, strict: true });
  const firstPlans = [
    database
      .query<{ detail: string }, [string, string, number]>(
        "EXPLAIN QUERY PLAN SELECT id FROM requests INDEXED BY requests_participant_inbox WHERE workspace_key=? AND target_session_id=? AND resolution_state='pending' ORDER BY created_at_ms DESC,id DESC LIMIT ?",
      )
      .all(fixture.request.workspaceKey, fixture.request.targetSessionId, 101),
    database
      .query<{ detail: string }, [string, string, number]>(
        "EXPLAIN QUERY PLAN SELECT id FROM requests INDEXED BY requests_participant_outbox WHERE workspace_key=? AND source_session_id=? AND (resolution_state='pending' OR resolution_state NOT IN ('answered','reached') OR result_state!='acknowledged') ORDER BY created_at_ms DESC,id DESC LIMIT ?",
      )
      .all(fixture.request.workspaceKey, fixture.request.sourceSessionId, 101),
  ];
  const deepPlans = [
    database
      .query<{ detail: string }, [string, string, number, string, number]>(
        "EXPLAIN QUERY PLAN SELECT id FROM requests INDEXED BY requests_participant_inbox WHERE workspace_key=? AND target_session_id=? AND resolution_state='pending' AND (created_at_ms,id) < (?,?) ORDER BY created_at_ms DESC,id DESC LIMIT ?",
      )
      .all(
        fixture.request.workspaceKey,
        fixture.request.targetSessionId,
        fixture.request.createdAtMs,
        fixture.request.id,
        101,
      ),
    database
      .query<{ detail: string }, [string, string, number, string, number]>(
        "EXPLAIN QUERY PLAN SELECT id FROM requests INDEXED BY requests_participant_outbox WHERE workspace_key=? AND source_session_id=? AND (resolution_state='pending' OR resolution_state NOT IN ('answered','reached') OR result_state!='acknowledged') AND (created_at_ms,id) < (?,?) ORDER BY created_at_ms DESC,id DESC LIMIT ?",
      )
      .all(
        fixture.request.workspaceKey,
        fixture.request.sourceSessionId,
        fixture.request.createdAtMs,
        fixture.request.id,
        101,
      ),
  ];
  const maintenancePlans = [
    database
      .query<{ detail: string }, [string, string, number, number]>(
        "EXPLAIN QUERY PLAN SELECT id FROM requests INDEXED BY requests_due_source WHERE workspace_key=? AND source_session_id=? AND resolution_state='pending' AND deadline_at_ms<=? ORDER BY deadline_at_ms,id LIMIT ?",
      )
      .all(fixture.request.workspaceKey, fixture.request.sourceSessionId, 99_999, 100),
    database
      .query<{ detail: string }, [string, string, number, number]>(
        "EXPLAIN QUERY PLAN SELECT id FROM requests INDEXED BY requests_due_target WHERE workspace_key=? AND target_session_id=? AND resolution_state='pending' AND deadline_at_ms<=? ORDER BY deadline_at_ms,id LIMIT ?",
      )
      .all(fixture.request.workspaceKey, fixture.request.targetSessionId, 99_999, 100),
    database
      .query<{ detail: string }, [string, string, number, number]>(
        "EXPLAIN QUERY PLAN SELECT id FROM requests INDEXED BY requests_result_due_source WHERE workspace_key=? AND source_session_id=? AND result_state='available' AND result_expires_at_ms<=? ORDER BY result_expires_at_ms,id LIMIT ?",
      )
      .all(fixture.request.workspaceKey, fixture.request.sourceSessionId, 99_999, 100),
  ];
  const plans = [...firstPlans, ...deepPlans, ...maintenancePlans]
    .flat()
    .map((row) => row.detail)
    .join(" | ");
  database.close();
  expect(plans).toContain("requests_participant_inbox");
  expect(plans).toContain("requests_participant_outbox");
  expect(plans).toContain("requests_due_source");
  expect(plans).toContain("requests_due_target");
  expect(plans).toContain("requests_result_due_source");
  expect(plans).toContain("(created_at_ms,id)<(?,?)");
  expect(plans).not.toMatch(/SCAN requests|TEMP B-TREE/i);
  store.close();
});
