import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { CompleteRequestDeliveryInput } from "../../../../src/application/request-ports";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestClock,
  requestFixture,
  requestTestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

type Fixture = Awaited<ReturnType<typeof requestFixture>>;
type LateOutcome = CompleteRequestDeliveryInput["outcome"];

function participant(fixture: Fixture, role: "source" | "target") {
  return {
    fencingToken: fixture.fencingToken,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
    callerSessionId:
      role === "source" ? fixture.request.sourceSessionId : fixture.request.targetSessionId,
  };
}

function completion(fixture: Fixture, outcome: LateOutcome): CompleteRequestDeliveryInput {
  const base = {
    fencingToken: fixture.fencingToken,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
  };
  switch (outcome) {
    case "delivery_unknown":
    case "delivery_failed":
      return { ...base, outcome };
    case "admitted":
      return {
        ...base,
        outcome,
        nativeMessageId: fixture.request.nativeMessageId,
        admittedSeq: 10,
        evidenceObservedAtMs: 25_000,
      };
    case "promoted":
      return {
        ...base,
        outcome,
        nativeMessageId: fixture.request.nativeMessageId,
        admittedSeq: 10,
        promotedSeq: 11,
        evidenceObservedAtMs: 25_000,
      };
  }
}

function deliverySnapshot(databasePath: string, requestId: string) {
  const database = new Database(databasePath, { readonly: true, strict: true });
  const row = database
    .query<
      {
        deliveryState: string;
        updatedAtMs: number;
        unknownAtMs: number | null;
        admittedAtMs: number | null;
        promotedAtMs: number | null;
        failedAtMs: number | null;
      },
      [string]
    >(
      `SELECT delivery_state AS deliveryState, updated_at_ms AS updatedAtMs,
         delivery_unknown_at_ms AS unknownAtMs, admitted_at_ms AS admittedAtMs,
         promoted_at_ms AS promotedAtMs, delivery_failed_at_ms AS failedAtMs
       FROM requests WHERE id = ?`,
    )
    .get(requestId);
  database.close(true);
  if (!row) throw new Error("request snapshot was absent");
  return row;
}

function corruptAvailableResult(
  databasePath: string,
  requestId: string,
  variant: "missing" | "noncanonical" | "wrong-kind" | "digest",
): void {
  const database = new Database(databasePath, { strict: true });
  if (variant === "missing") {
    database.run("DELETE FROM request_results WHERE request_id = ?", [requestId]);
  } else if (variant === "digest") {
    database.run("UPDATE requests SET result_sha256 = ? WHERE id = ?", ["f".repeat(64), requestId]);
  } else {
    database.run("UPDATE request_results SET result_json = ? WHERE request_id = ?", [
      variant === "wrong-kind" ? '{"kind":"ask","answers":[[]]}' : '{ "kind": "wait" }',
      requestId,
    ]);
  }
  database.close(true);
}

