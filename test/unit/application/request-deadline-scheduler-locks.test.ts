import { expect, test } from "bun:test";

import type { AdvisoryLockPersistencePort } from "../../../src/application/advisory-lock-ports";
import {
  advisoryLockCleanupLimitPerPump,
  RequestDeadlineScheduler,
  type RequestDeadlineTimerPort,
} from "../../../src/application/request-deadline-scheduler";
import { validateNativeMessageId, validateRequestId } from "../../../src/domain/generated-ids";
import type { FencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function fixtureValue<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("bad fixture");
  return result.value;
}

const workspaceKey = fixtureValue(validateWorkspaceKey("scheduler-locks"));
const sourceId = fixtureValue(validateSessionId("ses_source"));
const targetId = fixtureValue(validateSessionId("ses_target"));
const token = 1 as FencingToken;

function expired(seed: number): RequestMetadata {
  const hex = seed.toString(16).padStart(32, "0");
  return {
    id: fixtureValue(validateRequestId(`req_${hex}`)),
    workspaceKey,
    sourceSessionId: sourceId,
    targetSessionId: targetId,
    nativeMessageId: fixtureValue(validateNativeMessageId(`msg_${hex}`)),
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

class FakeTimers implements RequestDeadlineTimerPort {
  readonly pending = new Map<number, () => void>();
  readonly delays: number[] = [];
  private next = 1;

  set(delayMs: number, callback: () => void): unknown {
    const id = this.next++;
    this.delays.push(delayMs);
    this.pending.set(id, callback);
    return id;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  fire(): void {
    const item = this.pending.entries().next().value as [number, () => void] | undefined;
    if (!item) throw new Error("no timer");
    this.pending.delete(item[0]);
    item[1]();
  }
}

function schedulerLocks(
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

function schedulerOptions(timers: RequestDeadlineTimerPort, locks: AdvisoryLockPersistencePort) {
  return {
    requests: {
      expireDueRequests: async () => ({ ok: true as const, requests: [] }),
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
    },
    locks,
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers,
    nowMonotonicMs: () => 0,
  };
}

test("lease rechecks run bounded request maintenance recurrently", async () => {
  const timers = new FakeTimers();
  let resultMaintenance = 0;
  let retentionMaintenance = 0;
  const scheduler = new RequestDeadlineScheduler({
    ...schedulerOptions(timers, schedulerLocks()),
    maintenance: {
      resultRetention: {
        async expireAvailableResults() {
          resultMaintenance += 1;
          return { ok: true, requests: [] };
        },
      },
      requestRetention: {
        async collectRequestRetention() {
          retentionMaintenance += 1;
          return { ok: true, deletedRequests: 0, deletedRateEvents: 0 };
        },
      },
    },
  });
  expect(await scheduler.startAndWaitReady()).toEqual({ ok: true });
  timers.fire();
  await scheduler.drain();
  expect({ resultMaintenance, retentionMaintenance }).toEqual({
    resultMaintenance: 2,
    retentionMaintenance: 2,
  });
  scheduler.stop();
});

test("request and lock schedules share one timer armed at the earliest store-authoritative delay", async () => {
  for (const [requestSchedule, lockSchedule, readings, expectedDelay] of [
    [
      { storeObservedAtMs: 100, maximumSleepMs: 1_000, nextDeadlineAtMs: 130 },
      { storeObservedAtMs: 100, maximumSleepMs: 1_000, nextExpiryAtMs: 120 },
      [0, 0, 0],
      20,
    ],
    [
      { storeObservedAtMs: 100, maximumSleepMs: 1_000, nextDeadlineAtMs: 110 },
      { storeObservedAtMs: 100, maximumSleepMs: 1_000, nextExpiryAtMs: 120 },
      [0, 0, 0],
      10,
    ],
    [
      { storeObservedAtMs: 100, maximumSleepMs: 100 },
      { storeObservedAtMs: 100, maximumSleepMs: 40 },
      [0, 0, 0],
      40,
    ],
    [
      { storeObservedAtMs: 100, maximumSleepMs: 1_000, nextDeadlineAtMs: 150 },
      { storeObservedAtMs: 100, maximumSleepMs: 1_000, nextExpiryAtMs: 120 },
      [10, 12, 15],
      17,
    ],
  ] as const) {
    const timers = new FakeTimers();
    const clock = [...readings];
    const scheduler = new RequestDeadlineScheduler({
      ...schedulerOptions(timers, schedulerLocks({ readNextExpiry: async () => lockSchedule })),
      requests: {
        expireDueRequests: async () => ({ ok: true, requests: [] }),
        readNextPendingDeadline: async () => requestSchedule,
      },
      nowMonotonicMs: () => clock.shift() as number,
    });
    expect(await scheduler.startAndWaitReady()).toEqual({ ok: true });
    expect(timers.delays).toEqual([expectedDelay]);
    scheduler.stop();
  }
});

test("one lock cleanup precedes a complete sequence of full request batches", async () => {
  let cleanupCalls = 0;
  let expiryCalls = 0;
  const timers = new FakeTimers();
  const scheduler = new RequestDeadlineScheduler({
    ...schedulerOptions(
      timers,
      schedulerLocks({
        cleanupExpired: async (input) => {
          cleanupCalls += 1;
          expect(input.limit).toBe(advisoryLockCleanupLimitPerPump);
          return { deleted: 0 };
        },
      }),
    ),
    requests: {
      expireDueRequests: async () => {
        expiryCalls += 1;
        return {
          ok: true,
          requests:
            expiryCalls === 1 ? Array.from({ length: 100 }, (_, index) => expired(index + 1)) : [],
        };
      },
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
    },
  });
  expect(await scheduler.startAndWaitReady()).toEqual({ ok: true });
  expect({ cleanupCalls, expiryCalls }).toEqual({ cleanupCalls: 1, expiryCalls: 2 });
  scheduler.stop();
});

test("wake during lock cleanup causes a second serialized cleanup without a stale timer", async () => {
  let release: (() => void) | undefined;
  let cleanupCalls = 0;
  const timers = new FakeTimers();
  const scheduler = new RequestDeadlineScheduler({
    ...schedulerOptions(
      timers,
      schedulerLocks({
        cleanupExpired: async () => {
          cleanupCalls += 1;
          if (cleanupCalls === 1) await new Promise<void>((resolve) => (release = resolve));
          return { deleted: 0 };
        },
      }),
    ),
  });
  scheduler.start();
  while (!release) await Promise.resolve();
  scheduler.wake();
  release();
  await scheduler.drain();
  expect(cleanupCalls).toBe(2);
  expect(timers.delays).toEqual([100]);
  expect(timers.pending.size).toBe(1);
  scheduler.stop();
});

test("wake during a lock schedule read discards the stale schedule", async () => {
  let release:
    | ((value: {
        storeObservedAtMs: number;
        maximumSleepMs: number;
        nextExpiryAtMs: number;
      }) => void)
    | undefined;
  let requestReads = 0;
  let lockReads = 0;
  const timers = new FakeTimers();
  const scheduler = new RequestDeadlineScheduler({
    ...schedulerOptions(
      timers,
      schedulerLocks({
        readNextExpiry: async () => {
          lockReads += 1;
          if (lockReads === 1) return new Promise((resolve) => (release = resolve));
          return { storeObservedAtMs: 0, maximumSleepMs: 100, nextExpiryAtMs: 5 };
        },
      }),
    ),
    requests: {
      expireDueRequests: async () => ({ ok: true, requests: [] }),
      readNextPendingDeadline: async () => {
        requestReads += 1;
        return { storeObservedAtMs: 0, maximumSleepMs: 100, nextDeadlineAtMs: 50 };
      },
    },
  });
  scheduler.start();
  while (!release) await Promise.resolve();
  scheduler.wake();
  release({ storeObservedAtMs: 0, maximumSleepMs: 100, nextExpiryAtMs: 40 });
  await scheduler.drain();
  expect({ requestReads, lockReads }).toEqual({ requestReads: 2, lockReads: 2 });
  expect(timers.delays).toEqual([5]);
  scheduler.stop();
});

test("an immediately due lock schedule re-pumps before arming a timer", async () => {
  let expiryCalls = 0;
  let lockReads = 0;
  const timers = new FakeTimers();
  const scheduler = new RequestDeadlineScheduler({
    ...schedulerOptions(
      timers,
      schedulerLocks({
        readNextExpiry: async () => {
          lockReads += 1;
          return lockReads === 1
            ? { storeObservedAtMs: 10, maximumSleepMs: 100, nextExpiryAtMs: 10 }
            : { storeObservedAtMs: 10, maximumSleepMs: 20 };
        },
      }),
    ),
    requests: {
      expireDueRequests: async () => {
        expiryCalls += 1;
        return { ok: true, requests: [] };
      },
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 10, maximumSleepMs: 100 }),
    },
  });
  expect(await scheduler.startAndWaitReady()).toEqual({ ok: true });
  expect({ expiryCalls, lockReads }).toEqual({ expiryCalls: 2, lockReads: 2 });
  expect(timers.delays).toEqual([20]);
  scheduler.stop();
});

test("stop aborts an in-flight lock cleanup before request expiration", async () => {
  let started = false;
  let expiryCalls = 0;
  const scheduler = new RequestDeadlineScheduler({
    ...schedulerOptions(
      new FakeTimers(),
      schedulerLocks({ cleanupExpired: () => new Promise(() => (started = true)) }),
    ),
    requests: {
      expireDueRequests: async () => {
        expiryCalls += 1;
        return { ok: true, requests: [] };
      },
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
    },
  });
  scheduler.start();
  while (!started) await Promise.resolve();
  expect(scheduler.status).toBe("starting");
  scheduler.stop();
  await scheduler.drain();
  expect(expiryCalls).toBe(0);
  expect(scheduler.status).toBe("stopped");
});

test("timer callbacks made stale by wake and stop cannot start another pump", async () => {
  const callbacks: Array<() => void> = [];
  const timers: RequestDeadlineTimerPort = {
    set: (_delay, callback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    clear: () => undefined,
  };
  let expiryCalls = 0;
  const scheduler = new RequestDeadlineScheduler({
    ...schedulerOptions(timers, schedulerLocks()),
    requests: {
      expireDueRequests: async () => {
        expiryCalls += 1;
        return { ok: true, requests: [] };
      },
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
    },
  });
  scheduler.start();
  await scheduler.drain();
  scheduler.wake();
  await scheduler.drain();
  expect(callbacks).toHaveLength(2);
  callbacks[0]?.();
  await scheduler.drain();
  scheduler.stop();
  callbacks[1]?.();
  await scheduler.drain();
  expect(expiryCalls).toBe(2);
  expect(scheduler.status).toBe("stopped");
});

test("stop during timer arm clears the unpublished handle without reporting a fault", async () => {
  let scheduler!: RequestDeadlineScheduler;
  let clears = 0;
  const faults: string[] = [];
  const timers: RequestDeadlineTimerPort = {
    set: () => {
      scheduler.stop();
      return 1;
    },
    clear: () => {
      clears += 1;
    },
  };
  scheduler = new RequestDeadlineScheduler({
    ...schedulerOptions(timers, schedulerLocks()),
    onFault: (fault) => {
      faults.push(fault.code);
      return undefined;
    },
  });
  scheduler.start();
  await scheduler.drain();
  expect(clears).toBe(1);
  expect(faults).toEqual([]);
  expect(scheduler.status).toBe("stopped");
});

test("stop aborts an in-flight lock schedule read and ignores its late result", async () => {
  let release: ((value: unknown) => void) | undefined;
  const timers = new FakeTimers();
  const scheduler = new RequestDeadlineScheduler({
    ...schedulerOptions(
      timers,
      schedulerLocks({
        readNextExpiry: () => new Promise((resolve) => (release = resolve)) as never,
      }),
    ),
  });
  scheduler.start();
  while (!release) await Promise.resolve();
  scheduler.stop();
  await scheduler.drain();
  expect(scheduler.status).toBe("stopped");
  expect(timers.pending.size).toBe(0);
  release({ storeObservedAtMs: 0, maximumSleepMs: 1 });
  await Promise.resolve();
});

test("malformed lock cleanup and schedule contracts fault before readiness", async () => {
  for (const locks of [
    schedulerLocks({ cleanupExpired: async () => ({ deleted: -1 }) }),
    schedulerLocks({ readNextExpiry: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 0 }) }),
  ]) {
    const faults: string[] = [];
    const scheduler = new RequestDeadlineScheduler({
      ...schedulerOptions(new FakeTimers(), locks),
      onFault: (fault) => {
        faults.push(fault.code);
        return undefined;
      },
    });
    expect(await scheduler.startAndWaitReady()).toMatchObject({
      ok: false,
      fault: { code: "port_contract_violation" },
    });
    expect(faults).toEqual(["port_contract_violation"]);
  }
});
