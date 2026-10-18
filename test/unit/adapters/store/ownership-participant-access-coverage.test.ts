import { describe, expect, test } from "bun:test";

import { OwnershipRepository } from "../../../../src/adapters/store/ownership-repository";
import { ParticipantRegistryRepository } from "../../../../src/adapters/store/participant-registry-repository";
import { SqliteStoreOperationAccess } from "../../../../src/adapters/store/sqlite-store-operation-access";
import { storeNowMs } from "../../../../src/adapters/store/store-clock";
import {
  OwnershipUnavailableError,
  type StoreContext,
  StoreIntegrityError,
  StoreSecurityError,
} from "../../../../src/adapters/store/store-types";
import type { ParticipantObservation } from "../../../../src/application/participant-registry-ports";
import { OwnershipLostFault } from "../../../../src/domain/ownership";
import { participantRegistryPolicy, validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:coverage"));
const participantSessionId = valid(validateSessionId("ses_coverage"));
const token = 1 as never;

function participantRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: participantSessionId,
    rootKind: "root",
    parentSessionId: null,
    title: null,
    archivedState: "unknown",
    activityStatus: "unknown",
    activityObservedAtMs: null,
    visibility: "unknown",
    visibilityObservedAtMs: null,
    firstObservedAtMs: 1,
    lastObservedAtMs: 2,
    ...overrides,
  };
}

function participantRepository(
  options: {
    row?: unknown;
    transactionFailure?: unknown;
    ownershipFailure?: unknown;
    runFailure?: unknown;
  } = {},
) {
  const runs: unknown[][] = [];
  const context = {
    workspaceKey,
    maximumPageCount: 100,
    database: {
      query: (sql: string) => ({
        get: () => (sql.includes("page_count") ? { pageCount: 0 } : options.row),
        all: () => (options.row === undefined ? [] : [options.row]),
      }),
      run: (_sql: string, values: unknown[]) => {
        if (options.runFailure !== undefined) throw options.runFailure;
        runs.push(values);
        return { changes: 1 };
      },
      transaction: (operation: () => unknown) => ({
        immediate: () => {
          if (options.transactionFailure !== undefined) throw options.transactionFailure;
          return operation();
        },
      }),
    },
  } as never;
  const ownership = {
    assertOrdinaryWorkAllowed: () => {
      if (options.ownershipFailure !== undefined) throw options.ownershipFailure;
    },
  } as never;
  return { repository: new ParticipantRegistryRepository(context, ownership), runs };
}

function observation(overrides: Record<string, unknown> = {}): ParticipantObservation {
  return {
    sessionId: participantSessionId,
    rootKind: "root",
    parentSessionId: null,
    ...overrides,
  } as never;
}

