import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { dirname } from "node:path";

import { getSessionRequest } from "../../../../src/application/get-session-request";
import type { FencingToken } from "../../../../src/domain/ownership";
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

function setWallAndExtendLease(
  clock: ReturnType<typeof requestClock>,
  databasePath: string,
  value: number,
): void {
  clock.set(value);
  const database = new Database(databasePath, { strict: true });
  database.run(
    "UPDATE ownership SET renewed_wall_ms = ?, expires_wall_ms = ? WHERE singleton = 1",
    [value, value + 300_000],
  );
  database.close(true);
}

test("enforces inbox/outbox/all state roles and never leaks private list content", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const fixture = await requestFixture(token);
  expect((await store.createPrepared(fixture)).ok).toBe(true);
  const source = fixture.request.sourceSessionId;
  const target = fixture.request.targetSessionId;
  const workspaceKey = fixture.request.workspaceKey;

  const inbox = await store.listForParticipant({
    fencingToken: token,
    workspaceKey,
    callerSessionId: target,
    role: "inbox",
    limit: 50,
  });
  const outbox = await store.listForParticipant({
    fencingToken: token,
    workspaceKey,
    callerSessionId: source,
    role: "outbox",
    limit: 50,
  });
  expect(inbox.items).toHaveLength(1);
  expect(outbox.items).toHaveLength(1);
  expect(inbox.items[0]?.participantRole).toBe("target");
  expect(outbox.items[0]?.participantRole).toBe("source");
  expect(JSON.stringify(inbox)).not.toMatch(
    /milestone|compiled|payload|digest|sha256|native|workspace|byteLength|evidence/i,
  );
  expect(
    (
      await store.listForParticipant({
        fencingToken: token,
        workspaceKey,
        callerSessionId: requestSession("ses_unrelated"),
        role: "all",
        limit: 50,
      })
    ).items,
  ).toEqual([]);

  const reached = await store.signalWait({
    fencingToken: token,
    workspaceKey,
    requestId: fixture.request.id,
    callerSessionId: target,
    evidence: "private proof",
  });
  expect(reached.ok).toBe(true);
  expect(
    (
      await store.listForParticipant({
        fencingToken: token,
        workspaceKey,
        callerSessionId: target,
        role: "inbox",
        limit: 50,
      })
    ).items,
  ).toEqual([]);
  const terminal = await store.listForParticipant({
    fencingToken: token,
    workspaceKey,
    callerSessionId: source,
    role: "outbox",
    limit: 50,
  });
  expect(terminal.items).toHaveLength(1);
  expect(JSON.stringify(terminal)).not.toContain("private proof");

  expect(
    (
      await store.acknowledgeResult({
        fencingToken: token,
        workspaceKey,
        requestId: fixture.request.id,
        callerSessionId: source,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await store.listForParticipant({
        fencingToken: token,
        workspaceKey,
        callerSessionId: source,
        role: "outbox",
        limit: 50,
      })
    ).items,
  ).toEqual([]);
  const exact = await store.getParticipantRequest({
    fencingToken: token,
    workspaceKey,
    requestId: fixture.request.id,
    callerSessionId: source,
  });
  expect(exact?.outcome).toBe("result_expired");
  store.close();
});

test("returns payload only to a pending target and retained result only to the source", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const fixture = await requestFixtureForPayload(token, {
    kind: "ask",
    questions: [{ prompt: "Choose", options: ["A"], multiple: false, allowCustom: false }],
    timeoutSeconds: 30,
  });
  await store.createPrepared(fixture);
  const common = {
    fencingToken: token,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
  };
  expect(
    await store.getParticipantRequest({
      ...common,
      callerSessionId: fixture.request.targetSessionId,
    }),
  ).toMatchObject({
    outcome: "pending_payload",
    payload: { kind: "ask", questions: [{ prompt: "Choose" }] },
  });
  expect(
    await store.getParticipantRequest({
      ...common,
      callerSessionId: fixture.request.sourceSessionId,
    }),
  ).toMatchObject({ outcome: "metadata" });
  const answered = await store.answerAsk({
    ...common,
    callerSessionId: fixture.request.targetSessionId,
    answers: [["A"]],
  });
  expect(answered.ok).toBe(true);
  expect(
    await store.getParticipantRequest({
      ...common,
      callerSessionId: fixture.request.sourceSessionId,
    }),
  ).toMatchObject({
    outcome: "available_result",
    result: { kind: "ask", answers: [["A"]] },
  });
  expect(
    await store.getParticipantRequest({
      ...common,
      callerSessionId: fixture.request.targetSessionId,
    }),
  ).toMatchObject({ outcome: "metadata" });
  store.close();
});

