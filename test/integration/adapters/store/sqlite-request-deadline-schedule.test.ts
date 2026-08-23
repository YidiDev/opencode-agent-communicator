import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import { requestNextPendingDeadlineSql } from "../../../../src/adapters/store/request-query-repository";
import { type FencingToken, OwnershipLostFault } from "../../../../src/domain/ownership";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestClock,
  requestFixture,
  requestFixtureForPayload,
  requestTemporaryRoot,
  requestTestWorkspace,
  requestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

test("deadline schedule reads exact store time and minimum across pending delivery states", async () => {
  const clock = requestClock(25_000);
  const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
  try {
    const token = await store.acquire();
    const first = await requestFixture(token, 1_000);
    const submitting = await requestFixtureForPayload(
      token,
      { kind: "wait", milestone: "second", timeoutSeconds: 30 },
      { createdAtMs: 2_000, identitySeed: 61 },
    );
    const unknown = await requestFixtureForPayload(
      token,
      { kind: "wait", milestone: "third", timeoutSeconds: 30 },
      { createdAtMs: 3_000, identitySeed: 71 },
    );
    const admitted = await requestFixtureForPayload(
      token,
      { kind: "wait", milestone: "fourth", timeoutSeconds: 30 },
      { createdAtMs: 4_000, identitySeed: 72 },
    );
    const promoted = await requestFixtureForPayload(
      token,
      { kind: "wait", milestone: "fifth", timeoutSeconds: 30 },
      { createdAtMs: 5_000, identitySeed: 73 },
    );
    expect((await store.createPrepared(first)).ok).toBe(true);
    expect((await store.createPrepared(submitting)).ok).toBe(true);
    expect((await store.createPrepared(unknown)).ok).toBe(true);
    expect((await store.createPrepared(admitted)).ok).toBe(true);
    expect((await store.createPrepared(promoted)).ok).toBe(true);
    expect(
      (
        await store.claimPrepared({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          requestId: submitting.request.id,
        })
      ).ok,
    ).toBe(true);
    for (const [fixture, outcome] of [
      [admitted, "admitted"],
      [promoted, "promoted"],
    ] as const) {
      expect(
        (
          await store.claimPrepared({
            fencingToken: token,
            workspaceKey: requestTestWorkspace(),
            requestId: fixture.request.id,
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await store.completeDelivery({
            fencingToken: token,
            workspaceKey: requestTestWorkspace(),
            requestId: fixture.request.id,
            nativeMessageId: fixture.request.nativeMessageId,
            admittedSeq: 1,
            evidenceObservedAtMs: 25_000,
            ...(outcome === "admitted" ? { outcome } : { outcome, promotedSeq: 2 }),
          })
        ).ok,
      ).toBe(true);
    }
    const claimed = await store.claimPrepared({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      requestId: unknown.request.id,
    });
    expect(claimed.ok).toBe(true);
    expect(
      (
        await store.completeDelivery({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          requestId: unknown.request.id,
          outcome: "delivery_unknown",
        })
      ).ok,
    ).toBe(true);

    clock.set(25_123);
    expect(
      await store.readNextPendingDeadline({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
      }),
    ).toEqual({
      storeObservedAtMs: 25_123,
      maximumSleepMs: 5_000,
      nextDeadlineAtMs: first.request.deadlineAtMs,
    });
  } finally {
    store.close();
  }
});

test("terminal rows are excluded, ties are safe, and an empty schedule is exact", async () => {
  const store = openRequestStore();
  try {
    const token = await store.acquire();
    const terminal = await requestFixture(token, 1_000);
    const tiedA = await requestFixtureForPayload(
      token,
      { kind: "wait", milestone: "a", timeoutSeconds: 30 },
      { createdAtMs: 2_000, identitySeed: 91 },
    );
    const tiedB = await requestFixtureForPayload(
      token,
      { kind: "wait", milestone: "b", timeoutSeconds: 30 },
      { createdAtMs: 2_000, identitySeed: 101 },
    );
    for (const fixture of [terminal, tiedB, tiedA]) {
      expect((await store.createPrepared(fixture)).ok).toBe(true);
    }
    expect(
      (
        await store.cancelPending({
          fencingToken: token,
          workspaceKey: requestTestWorkspace(),
          requestId: terminal.request.id,
          callerSessionId: terminal.request.sourceSessionId,
        })
      ).ok,
    ).toBe(true);
    expect(
      await store.readNextPendingDeadline({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
      }),
    ).toEqual({
      storeObservedAtMs: 25_000,
      maximumSleepMs: 5_000,
      nextDeadlineAtMs: tiedA.request.deadlineAtMs,
    });

    for (const fixture of [tiedA, tiedB]) {
      await store.cancelPending({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
        requestId: fixture.request.id,
        callerSessionId: fixture.request.sourceSessionId,
      });
    }
    expect(
      await store.readNextPendingDeadline({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
      }),
    ).toEqual({ storeObservedAtMs: 25_000, maximumSleepMs: 5_000 });
  } finally {
    store.close();
  }
});

test("deadline schedule rejects stale fencing and foreign workspaces", async () => {
  const store = openRequestStore();
  try {
    const token = await store.acquire();
    await expect(
      store.readNextPendingDeadline({
        fencingToken: (token + 1) as FencingToken,
        workspaceKey: requestWorkspace("foreign"),
      }),
    ).rejects.toBeInstanceOf(OwnershipLostFault);
    await expect(
      store.readNextPendingDeadline({
        fencingToken: token,
        workspaceKey: requestWorkspace("foreign"),
      }),
    ).rejects.toThrow();
  } finally {
    store.close();
  }
});

test("deadline schedule is blocked until stale startup submissions are classified", async () => {
  const stateDirectory = `${requestTemporaryRoot("deadline-startup-")}/state`;
  const first = openRequestStore({ stateDirectory, ownerId: "deadline-old" });
  const staleToken = await first.acquire();
  const stale = await requestFixture(staleToken, 1_000);
  expect((await first.createPrepared(stale)).ok).toBe(true);
  expect(
    (
      await first.claimPrepared({
        fencingToken: staleToken,
        workspaceKey: requestTestWorkspace(),
        requestId: stale.request.id,
      })
    ).ok,
  ).toBe(true);
  first.close();

  const recovering = openRequestStore({ stateDirectory, ownerId: "deadline-new" });
  try {
    const token = await recovering.acquire();
    await expect(
      recovering.readNextPendingDeadline({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
      }),
    ).rejects.toThrow();
  } finally {
    recovering.close();
  }
});

test("deadline schedule derives its exact positive sleep ceiling from the lease", async () => {
  const store = openRequestStore({ leaseDurationMs: 1_200 });
  try {
    const token = await store.acquire();
    expect(
      await store.readNextPendingDeadline({
        fencingToken: token,
        workspaceKey: requestTestWorkspace(),
      }),
    ).toEqual({ storeObservedAtMs: 25_000, maximumSleepMs: 400 });
  } finally {
    store.close();
  }
});

test("deadline minimum query plan is pinned to requests_deadline without temp sorting", async () => {
  const store = openRequestStore();
  try {
    await store.acquire();
    const database = new Database(store.databasePath, { readonly: true });
    try {
      const plan = database
        .query<{ readonly detail: string }, [string]>(
          `EXPLAIN QUERY PLAN ${requestNextPendingDeadlineSql}`,
        )
        .all(requestTestWorkspace())
        .map((row) => row.detail)
        .join("\n");
      expect(plan).toMatch(/USING (?:COVERING )?INDEX requests_deadline/);
      expect(plan).not.toMatch(/SCAN requests|TEMP B-TREE/i);
    } finally {
      database.close();
    }
  } finally {
    store.close();
  }
});