describe("participant registry repository edge coverage", () => {
  test("rejects every malformed observation shape before accessing storage", () => {
    const repository = participantRepository().repository;
    const invalidInputs = [
      { workspaceKey: "other" },
      { observedAtMs: -1 },
      { observedAtMs: Number.NaN },
      { observations: [observation(), observation()] },
      { observations: [observation({ sessionId: "bad id" })] },
      { observations: [observation({ parentSessionId: "bad id" })] },
      { observations: [observation({ parentSessionId: "ses_parent" })] },
      {
        observations: [
          observation({ rootKind: "child", parentSessionId: null, sessionId: "ses_child" }),
        ],
      },
      {
        observations: [
          observation({
            rootKind: "child",
            sessionId: "ses_child",
            parentSessionId: "ses_child",
          }),
        ],
      },
      { observations: [observation({ title: "bad\u001b[31m" })] },
      {
        observations: [
          observation({ title: "x".repeat(participantRegistryPolicy.maximumTitleUtf8Bytes + 1) }),
        ],
      },
      { observations: [observation({ activityStatus: "sleeping" })] },
      { observations: [observation({ visibility: "hidden" })] },
      {
        observations: new Array(participantRegistryPolicy.maximumObservationBatch + 1)
          .fill(undefined)
          .map((_, index) => observation({ sessionId: `ses_${index}` })),
      },
    ];
    for (const invalid of invalidInputs) {
      expect(
        repository.record({
          fencingToken: token,
          workspaceKey,
          observedAtMs: 1,
          observations: [observation()] as never,
          ...invalid,
        } as never),
      ).toEqual({ ok: false, code: "state_conflict" });
    }
  });

  test("classifies fencing, quota, and ordinary storage failures", () => {
    expect(
      participantRepository({ ownershipFailure: new OwnershipLostFault("lost") }).repository.record(
        {
          fencingToken: token,
          workspaceKey,
          observedAtMs: 1,
          observations: [],
        },
      ),
    ).toEqual({ ok: false, code: "ownership_lost" });
    expect(
      participantRepository({
        transactionFailure: new Error("participant registry ceiling exceeded"),
      }).repository.record({
        fencingToken: token,
        workspaceKey,
        observedAtMs: 1,
        observations: [],
      }),
    ).toEqual({ ok: false, code: "quota_exceeded" });
    expect(
      participantRepository({
        transactionFailure: new Error("disk unavailable"),
      }).repository.record({
        fencingToken: token,
        workspaceKey,
        observedAtMs: 1,
        observations: [],
      }),
    ).toEqual({ ok: false, code: "storage_unavailable" });
  });

  test("hydrates valid states and rejects malformed stored rows", () => {
    const archived = participantRepository({
      row: participantRow({
        archivedState: "archived",
        activityStatus: "busy",
        visibility: "visible",
      }),
    }).repository.listRoots({ fencingToken: token, workspaceKey, limit: 1 });
    expect(archived[0]).toMatchObject({ isArchived: true, activityStatus: "busy" });

    const malformed = [
      { sessionId: "bad id" },
      { parentSessionId: "bad id" },
      { rootKind: "branch" },
      { archivedState: "deleted" },
      { activityStatus: "sleeping" },
      { visibility: "hidden" },
      { firstObservedAtMs: -1 },
      { lastObservedAtMs: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const override of malformed) {
      const repository = participantRepository({ row: participantRow(override) }).repository;
      expect(() => repository.listRoots({ fencingToken: token, workspaceKey, limit: 1 })).toThrow(
        "Stored participant registry metadata is malformed",
      );
    }
  });

  test("validates bounded reads, identities, and absent roots", () => {
    const repository = participantRepository().repository;
    for (const input of [
      { workspaceKey: "other", limit: 1 },
      { workspaceKey, limit: 0 },
      { workspaceKey, limit: 1.5 },
      { workspaceKey, limit: participantRegistryPolicy.maximumListLimit + 1 },
    ]) {
      expect(() => repository.listRoots({ fencingToken: token, ...input } as never)).toThrow(
        "outside its bounded contract",
      );
    }
    expect(() =>
      repository.getRoot({ fencingToken: token, workspaceKey, sessionId: "bad id" as never }),
    ).toThrow("query identity is malformed");
    expect(
      repository.getRoot({ fencingToken: token, workspaceKey, sessionId: "ses_absent" as never }),
    ).toBeUndefined();
  });

  test("preserves prior optional fields and derives explicit observation timestamps", () => {
    const fixture = participantRepository({
      row: participantRow({
        title: "Prior",
        archivedState: "active",
        activityStatus: "idle",
        activityObservedAtMs: 3,
        visibility: "not_visible",
        visibilityObservedAtMs: 4,
      }),
    });
    expect(
      fixture.repository.record({
        fencingToken: token,
        workspaceKey,
        observedAtMs: 10,
        observations: [
          observation({ isArchived: true, activityStatus: "unknown", visibility: "visible" }),
        ],
      }),
    ).toEqual({ ok: true, recorded: 1 });
    expect(fixture.runs.at(-1)).toEqual([
      workspaceKey,
      "ses_coverage",
      "root",
      null,
      "Prior",
      "archived",
      "unknown",
      null,
      "visible",
      10,
      1,
      10,
    ]);
  });
});

function ownershipRow(overrides: Record<string, unknown> = {}) {
  return {
    ownerGenerationId: "owner-generation",
    fencingToken: 1,
    acquiredWallMs: 100,
    renewedWallMs: 100,
    expiresWallMs: 1_100,
    releasedWallMs: null,
    ...overrides,
  };
}

function ownershipHarness(
  options: {
    row?: unknown;
    stale?: unknown;
    wall?: number;
    monotonic?: number;
    changes?: number;
  } = {},
) {
  const state = {
    row: options.row,
    wall: options.wall ?? 200,
    monotonic: options.monotonic ?? 200,
    changes: options.changes ?? 1,
  };
  const context = {
    workspaceKey,
    ownerGenerationId: "owner-generation",
    ownerLabel: "owner",
    leaseDurationMs: 1_000,
    takeoverGraceMs: 100,
    nowWallMs: () => state.wall,
    nowMonotonicMs: () => state.monotonic,
    localToken: undefined as StoreContext["localToken"],
    localExpiresMonotonicMs: 0,
    nextRenewMonotonicMs: 0,
    startupBlockedToken: undefined as StoreContext["startupBlockedToken"],
    database: {
      query: (sql: string) => ({
        get: () => (sql.includes("SELECT (") ? (options.stale ?? { count: 0 }) : state.row),
      }),
      run: () => ({ changes: state.changes }),
      transaction: (operation: () => unknown) => ({ immediate: operation }),
    },
  };
  return {
    repository: new OwnershipRepository(context as unknown as StoreContext),
    context,
    state,
  };
}

describe("ownership repository edge coverage", () => {
  test("rejects malformed wall and monotonic clocks and lease overflow", () => {
    for (const wall of [-1, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      const fixture = ownershipHarness({ wall });
      expect(() => fixture.repository.acquire()).toThrow(StoreIntegrityError);
    }
    for (const monotonic of [-1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      const fixture = ownershipHarness({ monotonic });
      expect(() => fixture.repository.acquire()).toThrow("monotonic clock");
    }
  });

  test("rejects each malformed ownership-row invariant", () => {
    const malformed = [
      { ownerGenerationId: 1 },
      { fencingToken: 0 },
      { acquiredWallMs: -1 },
      { renewedWallMs: 99 },
      { expiresWallMs: 100 },
      { releasedWallMs: 99 },
      { releasedWallMs: 1_101 },
    ];
    for (const override of malformed) {
      expect(() =>
        ownershipHarness({ row: ownershipRow(override) }).repository.takeoverDelayMs(),
      ).toThrow("Stored ownership metadata is malformed");
    }
  });

  test("fails closed for unavailable, exhausted, overflowing, and raced takeovers", () => {
    expect(() => ownershipHarness({ row: ownershipRow() }).repository.acquire()).toThrow(
      OwnershipUnavailableError,
    );
    expect(() =>
      ownershipHarness({
        row: ownershipRow({ fencingToken: Number.MAX_SAFE_INTEGER, releasedWallMs: 100 }),
      }).repository.acquire(),
    ).toThrow("fencing epoch is exhausted");
    expect(() =>
      ownershipHarness({
        row: ownershipRow({ expiresWallMs: Number.MAX_SAFE_INTEGER, releasedWallMs: 100 }),
      }).repository.acquire(),
    ).toThrow("lease timing exceeds its safe range");
    expect(() =>
      ownershipHarness({
        row: ownershipRow({ releasedWallMs: 100 }),
        changes: 0,
      }).repository.acquire(),
    ).toThrow("Ownership changed");
  });

  test("covers local-current, renewal-CAS, implicit-current, and startup blocking paths", () => {
    const fixture = ownershipHarness({ row: ownershipRow(), monotonic: 200 });
    fixture.context.localToken = token;
    fixture.context.localExpiresMonotonicMs = 2_000;
    fixture.context.nextRenewMonotonicMs = 100;
    expect(fixture.repository.isCurrent(token)).toBeTrue();
    fixture.state.changes = 0;
    fixture.state.monotonic = 600;
    expect(fixture.repository.isCurrent(token)).toBeFalse();
    expect(() => fixture.repository.assertCurrent(token)).toThrow(OwnershipLostFault);
    fixture.context.localToken = undefined;
    expect(() => fixture.repository.assertImplicitCurrent()).toThrow(OwnershipLostFault);

    fixture.context.localToken = token;
    fixture.context.localExpiresMonotonicMs = 2_000;
    fixture.context.nextRenewMonotonicMs = 1_000;
    fixture.state.changes = 1;
    fixture.context.startupBlockedToken = token;
    expect(() => fixture.repository.assertOrdinaryWorkAllowed(token)).toThrow("Startup recovery");
    fixture.repository.applyCommittedStaleClassificationProgress(token, false);
    expect(fixture.context.startupBlockedToken).toBe(token);
    fixture.repository.applyCommittedStaleClassificationProgress(token, true);
    expect(fixture.context.startupBlockedToken).toBeUndefined();
  });

  test("validates startup aggregates, controls, and barrier provenance", () => {
    for (const stale of [{}, { count: -1 }, { count: 1.5 }]) {
      const fixture = ownershipHarness({ stale });
      expect(() => fixture.repository.staleClassificationComplete(token)).toThrow(
        "startup recovery aggregate was malformed",
      );
    }
    const fixture = ownershipHarness({ row: ownershipRow() });
    fixture.context.localToken = token;
    fixture.context.localExpiresMonotonicMs = 2_000;
    fixture.context.nextRenewMonotonicMs = 500;
    expect(() =>
      fixture.repository.establish(token, { abort: { aborted: true } } as never),
    ).toThrow("cancelled before");
    expect(() =>
      fixture.repository.establish(token, { abort: { aborted: false }, deadlineMs: 200 } as never),
    ).toThrow("cancelled before");
    const barrier = fixture.repository.establish(token, { abort: { aborted: false } } as never);
    expect(() => fixture.repository.assertBarrier({ ...barrier }, token)).toThrow("valid startup");
    expect(() => fixture.repository.assertBarrier(barrier, 2 as never)).toThrow("valid startup");
    expect(() => fixture.repository.assertBarrier(barrier, token)).not.toThrow();
  });

  test("handles no-lease relinquish and takeover delay overflow", () => {
    expect(() => ownershipHarness().repository.relinquish()).not.toThrow();
    const overflow = ownershipHarness({
      row: ownershipRow({ expiresWallMs: Number.MAX_SAFE_INTEGER, renewedWallMs: 100 }),
    });
    expect(() => overflow.repository.takeoverDelayMs()).toThrow("takeover timing is invalid");
  });

  test("checks and relinquishes a current lease without renewing it", () => {
    const fixture = ownershipHarness({ row: ownershipRow() });
    expect(fixture.repository.hasCurrentLease()).toBeFalse();
    fixture.context.localToken = token;
    fixture.context.localExpiresMonotonicMs = 100;
    expect(fixture.repository.hasCurrentLease()).toBeFalse();
    fixture.context.localExpiresMonotonicMs = 2_000;
    expect(fixture.repository.hasCurrentLease()).toBeTrue();
    fixture.repository.relinquish();
    expect(fixture.context.localToken).toBeUndefined();
    expect(fixture.context.startupBlockedToken).toBeUndefined();
  });
});

describe("store clock and operation access edge coverage", () => {
  test("validates the wall clock", () => {
    expect(storeNowMs({ nowWallMs: () => 12 } as never)).toBe(12);
    for (const value of [-1, 1.5, Number.NaN]) {
      expect(() => storeNowMs({ nowWallMs: () => value } as never)).toThrow("clock was malformed");
    }
  });

  test("routes normal access and verifies stale inspections", () => {
    let verified = 0;
    const access = new SqliteStoreOperationAccess(
      {} as never,
      { verifySqliteFiles: () => verified++ } as never,
      1,
      (operation) => operation(),
      (cause) => cause,
    );
    expect(access.mutate(() => "mutated")).toBe("mutated");
    expect(access.inspect(() => "inspected")).toBe("inspected");
    expect(access.inspectStaleOwnership(() => "stale")).toBe("stale");
    expect(verified).toBe(1);
    expect(() =>
      access.inspectStaleOwnership(() => {
        throw new Error("secret");
      }),
    ).toThrow("SQLite storage inspection failed");
    expect(() =>
      access.inspectStaleOwnership(() => {
        throw new StoreSecurityError("preserved");
      }),
    ).toThrow("preserved");
  });

  test("closes without a lease and sanitizes lifecycle failure after private close", () => {
    const events: string[] = [];
    const access = new SqliteStoreOperationAccess(
      {} as never,
      { close: () => events.push("private-close") } as never,
      1,
      (operation) => operation(),
      (cause) => cause,
    );
    expect(() =>
      access.close(
        { hasCurrentLease: () => false } as never,
        {
          close: () => {
            events.push("database-close");
            throw new Error("raw close failure");
          },
        } as never,
      ),
    ).toThrow("could not be closed safely");
    expect(events).toEqual(["database-close", "private-close"]);
  });

  test("retains checkpoint and relinquish failures while always closing resources", () => {
    const retained: unknown[] = [];
    const events: string[] = [];
    const access = new SqliteStoreOperationAccess(
      {
        database: { query: () => ({ get: () => ({ busy: 1, log: 0, checkpointed: 0 }) }) },
      } as never,
      {
        assertMutationCapacity: (_maximum: number, operation: () => unknown) => operation(),
        close: () => events.push("private-close"),
      } as never,
      1,
      (operation) => operation(),
      (cause, pending) => {
        retained.push(cause);
        return pending ?? cause;
      },
    );
    expect(() =>
      access.close(
        {
          hasCurrentLease: () => true,
          relinquish: () => {
            throw new Error("release failure");
          },
        } as never,
        { close: () => events.push("database-close") } as never,
      ),
    ).toThrow("SQLite WAL checkpointing is blocked");
    expect(retained).toHaveLength(2);
    expect(events).toEqual(["database-close", "private-close"]);
  });

  test("still closes when checking lease ownership fails", () => {
    let closed = 0;
    const access = new SqliteStoreOperationAccess(
      {} as never,
      { close: () => closed++ } as never,
      1,
      (operation) => operation(),
      (cause) => cause,
    );
    expect(() =>
      access.close(
        {
          hasCurrentLease: () => {
            throw new OwnershipLostFault("lease lookup failed");
          },
        } as never,
        { close: () => closed++ } as never,
      ),
    ).toThrow("lease lookup failed");
    expect(closed).toBe(2);
  });
});
