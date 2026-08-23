import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestClock,
  requestFixture,
  requestFixtureForPayload,
  requestTestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

function target(fixture: Awaited<ReturnType<typeof requestFixture>>) {
  return {
    fencingToken: fixture.fencingToken,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
    callerSessionId: fixture.request.targetSessionId,
  };
}

function source(fixture: Awaited<ReturnType<typeof requestFixture>>) {
  return { ...target(fixture), callerSessionId: fixture.request.sourceSessionId };
}

function assertErased(databasePath: string, requestId: string): void {
  const database = new Database(databasePath, { readonly: true, strict: true });
  const row = database
    .query<
      { payloads: number; edges: number; digest: string | null; retained: number | null },
      [string]
    >(
      `SELECT (SELECT count(*) FROM request_payloads WHERE request_id = ?1) AS payloads,
        (SELECT count(*) FROM request_wait_edges WHERE request_id = ?1) AS edges,
        payload_sha256 AS digest, retained_content_byte_length AS retained
       FROM requests WHERE id = ?1`,
    )
    .get(requestId);
  expect(row).toEqual({ payloads: 0, edges: 0, digest: null, retained: null });
  database.close(true);
}

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

describe("terminal store-clock deadline boundaries", () => {
  test("answer uses before/exact/after transaction time", async () => {
    for (const delta of [-1, 0, 1] as const) {
      const clock = requestClock();
      const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
      const token = await store.acquire();
      const fixture = await requestFixtureForPayload(token, {
        kind: "ask",
        questions: [{ prompt: "q", options: ["a"] }],
        timeoutSeconds: 30,
      });
      await store.createPrepared(fixture);
      clock.set(fixture.request.deadlineAtMs + delta);
      const result = await store.answerAsk({ ...target(fixture), answers: [["a"]] });
      if (delta < 0) {
        expect(result).toMatchObject({ ok: true, request: { resolutionState: "answered" } });
      } else {
        expect(result).toMatchObject({
          ok: false,
          code: "state_conflict",
          request: { resolutionState: "deadline_expired", resolvedAtMs: clock.wall() },
        });
      }
      assertErased(store.databasePath, fixture.request.id);
      store.close();
    }
  });

  test("signal uses before/exact/after transaction time", async () => {
    for (const delta of [-1, 0, 1] as const) {
      const clock = requestClock();
      const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
      const token = await store.acquire();
      const fixture = await requestFixture(token);
      await store.createPrepared(fixture);
      clock.set(fixture.request.deadlineAtMs + delta);
      const result = await store.signalWait(target(fixture));
      expect(result).toMatchObject(
        delta < 0
          ? { ok: true, request: { resolutionState: "reached" } }
          : {
              ok: false,
              code: "state_conflict",
              request: { resolutionState: "deadline_expired", resolvedAtMs: clock.wall() },
            },
      );
      assertErased(store.databasePath, fixture.request.id);
      store.close();
    }
  });

  test("cancel uses before/exact/after transaction time and reports typed terminal state", async () => {
    for (const delta of [-1, 0, 1] as const) {
      const clock = requestClock();
      const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
      const token = await store.acquire();
      const fixture = await requestFixture(token);
      await store.createPrepared(fixture);
      clock.set(fixture.request.deadlineAtMs + delta);
      expect(await store.cancelPending(source(fixture))).toMatchObject(
        delta < 0
          ? { ok: true, outcome: "applied", resolutionState: "cancelled" }
          : {
              ok: true,
              outcome: "terminal_state",
              resolutionState: "deadline_expired",
              request: { resolvedAtMs: clock.wall() },
            },
      );
      assertErased(store.databasePath, fixture.request.id);
      store.close();
    }
  });

  test("uses a delayed store clock rather than fixture or caller time", async () => {
    const clock = requestClock(999);
    const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 999 });
    const token = await store.acquire();
    const fixture = await requestFixture(token, 0);
    await store.createPrepared(fixture);
    setWallAndExtendLease(clock, store.databasePath, fixture.request.deadlineAtMs - 1);
    expect(await store.signalWait(target(fixture))).toMatchObject({
      ok: true,
      request: { resolvedAtMs: fixture.request.deadlineAtMs - 1 },
    });
    store.close();
  });

  test("exact deadline expires and erases even with corrupt or missing payload, envelope, or edge", async () => {
    for (const variant of ["payload", "envelope", "missing-payload", "missing-edge"] as const) {
      const clock = requestClock();
      const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
      const token = await store.acquire();
      const fixture = await requestFixture(token);
      await store.createPrepared(fixture);
      const raw = new Database(store.databasePath, { strict: true });
      if (variant === "payload") {
        raw.run("UPDATE request_payloads SET payload_json = '{}' WHERE request_id = ?", [
          fixture.request.id,
        ]);
      } else if (variant === "envelope") {
        raw.run("UPDATE request_payloads SET envelope_json = '{}' WHERE request_id = ?", [
          fixture.request.id,
        ]);
      } else if (variant === "missing-payload") {
        raw.run("DELETE FROM request_payloads WHERE request_id = ?", [fixture.request.id]);
      } else {
        raw.run("DELETE FROM request_wait_edges WHERE request_id = ?", [fixture.request.id]);
      }
      raw.close(true);
      clock.set(fixture.request.deadlineAtMs);
      expect(await store.signalWait(target(fixture))).toMatchObject({
        ok: false,
        code: "state_conflict",
        request: { resolutionState: "deadline_expired" },
      });
      assertErased(store.databasePath, fixture.request.id);
      store.close();
    }
  });

  test("predeadline corrupt content fails closed without returning private content", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    const raw = new Database(store.databasePath, { strict: true });
    raw.run("UPDATE request_payloads SET payload_json = '{}' WHERE request_id = ?", [
      fixture.request.id,
    ]);
    raw.close(true);
    const result = await store.signalWait(target(fixture));
    expect(result).toEqual({ ok: false, code: "state_conflict" });
    expect(JSON.stringify(result)).not.toContain("compiled");
    store.close();
  });
});