test("explicit projection allowlist does not leak future stored parent properties", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const fixture = await requestFixture(token);
  await store.createPrepared(fixture);
  const raw = new Database(store.databasePath, { strict: true });
  raw.exec("ALTER TABLE requests ADD COLUMN future_private_value TEXT");
  raw.run("UPDATE requests SET future_private_value = 'must-not-leak' WHERE id = ?", [
    fixture.request.id,
  ]);
  raw.close(true);
  const found = await store.getParticipantRequest({
    fencingToken: token,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
    callerSessionId: fixture.request.sourceSessionId,
  });
  expect(JSON.stringify(found)).not.toContain("future_private_value");
  expect(JSON.stringify(found)).not.toContain("must-not-leak");
  store.close();
});

test("retains non-result terminal outcomes in outbox and exposes metadata only", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const fixture = await requestFixture(token);
  await store.createPrepared(fixture);
  const common = {
    fencingToken: token,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
  };
  expect(
    (
      await store.cancelPending({
        ...common,
        callerSessionId: fixture.request.sourceSessionId,
      })
    ).ok,
  ).toBe(true);
  const listed = await store.listForParticipant({
    fencingToken: token,
    workspaceKey: fixture.request.workspaceKey,
    callerSessionId: fixture.request.sourceSessionId,
    role: "outbox",
    limit: 50,
  });
  expect(listed.items).toMatchObject([{ resolutionState: "cancelled", resultState: "none" }]);
  expect(
    await store.getParticipantRequest({
      ...common,
      callerSessionId: fixture.request.sourceSessionId,
    }),
  ).toMatchObject({ outcome: "metadata", metadata: { resolutionState: "cancelled" } });
  expect(
    await store.getParticipantRequest({
      ...common,
      callerSessionId: fixture.request.targetSessionId,
    }),
  ).toMatchObject({ outcome: "metadata", metadata: { participantRole: "target" } });
  store.close();
});

test("makes absent, unrelated, and foreign workspace exact gets indistinguishable", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const fixture = await requestFixture(token);
  await store.createPrepared(fixture);
  const base = {
    fencingToken: token,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
  };
  const unrelated = await store.getParticipantRequest({
    ...base,
    callerSessionId: requestSession("ses_other"),
  });
  const absent = await store.getParticipantRequest({
    ...base,
    requestId: `req_${"f".repeat(32)}` as typeof fixture.request.id,
    callerSessionId: fixture.request.sourceSessionId,
  });
  const foreign = await store.getParticipantRequest({
    ...base,
    workspaceKey: requestWorkspace("foreign"),
    callerSessionId: fixture.request.sourceSessionId,
  });
  expect(unrelated).toBeUndefined();
  expect(absent).toEqual(unrelated);
  expect(foreign).toEqual(unrelated);
  store.close();
});

