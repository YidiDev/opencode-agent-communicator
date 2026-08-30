import { expect, test } from "bun:test";

import type { AdvisoryLockPersistencePort } from "../../../src/application/advisory-lock-ports";
import {
  advisoryLockCleanupLimitPerPump,
  type RequestDeadlinePumpContext,
  runRequestDeadlinePump,
} from "../../../src/application/request-deadline-pump";
import type { RequestDeadlinePersistencePort } from "../../../src/application/request-ports";
import { validateNativeMessageId, validateRequestId } from "../../../src/domain/generated-ids";
import type { FencingToken } from "../../../src/domain/ownership";
import { OwnershipLostFault } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("deadline-pump");
if (!workspace.ok) throw new Error("invalid workspace fixture");
const workspaceKey = workspace.value;
const fencingToken = 1 as FencingToken;
const source = validateSessionId("ses_source");
const target = validateSessionId("ses_target");
if (!source.ok || !target.ok) throw new Error("invalid session fixture");
const sourceId = source.value;
const targetId = target.value;

function expired(seed: number): RequestMetadata {
  const hex = seed.toString(16).padStart(32, "0");
  const requestId = validateRequestId(`req_${hex}`);
  const nativeMessageId = validateNativeMessageId(`msg_${hex}`);
  if (!requestId.ok || !nativeMessageId.ok) throw new Error("invalid request fixture");
  return {
    id: requestId.value,
    workspaceKey,
    sourceSessionId: sourceId,
    targetSessionId: targetId,
    nativeMessageId: nativeMessageId.value,
    kind: "wait",
    resolutionState: "deadline_expired",
    deliveryState: "prepared",
    resultState: "none",
    payloadByteLength: 1,
    createdAtMs: 1,
    updatedAtMs: 10,
    deadlineAtMs: 5,
    resolvedAtMs: 10,
  };
}

function lockPort(
  overrides: Partial<AdvisoryLockPersistencePort> = {},
): AdvisoryLockPersistencePort {
  return {
    publish: async () => ({ ok: false, code: "storage_unavailable" }),
    list: async () => ({ locks: [] }),
    renew: async () => ({ ok: false, code: "storage_unavailable" }),
    release: async () => ({ ok: false, code: "storage_unavailable" }),
    cleanupExpired: async () => ({ deleted: 0 }),
    readNextExpiry: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
    ...overrides,
  };
}

function pumpFixture(input: {
  readonly locks?: AdvisoryLockPersistencePort;
  readonly requests?: RequestDeadlinePersistencePort;
  readonly readings?: readonly number[];
  readonly active?: () => boolean;
  readonly abort?: AbortSignal;
}) {
  const readings = [...(input.readings ?? [0, 0, 0])];
  const faults: string[] = [];
  const schedules: unknown[] = [];
  let dirty = true;
  const context: RequestDeadlinePumpContext = {
    options: {
      requests:
        input.requests ??
        ({
          expireDueRequests: async () => ({ ok: true, requests: [] }),
          readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
        } satisfies RequestDeadlinePersistencePort),
      ...(input.locks ? { locks: input.locks } : {}),
      notifications: { notifyTerminal: () => undefined },
      fencingToken,
      workspaceKey,
    },
    abort: input.abort ?? new AbortController().signal,
    isActive: input.active ?? (() => true),
    consumeDirty: () => {
      if (!dirty) return false;
      dirty = false;
      return true;
    },
    readMonotonicMs: () => readings.shift(),
    applySchedule: (schedule) => {
      schedules.push(schedule);
      return true;
    },
    fail: (code) => faults.push(code),
  };
  return { context, faults, schedules };
}

test("lock cleanup runs once before all full request batches and produces one combined schedule", async () => {
  const cleanupInputs: unknown[] = [];
  let expiryCalls = 0;
  const fixture = pumpFixture({
    readings: [10, 12, 15],
    requests: {
      expireDueRequests: async () => {
        expiryCalls += 1;
        return expiryCalls === 1
          ? { ok: true, requests: Array.from({ length: 100 }, (_, index) => expired(index + 1)) }
          : { ok: true, requests: [] };
      },
      readNextPendingDeadline: async () => ({
        storeObservedAtMs: 100,
        maximumSleepMs: 1_000,
        nextDeadlineAtMs: 150,
      }),
    } as RequestDeadlinePersistencePort,
    locks: lockPort({
      cleanupExpired: async (input) => {
        cleanupInputs.push(input);
        return { deleted: advisoryLockCleanupLimitPerPump };
      },
      readNextExpiry: async () => ({
        storeObservedAtMs: 100,
        maximumSleepMs: 500,
        nextExpiryAtMs: 120,
      }),
    }),
  });

  await runRequestDeadlinePump(fixture.context);

  expect(expiryCalls).toBe(2);
  expect(cleanupInputs).toEqual([
    { fencingToken, workspaceKey, limit: advisoryLockCleanupLimitPerPump },
  ]);
  expect(fixture.schedules).toEqual([
    {
      schedule: {
        storeObservedAtMs: 100,
        maximumSleepMs: 1_000,
        nextDeadlineAtMs: 150,
      },
      elapsedMs: 5,
      lockSchedule: {
        storeObservedAtMs: 100,
        maximumSleepMs: 500,
        nextExpiryAtMs: 120,
      },
      lockElapsedMs: 3,
    },
  ]);
  expect(fixture.faults).toEqual([]);
});