describe("late delivery terminal result integrity", () => {
  test("all legal submitting and unknown late outcomes reject malformed available children without mutation", async () => {
    const transitions = [
      ["submitting", "delivery_unknown"],
      ["submitting", "admitted"],
      ["submitting", "promoted"],
      ["submitting", "delivery_failed"],
      ["delivery_unknown", "admitted"],
      ["delivery_unknown", "promoted"],
      ["delivery_unknown", "delivery_failed"],
    ] as const;
    for (const variant of ["missing", "noncanonical", "wrong-kind", "digest"] as const) {
      for (const [from, outcome] of transitions) {
        const store = openRequestStore();
        const token = await store.acquire();
        const fixture = await requestFixture(token, 3_000 + variant.length + outcome.length);
        await store.createPrepared(fixture);
        await store.claimPrepared({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          requestId: fixture.request.id,
        });
        await store.signalWait(participant(fixture, "target"));
        if (from === "delivery_unknown") {
          await store.completeDelivery(completion(fixture, "delivery_unknown"));
        }
        corruptAvailableResult(store.databasePath, fixture.request.id, variant);
        const before = deliverySnapshot(store.databasePath, fixture.request.id);
        expect(await store.completeDelivery(completion(fixture, outcome))).toEqual({
          ok: false,
          code: "state_conflict",
        });
        expect(deliverySnapshot(store.databasePath, fixture.request.id)).toEqual(before);
        store.close();
      }
    }
  });

  test("post-transition validation rolls back a child deleted by the delivery update itself", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token, 3_400);
    await store.createPrepared(fixture);
    await store.claimPrepared({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      requestId: fixture.request.id,
    });
    await store.signalWait(participant(fixture, "target"));
    const corruption = new Database(store.databasePath, { strict: true });
    corruption.exec(`CREATE TRIGGER corrupt_result_after_late_delivery
      AFTER UPDATE OF delivery_state ON requests
      BEGIN DELETE FROM request_results WHERE request_id = NEW.id; END;`);
    corruption.close(true);
    const before = deliverySnapshot(store.databasePath, fixture.request.id);
    expect(await store.completeDelivery(completion(fixture, "delivery_unknown"))).toEqual({
      ok: false,
      code: "state_conflict",
    });
    expect(deliverySnapshot(store.databasePath, fixture.request.id)).toEqual(before);
    expect(() => resultRowForIntegrity(store.databasePath, fixture.request.id)).not.toThrow();
    store.close();
  });

  test("unsuccessful, expired, and acknowledged terminal states reject an unexpected child without mutation", async () => {
    for (const state of ["cancelled", "expired", "acknowledged"] as const) {
      const clock = requestClock();
      const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: () => 25_000 });
      const token = await store.acquire();
      const fixture = await requestFixture(token, 3_500 + state.length);
      await store.createPrepared(fixture);
      await store.claimPrepared({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        requestId: fixture.request.id,
      });
      if (state === "cancelled") {
        expect(await store.cancelPending(participant(fixture, "source"))).toMatchObject({
          ok: true,
          request: { resolutionState: "cancelled", resultState: "none" },
        });
      } else {
        const reached = await store.signalWait(participant(fixture, "target"));
        if (!reached.ok || reached.request.resultState !== "available") {
          throw new Error("available result fixture failed");
        }
        if (state === "acknowledged") {
          expect(await store.acknowledgeResult(participant(fixture, "source"))).toMatchObject({
            ok: true,
            request: { resultState: "acknowledged" },
          });
        } else {
          clock.set(reached.request.resultExpiresAtMs);
          const lease = new Database(store.databasePath, { strict: true });
          lease.run(
            "UPDATE ownership SET renewed_wall_ms = ?, expires_wall_ms = ? WHERE singleton = 1",
            [clock.wall(), clock.wall() + 300_000],
          );
          lease.close(true);
          expect(
            await store.expireAvailableResults({
              fencingToken: token,
              workspaceKey: requestTestWorkspace(),
              limit: 1,
            }),
          ).toMatchObject({ ok: true, requests: [{ resultState: "expired" }] });
        }
      }
      const erased = new Database(store.databasePath, { readonly: true, strict: true });
      expect(
        erased
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM request_results WHERE request_id = ?",
          )
          .get(fixture.request.id)?.count,
      ).toBe(0);
      erased.close(true);
      const corruption = new Database(store.databasePath, { strict: true });
      corruption.exec("DROP TRIGGER request_results_available_insert");
      corruption.run("INSERT INTO request_results(request_id, result_json) VALUES (?, ?)", [
        fixture.request.id,
        '{"kind":"wait"}',
      ]);
      corruption.close(true);
      const before = deliverySnapshot(store.databasePath, fixture.request.id);
      expect(await store.completeDelivery(completion(fixture, "delivery_unknown"))).toEqual({
        ok: false,
        code: "state_conflict",
      });
      expect(deliverySnapshot(store.databasePath, fixture.request.id)).toEqual(before);
      store.close();
    }
  });
});

function resultRowForIntegrity(databasePath: string, requestId: string): void {
  const database = new Database(databasePath, { readonly: true, strict: true });
  const count = database
    .query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM request_results WHERE request_id = ?",
    )
    .get(requestId)?.count;
  database.close(true);
  if (count !== 1) throw new Error("result child rollback failed");
}