test("unauthorized exact get cannot expire or inspect a corrupt due request", async () => {
  const clock = requestClock();
  const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
  const token = await store.acquire();
  const fixture = await requestFixture(token);
  await store.createPrepared(fixture);
  const raw = new Database(store.databasePath, { strict: true });
  raw.run("UPDATE request_payloads SET payload_json = ? WHERE request_id = ?", [
    '{"timeoutSeconds":30,"milestone":"corrupt","kind":"wait"}',
    fixture.request.id,
  ]);
  const snapshot = () =>
    raw
      .query<{ resolutionState: string; payloads: number; edges: number }, [string]>(
        `SELECT resolution_state AS resolutionState,
          (SELECT count(*) FROM request_payloads WHERE request_id = r.id) AS payloads,
          (SELECT count(*) FROM request_wait_edges WHERE request_id = r.id) AS edges
         FROM requests r WHERE id = ?`,
      )
      .get(fixture.request.id);
  const before = snapshot();
  setWallAndExtendLease(clock, store.databasePath, fixture.request.deadlineAtMs);
  const unrelated = requestSession("ses_unrelateddue");
  expect(
    await store.getParticipantRequest({
      fencingToken: token,
      workspaceKey: fixture.request.workspaceKey,
      requestId: fixture.request.id,
      callerSessionId: unrelated,
    }),
  ).toBeUndefined();
  expect(snapshot()).toEqual(before);
  raw.close(true);

  const ports = {
    membership: {
      readCurrentRoots: async () => ({
        sourceTitle: undefined,
        sourceVisible: true,
        targetVisible: false,
      }),
    },
    requests: store,
  };
  const unrelatedResult = await getSessionRequest(
    ports,
    {
      workspaceKey: fixture.request.workspaceKey,
      callerSessionId: unrelated,
      fencingToken: token,
    },
    { request_id: fixture.request.id },
  );
  const absentResult = await getSessionRequest(
    ports,
    {
      workspaceKey: fixture.request.workspaceKey,
      callerSessionId: fixture.request.sourceSessionId,
      fencingToken: token,
    },
    { request_id: `req_${"f".repeat(32)}` },
  );
  expect(unrelatedResult).toEqual(absentResult);
  store.close();
});

test("list maintenance terminalizes only the caller's authorized dimensions", async () => {
  const clock = requestClock();
  const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
  const token = await store.acquire();
  const callerFixture = await requestFixtureForPayload(
    token,
    { kind: "wait", milestone: "caller", timeoutSeconds: 30 },
    { identitySeed: 21, sourceName: "ses_callersource", targetName: "ses_callertarget" },
  );
  const unrelatedFixture = await requestFixtureForPayload(
    token,
    { kind: "wait", milestone: "unrelated", timeoutSeconds: 30 },
    { identitySeed: 22, sourceName: "ses_othersource", targetName: "ses_othertarget" },
  );
  await store.createPrepared(callerFixture);
  await store.createPrepared(unrelatedFixture);
  setWallAndExtendLease(clock, store.databasePath, callerFixture.request.deadlineAtMs);
  await store.listForParticipant({
    fencingToken: token,
    workspaceKey: callerFixture.request.workspaceKey,
    callerSessionId: callerFixture.request.targetSessionId,
    role: "inbox",
    limit: 50,
  });
  const database = new Database(store.databasePath, { readonly: true, strict: true });
  const states = database
    .query<{ id: string; state: string }, []>(
      "SELECT id, resolution_state AS state FROM requests ORDER BY id",
    )
    .all();
  database.close();
  expect(states.find((row) => row.id === callerFixture.request.id)?.state).toBe("deadline_expired");
  expect(states.find((row) => row.id === unrelatedFixture.request.id)?.state).toBe("pending");
  store.close();
});

test("fences stale and startup-blocked participant reads before foreign workspace return", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const fixture = await requestFixture(token);
  await store.createPrepared(fixture);
  const stale = (token + 1) as FencingToken;
  const get = {
    requestId: fixture.request.id,
    callerSessionId: fixture.request.sourceSessionId,
  };
  const list = {
    callerSessionId: fixture.request.sourceSessionId,
    role: "all" as const,
    limit: 1,
  };
  for (const workspaceKey of [fixture.request.workspaceKey, requestWorkspace("foreign")]) {
    await expect(
      store.getParticipantRequest({ ...get, fencingToken: stale, workspaceKey }),
    ).rejects.toThrow();
    await expect(
      store.listForParticipant({ ...list, fencingToken: stale, workspaceKey }),
    ).rejects.toThrow();
  }
  const stateDirectory = dirname(store.databasePath);
  await store.claimPrepared({
    fencingToken: token,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
  });
  store.close();
  const recovering = openRequestStore({ stateDirectory });
  const recoveringToken = await recovering.acquire();
  await expect(
    recovering.getParticipantRequest({
      ...get,
      fencingToken: recoveringToken,
      workspaceKey: fixture.request.workspaceKey,
    }),
  ).rejects.toThrow();
  await expect(
    recovering.listForParticipant({
      ...list,
      fencingToken: recoveringToken,
      workspaceKey: fixture.request.workspaceKey,
    }),
  ).rejects.toThrow();
  recovering.close();
});

