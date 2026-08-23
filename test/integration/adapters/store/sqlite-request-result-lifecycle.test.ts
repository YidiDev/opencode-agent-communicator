import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { RequestId } from "../../../../src/domain/generated-ids";
import { requestLimits } from "../../../../src/domain/request-constants";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestClock,
  requestFixture,
  requestTestWorkspace,
  requestWorkspace,
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

function privateSnapshot(databasePath: string, requestId: string) {
  const database = new Database(databasePath, { readonly: true, strict: true });
  const row = database
    .query<
      {
        resolution: string;
        resultState: string;
        payloads: number;
        edges: number;
        results: number;
        resultBytes: number | null;
        resultDigest: string | null;
      },
      [string]
    >(
      `SELECT resolution_state AS resolution, result_state AS resultState,
       (SELECT count(*) FROM request_payloads WHERE request_id = ?1) AS payloads,
       (SELECT count(*) FROM request_wait_edges WHERE request_id = ?1) AS edges,
       (SELECT count(*) FROM request_results WHERE request_id = ?1) AS results,
       result_byte_length AS resultBytes, result_sha256 AS resultDigest
       FROM requests WHERE id = ?1`,
    )
    .get(requestId);
  database.close(true);
  if (!row) throw new Error("request row was absent");
  return row;
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

describe("cancellation lifecycle", () => {
  test("applies full erasure and repeated cancellation preserves the first timestamp", async () => {
    const clock = requestClock();
    const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    const first = await store.cancelPending(source(fixture));
    expect(first).toMatchObject({
      ok: true,
      outcome: "applied",
      resolutionState: "cancelled",
      request: { resolvedAtMs: 25_000, updatedAtMs: 25_000 },
    });
    expect(privateSnapshot(store.databasePath, fixture.request.id)).toEqual({
      resolution: "cancelled",
      resultState: "none",
      payloads: 0,
      edges: 0,
      results: 0,
      resultBytes: null,
      resultDigest: null,
    });
    clock.set(26_000);
    expect(await store.cancelPending(source(fixture))).toMatchObject({
      ok: true,
      outcome: "idempotent",
      resolutionState: "cancelled",
      request: { resolvedAtMs: 25_000, updatedAtMs: 25_000 },
    });
    store.close();
  });

  test("cancellation after every non-answer terminal state reports exact resolution", async () => {
    for (const state of [
      "reached",
      "deadline_expired",
      "delivery_failed",
      "target_stopped",
      "source_stopped",
      "target_deleted",
      "source_deleted",
    ] as const) {
      const clock = requestClock();
      const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
      const token = await store.acquire();
      const fixture = await requestFixture(token, 1_000 + state.length);
      await store.createPrepared(fixture);
      if (state === "reached") {
        await store.signalWait(target(fixture));
      } else if (state === "deadline_expired") {
        clock.set(fixture.request.deadlineAtMs);
        await store.expireDueRequests({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          limit: 1,
        });
      } else if (state === "delivery_failed") {
        await store.claimPrepared({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          requestId: fixture.request.id,
        });
        await store.completeDelivery({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          requestId: fixture.request.id,
          outcome: "delivery_failed",
        });
      } else {
        const raw = new Database(store.databasePath, { strict: true });
        raw.run("DELETE FROM request_payloads WHERE request_id = ?", [fixture.request.id]);
        raw.run("DELETE FROM request_wait_edges WHERE request_id = ?", [fixture.request.id]);
        raw.run(
          `UPDATE requests SET resolution_state = ?, resolved_at_ms = 25000, updated_at_ms = 25000,
             retained_content_byte_length = NULL, payload_sha256 = NULL WHERE id = ?`,
          [state, fixture.request.id],
        );
        raw.close(true);
      }
      expect(await store.cancelPending(source(fixture))).toMatchObject({
        ok: true,
        outcome: "terminal_state",
        resolutionState: state,
        request: { resolutionState: state },
      });
      store.close();
    }
  });

  test("late target actions preserve cancellation and return the authoritative state", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    const cancelled = await store.cancelPending(source(fixture));
    if (!cancelled.ok) throw new Error("cancellation unexpectedly failed");
    expect(await store.signalWait(target(fixture))).toEqual({
      ok: false,
      code: "state_conflict",
      request: cancelled.request,
    });
    store.close();
  });
});