test("lock cleanup rejects malformed bounded results before request expiration", async () => {
  for (const returned of [
    undefined,
    {},
    { deleted: 0, extra: true },
    { deleted: -1 },
    { deleted: 0.5 },
    { deleted: advisoryLockCleanupLimitPerPump + 1 },
  ]) {
    let expiryCalls = 0;
    const fixture = pumpFixture({
      requests: {
        expireDueRequests: async () => {
          expiryCalls += 1;
          return { ok: true, requests: [] };
        },
        readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
      },
      locks: lockPort({ cleanupExpired: async () => returned as never }),
    });

    await runRequestDeadlinePump(fixture.context);

    expect(fixture.faults).toEqual(["port_contract_violation"]);
    expect(expiryCalls).toBe(0);
    expect(fixture.schedules).toEqual([]);
  }
});

test("lock cleanup classifies ownership and storage failures", async () => {
  for (const [cause, code] of [
    [new OwnershipLostFault("lost"), "ownership_lost"],
    [new Error("disk"), "storage_failure"],
  ] as const) {
    const fixture = pumpFixture({
      locks: lockPort({
        cleanupExpired: async () => {
          throw cause;
        },
      }),
    });

    await runRequestDeadlinePump(fixture.context);

    expect(fixture.faults).toEqual([code]);
    expect(fixture.schedules).toEqual([]);
  }
});

test("an already aborted pump stops during lock cleanup without reporting a fault", async () => {
  const controller = new AbortController();
  controller.abort("stopped");
  const fixture = pumpFixture({ abort: controller.signal, locks: lockPort() });

  await runRequestDeadlinePump(fixture.context);

  expect(fixture.faults).toEqual([]);
  expect(fixture.schedules).toEqual([]);
});

test("lock schedules enforce the strict expiry schedule contract", async () => {
  const malformed = [
    undefined,
    {},
    { storeObservedAtMs: 0 },
    { maximumSleepMs: 100 },
    { storeObservedAtMs: 0, maximumSleepMs: 100, unknown: 1 },
    { storeObservedAtMs: -1, maximumSleepMs: 100 },
    { storeObservedAtMs: 0.5, maximumSleepMs: 100 },
    { storeObservedAtMs: 0, maximumSleepMs: 0 },
    { storeObservedAtMs: 0, maximumSleepMs: 1.5 },
    { storeObservedAtMs: 0, maximumSleepMs: 100, nextExpiryAtMs: -1 },
    { storeObservedAtMs: 0, maximumSleepMs: 100, nextExpiryAtMs: 1.5 },
  ];
  for (const returned of malformed) {
    const fixture = pumpFixture({
      locks: lockPort({ readNextExpiry: async () => returned as never }),
    });

    await runRequestDeadlinePump(fixture.context);

    expect(fixture.faults).toEqual(["port_contract_violation"]);
    expect(fixture.schedules).toEqual([]);
  }
});

test("lock schedule reads classify failures and reject a regressing monotonic clock", async () => {
  for (const [readNextExpiry, readings, code] of [
    [async () => Promise.reject(new OwnershipLostFault("lost")), [0, 0], "ownership_lost"],
    [async () => Promise.reject(new Error("disk")), [0, 0], "storage_failure"],
    [
      async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
      [2, 2, 1],
      "port_contract_violation",
    ],
  ] as const) {
    const fixture = pumpFixture({
      readings,
      locks: lockPort({ readNextExpiry }),
    });

    await runRequestDeadlinePump(fixture.context);

    expect(fixture.faults).toEqual([code]);
    expect(fixture.schedules).toEqual([]);
  }
});

test("request schedule read failures are classified before the lock schedule is queried", async () => {
  for (const [cause, code] of [
    [new OwnershipLostFault("lost"), "ownership_lost"],
    [new Error("disk"), "storage_failure"],
  ] as const) {
    let lockReads = 0;
    const fixture = pumpFixture({
      requests: {
        expireDueRequests: async () => ({ ok: true, requests: [] }),
        readNextPendingDeadline: async () => {
          throw cause;
        },
      },
      locks: lockPort({
        readNextExpiry: async () => {
          lockReads += 1;
          return { storeObservedAtMs: 0, maximumSleepMs: 100 };
        },
      }),
    });

    await runRequestDeadlinePump(fixture.context);

    expect(fixture.faults).toEqual([code]);
    expect(lockReads).toBe(0);
  }
});

test("an unavailable clock reading after a lock schedule stops without applying it", async () => {
  const fixture = pumpFixture({ readings: [0, 0], locks: lockPort() });

  await runRequestDeadlinePump(fixture.context);

  expect(fixture.faults).toEqual([]);
  expect(fixture.schedules).toEqual([]);
});