test("all role merges equal-time streams with exact roles and stable cross-stream boundaries", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const caller = requestSession("ses_mergecaller");
  const fixtures = [];
  for (let seed = 1; seed <= 6; seed++) {
    const inbox = seed % 2 === 0;
    const fixture = await requestFixtureForPayload(
      token,
      { kind: "wait", milestone: `m${seed}`, timeoutSeconds: 30 },
      {
        createdAtMs: 1_000,
        identitySeed: seed,
        sourceName: inbox ? `ses_source${seed}` : caller,
        targetName: inbox ? caller : `ses_target${seed}`,
      },
    );
    fixtures.push(fixture);
    await store.createPrepared(fixture);
  }
  const seen = new Set<string>();
  const roles: string[] = [];
  let boundary:
    | {
        readonly createdAtMs: number;
        readonly requestId: (typeof fixtures)[number]["request"]["id"];
      }
    | undefined;
  for (let pageNumber = 0; pageNumber < fixtures.length; pageNumber++) {
    const page = await store.listForParticipant({
      fencingToken: token,
      workspaceKey: fixtures[0]?.request.workspaceKey ?? requestWorkspace("missing"),
      callerSessionId: caller,
      role: "all",
      ...(boundary ? { boundary } : {}),
      limit: 1,
    });
    expect(page.items).toHaveLength(1);
    const item = page.items[0];
    if (!item) throw new Error("missing merged item");
    expect(seen.has(item.requestId)).toBe(false);
    seen.add(item.requestId);
    roles.push(item.participantRole);
    boundary = { createdAtMs: item.createdAtMs, requestId: item.requestId };
    expect(page.hasMore).toBe(pageNumber < fixtures.length - 1);
  }
  expect([...seen]).toHaveLength(6);
  expect(roles).toEqual(["target", "source", "target", "source", "target", "source"]);
  store.close();
});

test("uses stable descending keyset ties and rejects stale fencing", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const first = await requestFixtureForPayload(
    token,
    { kind: "wait", milestone: "one", timeoutSeconds: 30 },
    { createdAtMs: 1_000, identitySeed: 1 },
  );
  const second = await requestFixtureForPayload(
    token,
    { kind: "wait", milestone: "two", timeoutSeconds: 30 },
    { createdAtMs: 1_000, identitySeed: 2 },
  );
  await store.createPrepared(first);
  await store.createPrepared(second);
  const query = {
    fencingToken: token,
    workspaceKey: first.request.workspaceKey,
    callerSessionId: first.request.sourceSessionId,
    role: "all" as const,
    limit: 1,
  };
  const page1 = await store.listForParticipant(query);
  expect(page1.hasMore).toBe(true);
  const item = page1.items[0];
  if (!item) throw new Error("missing page");
  const unseen = item.requestId === first.request.id ? second : first;
  await store.cancelPending({
    fencingToken: token,
    workspaceKey: first.request.workspaceKey,
    requestId: item.requestId,
    callerSessionId: first.request.sourceSessionId,
  });
  await store.cancelPending({
    fencingToken: token,
    workspaceKey: first.request.workspaceKey,
    requestId: unseen.request.id,
    callerSessionId: first.request.sourceSessionId,
  });
  const insertedAfterBoundary = await requestFixtureForPayload(
    token,
    { kind: "wait", milestone: "newer", timeoutSeconds: 30 },
    { createdAtMs: 2_000, identitySeed: 3 },
  );
  await store.createPrepared(insertedAfterBoundary);
  const page2 = await store.listForParticipant({
    ...query,
    boundary: { createdAtMs: item.createdAtMs, requestId: item.requestId },
  });
  expect(page2.items[0]?.requestId).not.toBe(item.requestId);
  expect(page2.items[0]?.requestId).not.toBe(insertedAfterBoundary.request.id);
  expect(page2.items[0]?.requestId).toBe(unseen.request.id);
  expect(page1.items[0]?.requestId.localeCompare(page2.items[0]?.requestId ?? "")).toBeGreaterThan(
    0,
  );
  await expect(
    store.listForParticipant({ ...query, fencingToken: (token + 1) as FencingToken }),
  ).rejects.toThrow();
  store.close();
});