describe("serialized terminal operation orders", () => {
  test("answer then cancel and cancel then answer each retain one authoritative winner", async () => {
    for (const answerFirst of [true, false]) {
      const store = openRequestStore();
      const token = await store.acquire();
      const fixture = await requestFixtureForPayload(token, {
        kind: "ask",
        questions: [{ prompt: "q", options: ["a"] }],
        timeoutSeconds: 30,
      });
      await store.createPrepared(fixture);
      if (answerFirst) {
        expect(await store.answerAsk({ ...target(fixture), answers: [["a"]] })).toMatchObject({
          ok: true,
        });
        expect(await store.cancelPending(source(fixture))).toMatchObject({
          ok: true,
          outcome: "terminal_state",
          resolutionState: "answered",
        });
      } else {
        expect(await store.cancelPending(source(fixture))).toMatchObject({
          ok: true,
          outcome: "applied",
        });
        expect(await store.answerAsk({ ...target(fixture), answers: [["a"]] })).toMatchObject({
          ok: false,
          code: "state_conflict",
          request: { resolutionState: "cancelled" },
        });
      }
      assertErased(store.databasePath, fixture.request.id);
      store.close();
    }
  });

  test("signal then cancel and cancel then signal each retain one authoritative winner", async () => {
    for (const signalFirst of [true, false]) {
      const store = openRequestStore();
      const token = await store.acquire();
      const fixture = await requestFixture(token);
      await store.createPrepared(fixture);
      if (signalFirst) {
        expect(await store.signalWait(target(fixture))).toMatchObject({ ok: true });
        expect(await store.cancelPending(source(fixture))).toMatchObject({
          ok: true,
          outcome: "terminal_state",
          resolutionState: "reached",
        });
      } else {
        expect(await store.cancelPending(source(fixture))).toMatchObject({
          ok: true,
          outcome: "applied",
        });
        expect(await store.signalWait(target(fixture))).toMatchObject({
          ok: false,
          request: { resolutionState: "cancelled" },
        });
      }
      assertErased(store.databasePath, fixture.request.id);
      store.close();
    }
  });

  test("target action versus deadline materialization is authoritative in both orders", async () => {
    for (const targetFirst of [true, false]) {
      const clock = requestClock();
      const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
      const token = await store.acquire();
      const fixture = await requestFixture(token);
      await store.createPrepared(fixture);
      if (targetFirst) {
        clock.set(fixture.request.deadlineAtMs - 1);
        expect(await store.signalWait(target(fixture))).toMatchObject({ ok: true });
        clock.set(fixture.request.deadlineAtMs);
        expect(
          await store.expireDueRequests({
            fencingToken: token,
            workspaceKey: requestTestWorkspace(),
            limit: 1,
          }),
        ).toEqual({ ok: true, requests: [] });
      } else {
        clock.set(fixture.request.deadlineAtMs);
        expect(
          await store.expireDueRequests({
            fencingToken: token,
            workspaceKey: requestTestWorkspace(),
            limit: 1,
          }),
        ).toMatchObject({ ok: true, requests: [{ resolutionState: "deadline_expired" }] });
        expect(await store.signalWait(target(fixture))).toMatchObject({
          ok: false,
          request: { resolutionState: "deadline_expired" },
        });
      }
      assertErased(store.databasePath, fixture.request.id);
      store.close();
    }
  });

  test("cancellation versus due expiry is authoritative in both orders", async () => {
    for (const cancelFirst of [true, false]) {
      const clock = requestClock();
      const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
      const token = await store.acquire();
      const fixture = await requestFixture(token);
      await store.createPrepared(fixture);
      if (cancelFirst) {
        clock.set(fixture.request.deadlineAtMs - 1);
        expect(await store.cancelPending(source(fixture))).toMatchObject({
          resolutionState: "cancelled",
        });
        clock.set(fixture.request.deadlineAtMs);
        expect(
          await store.expireDueRequests({
            fencingToken: token,
            workspaceKey: requestTestWorkspace(),
            limit: 1,
          }),
        ).toEqual({ ok: true, requests: [] });
      } else {
        clock.set(fixture.request.deadlineAtMs);
        await store.expireDueRequests({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          limit: 1,
        });
        expect(await store.cancelPending(source(fixture))).toMatchObject({
          outcome: "terminal_state",
          resolutionState: "deadline_expired",
        });
      }
      assertErased(store.databasePath, fixture.request.id);
      store.close();
    }
  });
});