describe("available result acknowledgement and expiry", () => {
  test("result remains available until the exact boundary and ack before/exact/after is deterministic", async () => {
    for (const delta of [-1, 0, 1] as const) {
      const clock = requestClock();
      const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
      const token = await store.acquire();
      const fixture = await requestFixture(token, 1_100 + delta);
      await store.createPrepared(fixture);
      const reached = await store.signalWait({ ...target(fixture), evidence: "proof" });
      if (!reached.ok || reached.request.resultState !== "available") {
        throw new Error("available result fixture failed");
      }
      const expiry = reached.request.resultExpiresAtMs;
      setWallAndExtendLease(clock, store.databasePath, expiry - 1);
      expect(
        await store.expireAvailableResults({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          limit: 1,
        }),
      ).toEqual({ ok: true, requests: [] });
      expect(privateSnapshot(store.databasePath, fixture.request.id).results).toBe(1);
      setWallAndExtendLease(clock, store.databasePath, expiry + delta);
      const ack = await store.acknowledgeResult(source(fixture));
      expect(ack).toMatchObject({
        ok: true,
        outcome: "applied",
        request: {
          resultState: "acknowledged",
          acknowledgedAtMs: expiry + delta,
          ...(delta < 0 ? {} : { resultExpiredAtMs: expiry + delta }),
        },
      });
      const firstTimestamp = expiry + delta;
      setWallAndExtendLease(clock, store.databasePath, firstTimestamp + 10);
      expect(await store.acknowledgeResult(source(fixture))).toMatchObject({
        ok: true,
        outcome: "idempotent",
        request: { acknowledgedAtMs: firstTimestamp },
      });
      expect(privateSnapshot(store.databasePath, fixture.request.id)).toMatchObject({
        resultState: "acknowledged",
        results: 0,
        resultBytes: null,
        resultDigest: null,
      });
      store.close();
    }
  });

  test("expiry first then ack and ack first then expiry scan preserve authoritative state", async () => {
    for (const expiryFirst of [true, false]) {
      const clock = requestClock();
      const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
      const token = await store.acquire();
      const fixture = await requestFixture(token, expiryFirst ? 1_201 : 1_202);
      await store.createPrepared(fixture);
      const reached = await store.signalWait(target(fixture));
      if (!reached.ok || reached.request.resultState !== "available")
        throw new Error("fixture failed");
      setWallAndExtendLease(clock, store.databasePath, reached.request.resultExpiresAtMs);
      if (expiryFirst) {
        expect(
          await store.expireAvailableResults({
            fencingToken: token,
            workspaceKey: requestTestWorkspace(),
            limit: 1,
          }),
        ).toMatchObject({ ok: true, requests: [{ resultState: "expired" }] });
        expect(await store.acknowledgeResult(source(fixture))).toMatchObject({
          ok: true,
          request: { resultState: "acknowledged" },
        });
      } else {
        await store.acknowledgeResult(source(fixture));
        expect(
          await store.expireAvailableResults({
            fencingToken: token,
            workspaceKey: requestTestWorkspace(),
            limit: 1,
          }),
        ).toEqual({ ok: true, requests: [] });
      }
      store.close();
    }
  });

  test("ack and expiry erase missing, corrupt, wrong-kind, and noncanonical child rows without starving due rows", async () => {
    for (const operation of ["ack", "expiry"] as const) {
      for (const [variant, json] of [
        ["missing", undefined],
        ["corrupt", "{}"],
        ["wrong-kind", '{"kind":"ask","answers":[[]]}'],
        ["noncanonical", '{ "kind": "wait" }'],
      ] as const) {
        const clock = requestClock();
        const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
        const token = await store.acquire();
        const first = await requestFixture(token, 1_300 + variant.length);
        const second = await requestFixture(
          token,
          1_400 + variant.length,
          "ses_source2",
          "ses_target2",
        );
        await store.createPrepared(first);
        await store.createPrepared(second);
        const firstReached = await store.signalWait(target(first));
        const secondReached = await store.signalWait(target(second));
        if (
          !firstReached.ok ||
          firstReached.request.resultState !== "available" ||
          !secondReached.ok
        ) {
          throw new Error("result fixtures failed");
        }
        const raw = new Database(store.databasePath, { strict: true });
        if (json === undefined) {
          raw.run("DELETE FROM request_results WHERE request_id = ?", [first.request.id]);
        } else {
          raw.run("UPDATE request_results SET result_json = ? WHERE request_id = ?", [
            json,
            first.request.id,
          ]);
        }
        raw.close(true);
        if (operation === "ack") {
          expect(await store.acknowledgeResult(source(first))).toMatchObject({
            ok: true,
            request: { resultState: "acknowledged" },
          });
        } else {
          setWallAndExtendLease(clock, store.databasePath, firstReached.request.resultExpiresAtMs);
          expect(
            await store.expireAvailableResults({
              fencingToken: token,
              workspaceKey: requestTestWorkspace(),
              limit: 2,
            }),
          ).toMatchObject({
            ok: true,
            requests: [{ resultState: "expired" }, { resultState: "expired" }],
          });
        }
        expect(privateSnapshot(store.databasePath, first.request.id)).toMatchObject({
          results: 0,
          resultBytes: null,
          resultDigest: null,
        });
        store.close();
      }
    }
  });

  test("late actions fail closed for unexpected, wrong-kind, and identity-mismatched result children", async () => {
    for (const variant of ["unexpected", "wrong-kind", "identity"] as const) {
      const store = openRequestStore();
      const token = await store.acquire();
      const fixture = await requestFixture(token, 1_450 + variant.length);
      await store.createPrepared(fixture);
      const raw = new Database(store.databasePath, { strict: true });
      if (variant === "unexpected") {
        raw.close(true);
        await store.cancelPending(source(fixture));
        const corrupt = new Database(store.databasePath, { strict: true });
        corrupt.exec("DROP TRIGGER request_results_available_insert");
        corrupt.run("INSERT INTO request_results(request_id, result_json) VALUES (?, ?)", [
          fixture.request.id,
          '{"kind":"wait"}',
        ]);
        corrupt.close(true);
        expect(await store.cancelPending(source(fixture))).toEqual({
          ok: false,
          code: "state_conflict",
        });
      } else {
        raw.close(true);
        await store.signalWait({ ...target(fixture), evidence: "original" });
        const corrupt = new Database(store.databasePath, { strict: true });
        corrupt.run("UPDATE request_results SET result_json = ? WHERE request_id = ?", [
          variant === "wrong-kind"
            ? '{"kind":"ask","answers":[[]]}'
            : '{"kind":"wait","evidence":"changed"}',
          fixture.request.id,
        ]);
        corrupt.close(true);
        expect(await store.signalWait(target(fixture))).toEqual({
          ok: false,
          code: "state_conflict",
        });
      }
      store.close();
    }
  });
});