test("fails safely when an authorized private child is noncanonical", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const fixture = await requestFixture(token);
  await store.createPrepared(fixture);
  const raw = new Database(store.databasePath, { strict: true });
  raw.run("UPDATE request_payloads SET payload_json = ? WHERE request_id = ?", [
    '{"timeoutSeconds":30,"milestone":"compiled ✓","kind":"wait"}',
    fixture.request.id,
  ]);
  raw.close(true);
  await expect(
    store.getParticipantRequest({
      fencingToken: token,
      workspaceKey: fixture.request.workspaceKey,
      requestId: fixture.request.id,
      callerSessionId: fixture.request.targetSessionId,
    }),
  ).rejects.toThrow("Stored pending request content was invalid.");
  store.close();
});

test("fails safely for missing, wrong-kind, noncanonical, or digest-mismatched results", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const fixture = await requestFixture(token);
  await store.createPrepared(fixture);
  await store.signalWait({
    fencingToken: token,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
    callerSessionId: fixture.request.targetSessionId,
    evidence: "original",
  });
  const query = {
    fencingToken: token,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
    callerSessionId: fixture.request.sourceSessionId,
  };
  const raw = new Database(store.databasePath, { strict: true });
  for (const resultJson of [
    '{"kind":"ask","answers":[]}',
    '{"evidence":"original","kind":"wait"}',
    '{"kind":"wait","evidence":"changed"}',
  ]) {
    raw.run("UPDATE request_results SET result_json = ? WHERE request_id = ?", [
      resultJson,
      fixture.request.id,
    ]);
    await expect(store.getParticipantRequest(query)).rejects.toThrow();
  }
  raw.run("DELETE FROM request_results WHERE request_id = ?", [fixture.request.id]);
  await expect(store.getParticipantRequest(query)).rejects.toThrow();
  raw.close(true);
  store.close();
});

test("exact get expires retained results at the store-clock boundary without a sweeper", async () => {
  let wallMs = 25_000;
  const store = openRequestStore({ nowWallMs: () => wallMs, nowMonotonicMs: () => 25_000 });
  const token = await store.acquire();
  const fixture = await requestFixture(token);
  await store.createPrepared(fixture);
  const reached = await store.signalWait({
    fencingToken: token,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
    callerSessionId: fixture.request.targetSessionId,
    evidence: "retained",
  });
  if (!reached.ok || reached.outcome !== "applied") throw new Error("missing result fixture");
  const query = {
    fencingToken: token,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
    callerSessionId: fixture.request.sourceSessionId,
  };
  const setWall = (value: number) => {
    wallMs = value;
    const database = new Database(store.databasePath, { strict: true });
    database.run(
      "UPDATE ownership SET renewed_wall_ms = ?, expires_wall_ms = ? WHERE singleton = 1",
      [value, value + 300_000],
    );
    database.close(true);
  };
  setWall(reached.request.resultExpiresAtMs - 1);
  expect((await store.getParticipantRequest(query))?.outcome).toBe("available_result");
  const raw = new Database(store.databasePath, { strict: true });
  raw.run("UPDATE request_results SET result_json = ? WHERE request_id = ?", [
    '{"kind":"ask","answers":[]}',
    fixture.request.id,
  ]);
  raw.close(true);
  setWall(reached.request.resultExpiresAtMs);
  expect((await store.getParticipantRequest(query))?.outcome).toBe("result_expired");
  setWall(reached.request.resultExpiresAtMs + 1);
  expect((await store.getParticipantRequest(query))?.outcome).toBe("result_expired");
  const inspection = new Database(store.databasePath, { readonly: true, strict: true });
  expect(
    inspection
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM request_results WHERE request_id = ?",
      )
      .get(fixture.request.id)?.count,
  ).toBe(0);
  inspection.close();
  const listed = await store.listForParticipant({
    fencingToken: token,
    workspaceKey: fixture.request.workspaceKey,
    callerSessionId: fixture.request.sourceSessionId,
    role: "outbox",
    limit: 50,
  });
  expect(listed.items[0]).toMatchObject({ resultState: "expired" });
  store.close();
});

test("outbox result maintenance leaves unrelated due results available", async () => {
  let wallMs = 25_000;
  const store = openRequestStore({ nowWallMs: () => wallMs, nowMonotonicMs: () => 25_000 });
  const token = await store.acquire();
  const fixtures = [
    await requestFixtureForPayload(
      token,
      { kind: "wait", milestone: "owned", timeoutSeconds: 30 },
      { identitySeed: 31, sourceName: "ses_resultowner", targetName: "ses_resulttargetone" },
    ),
    await requestFixtureForPayload(
      token,
      { kind: "wait", milestone: "other", timeoutSeconds: 30 },
      { identitySeed: 32, sourceName: "ses_resultother", targetName: "ses_resulttargettwo" },
    ),
  ];
  let expiresAtMs = 0;
  for (const fixture of fixtures) {
    await store.createPrepared(fixture);
    const reached = await store.signalWait({
      fencingToken: token,
      workspaceKey: fixture.request.workspaceKey,
      requestId: fixture.request.id,
      callerSessionId: fixture.request.targetSessionId,
    });
    if (!reached.ok || reached.outcome !== "applied") throw new Error("missing scoped result");
    expiresAtMs = reached.request.resultExpiresAtMs;
  }
  wallMs = expiresAtMs;
  const lease = new Database(store.databasePath, { strict: true });
  lease.run("UPDATE ownership SET renewed_wall_ms = ?, expires_wall_ms = ? WHERE singleton = 1", [
    wallMs,
    wallMs + 300_000,
  ]);
  lease.close(true);
  const owned = fixtures[0];
  const other = fixtures[1];
  if (!owned || !other) throw new Error("missing scoped fixtures");
  await store.listForParticipant({
    fencingToken: token,
    workspaceKey: owned.request.workspaceKey,
    callerSessionId: owned.request.sourceSessionId,
    role: "outbox",
    limit: 50,
  });
  const database = new Database(store.databasePath, { readonly: true, strict: true });
  const states = database
    .query<{ id: string; state: string }, []>("SELECT id, result_state AS state FROM requests")
    .all();
  expect(states.find((row) => row.id === owned.request.id)?.state).toBe("expired");
  expect(states.find((row) => row.id === other.request.id)?.state).toBe("available");
  expect(
    database
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM request_results WHERE request_id = ?",
      )
      .get(other.request.id)?.count,
  ).toBe(1);
  database.close();
  store.close();
});

test("participant reads terminalize overdue pending requests, including a multi-batch backlog", async () => {
  const clock = requestClock();
  const store = openRequestStore({
    nowWallMs: clock.wall,
    nowMonotonicMs: clock.monotonic,
    limits: {
      pendingRequestsPerTarget: 256,
      pendingRequestsPerWorkspace: 1_024,
      requestsPerTargetWindow: 300,
      requestsPerWorkspaceWindow: 1_000,
    },
  });
  const token = await store.acquire();
  const target = requestSession("ses_backlogtarget");
  const fixtures = [];
  for (let index = 1; index <= 105; index++) {
    const fixture = await requestFixtureForPayload(
      token,
      { kind: "wait", milestone: `backlog${index}`, timeoutSeconds: 30 },
      {
        createdAtMs: 1_000,
        identitySeed: index,
        sourceName: `ses_source${index}`,
        targetName: target,
      },
    );
    fixtures.push(fixture);
    expect((await store.createPrepared(fixture)).ok).toBe(true);
  }
  const exact = fixtures[0];
  if (!exact) throw new Error("missing backlog fixture");
  setWallAndExtendLease(clock, store.databasePath, exact.request.deadlineAtMs - 1);
  expect(
    (
      await store.getParticipantRequest({
        fencingToken: token,
        workspaceKey: exact.request.workspaceKey,
        requestId: exact.request.id,
        callerSessionId: target,
      })
    )?.outcome,
  ).toBe("pending_payload");
  setWallAndExtendLease(clock, store.databasePath, exact.request.deadlineAtMs);
  expect(
    (
      await store.getParticipantRequest({
        fencingToken: token,
        workspaceKey: exact.request.workspaceKey,
        requestId: exact.request.id,
        callerSessionId: target,
      })
    )?.outcome,
  ).toBe("metadata");
  expect(
    (
      await store.listForParticipant({
        fencingToken: token,
        workspaceKey: exact.request.workspaceKey,
        callerSessionId: target,
        role: "inbox",
        limit: 100,
      })
    ).items,
  ).toEqual([]);
  const database = new Database(store.databasePath, { readonly: true, strict: true });
  expect(
    database
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM requests WHERE resolution_state = 'pending'",
      )
      .get()?.count,
  ).toBe(0);
  database.close();
  store.close();
});