describe("result batch expiry", () => {
  test("orders by result expiry then id and honors limits one and one hundred across 105 rows", async () => {
    const clock = requestClock();
    const store = openRequestStore({
      nowWallMs: clock.wall,
      nowMonotonicMs: () => 25_000,
      limits: {
        requestsPerWorkspaceWindow: 200,
        availableResultsPerWorkspace: 200,
      },
    });
    const token = await store.acquire();
    const expected: { id: RequestId; expires: number }[] = [];
    for (let index = 0; index < 105; index += 1) {
      const fixture = await requestFixture(token, 1_500 + index, `ses_s${index}`, `ses_t${index}`);
      await store.createPrepared(fixture);
      const reached = await store.signalWait(target(fixture));
      if (!reached.ok || reached.request.resultState !== "available")
        throw new Error("fixture failed");
      expected.push({ id: fixture.request.id, expires: reached.request.resultExpiresAtMs });
    }
    expected.sort((left, right) => left.expires - right.expires || left.id.localeCompare(right.id));
    setWallAndExtendLease(clock, store.databasePath, 25_000 + requestLimits.resultRetentionMs);
    const first = await store.expireAvailableResults({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      limit: 1,
    });
    expect(first).toMatchObject({ ok: true, requests: [{ id: expected[0]?.id }] });
    const second = await store.expireAvailableResults({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      limit: 100,
    });
    expect(second.ok ? second.requests.map((request) => request.id) : []).toEqual(
      expected.slice(1, 101).map((row) => row.id),
    );
    const third = await store.expireAvailableResults({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      limit: 100,
    });
    expect(third.ok ? third.requests.map((request) => request.id) : []).toEqual(
      expected.slice(101).map((row) => row.id),
    );
    store.close();
  });

  test("rejects invalid limits and workspace before ownership work", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    for (const limit of [0, 101, 1.5]) {
      expect(
        await store.expireAvailableResults({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          limit,
        }),
      ).toEqual({ ok: false, code: "state_conflict" });
    }
    expect(
      await store.expireAvailableResults({
        fencingToken: token,
        workspaceKey: requestWorkspace("foreign-workspace"),
        limit: 1,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    expect(
      await store.expireAvailableResults({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        limit: 1,
      }),
    ).toEqual({ ok: true, requests: [] });
    store.close();
  });
});

describe("terminal transaction rollback", () => {
  test("parent-update and child-insert aborts restore pending payload and edge exactly", async () => {
    for (const fault of ["parent", "child"] as const) {
      const store = openRequestStore();
      const token = await store.acquire();
      const fixture = await requestFixture(token, fault === "parent" ? 1_801 : 1_802);
      await store.createPrepared(fixture);
      const before = privateSnapshot(store.databasePath, fixture.request.id);
      const raw = new Database(store.databasePath, { strict: true });
      raw.exec(
        fault === "parent"
          ? `CREATE TRIGGER test_abort_parent BEFORE UPDATE OF result_state ON requests
             WHEN NEW.result_state = 'available' BEGIN SELECT RAISE(ABORT, 'test parent abort'); END;`
          : `CREATE TRIGGER test_abort_child BEFORE INSERT ON request_results
             BEGIN SELECT RAISE(ABORT, 'test child abort'); END;`,
      );
      raw.close(true);
      expect(await store.signalWait(target(fixture))).toEqual({
        ok: false,
        code: "storage_unavailable",
      });
      expect(privateSnapshot(store.databasePath, fixture.request.id)).toEqual(before);
      store.close();
    }
  });

  test("ack and expiry parent-update aborts restore the exact available child", async () => {
    for (const operation of ["ack", "expiry"] as const) {
      const clock = requestClock();
      const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
      const token = await store.acquire();
      const fixture = await requestFixture(token, operation === "ack" ? 1_901 : 1_902);
      await store.createPrepared(fixture);
      const reached = await store.signalWait({ ...target(fixture), evidence: "exact child" });
      if (!reached.ok || reached.request.resultState !== "available")
        throw new Error("fixture failed");
      const before = privateSnapshot(store.databasePath, fixture.request.id);
      const raw = new Database(store.databasePath, { strict: true });
      raw.exec(`CREATE TRIGGER test_abort_erasure BEFORE UPDATE OF result_state ON requests
        WHEN OLD.result_state = 'available' AND NEW.result_state <> 'available'
        BEGIN SELECT RAISE(ABORT, 'test erasure abort'); END;`);
      raw.close(true);
      if (operation === "ack") {
        expect(await store.acknowledgeResult(source(fixture))).toEqual({
          ok: false,
          code: "storage_unavailable",
        });
      } else {
        setWallAndExtendLease(clock, store.databasePath, reached.request.resultExpiresAtMs);
        expect(
          await store.expireAvailableResults({
            fencingToken: token,
            workspaceKey: requestTestWorkspace(),
            limit: 1,
          }),
        ).toEqual({ ok: false, code: "storage_unavailable" });
      }
      expect(privateSnapshot(store.databasePath, fixture.request.id)).toEqual(before);
      store.close();
    }
  });
});
