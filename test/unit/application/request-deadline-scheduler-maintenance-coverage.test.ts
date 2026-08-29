import { expect, test } from "bun:test";

import {
  RequestDeadlineScheduler,
  type RequestDeadlineSchedulerOptions,
  type RequestDeadlineTimerPort,
} from "../../../src/application/request-deadline-scheduler";
import {
  calculateRequestDeadlineScheduleDelay,
  defaultMonotonicNowMs,
} from "../../../src/application/request-deadline-timing";
import type { NextPendingRequestDeadline } from "../../../src/application/request-ports";
import type { FencingToken } from "../../../src/domain/ownership";
import { OwnershipLostFault } from "../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspaceResult = validateWorkspaceKey("scheduler-maintenance-coverage");
if (!workspaceResult.ok) throw new Error("invalid fixture");
const workspaceKey = workspaceResult.value;
const token = 1 as FencingToken;

class FakeTimers implements RequestDeadlineTimerPort {
  readonly pending = new Map<number, () => void>();
  readonly delays: number[] = [];
  private next = 1;

  set(delayMs: number, callback: () => void): unknown {
    const handle = this.next++;
    this.delays.push(delayMs);
    this.pending.set(handle, callback);
    return handle;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
}

test("default monotonic timing falls back when the performance clock is unavailable", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "performance");
  try {
    for (const performanceValue of [undefined, {}]) {
      Object.defineProperty(globalThis, "performance", {
        configurable: true,
        value: performanceValue,
      });
      expect(defaultMonotonicNowMs()).toBeGreaterThanOrEqual(0);
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "performance", descriptor);
    else Reflect.deleteProperty(globalThis, "performance");
  }
});

test("schedule timing rejects malformed lock elapsed time and invalid computed delays", () => {
  const schedule = { storeObservedAtMs: 0, maximumSleepMs: 100 };
  expect(
    calculateRequestDeadlineScheduleDelay({
      schedule,
      elapsedMs: 0,
      lockSchedule: { storeObservedAtMs: 0, maximumSleepMs: 100 },
    }),
  ).toBe("invalid");
  expect(calculateRequestDeadlineScheduleDelay({ schedule, elapsedMs: 100 })).toBe("immediate");
  expect(
    calculateRequestDeadlineScheduleDelay({
      schedule: { storeObservedAtMs: 0, maximumSleepMs: 1.5 },
      elapsedMs: 0,
    }),
  ).toBe("invalid");
});

test("maintenance phases run in order before a deadline is read", async () => {
  const order: string[] = [];
  const scheduler = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: async () => {
        order.push("expire");
        return { ok: true, requests: [] };
      },
      readNextPendingDeadline: async () => {
        order.push("read");
        return { storeObservedAtMs: 0, maximumSleepMs: 100 };
      },
    },
    maintenance: {
      resultRetention: {
        expireAvailableResults: async () => {
          order.push("request-results");
          return { ok: true, requests: [] };
        },
      },
      requestRetention: {
        collectRequestRetention: async () => {
          order.push("requests");
          return { ok: true, deletedRequests: 0, deletedRateEvents: 0 };
        },
      },
    },
    additionalMaintenance: async (shouldStop, abort) => {
      expect(shouldStop()).toBe(false);
      expect(abort.aborted).toBe(false);
      order.push("additional");
      return { ok: true };
    },
    deliveryRetention: {
      garbageCollectMetadata: async () => {
        order.push("deliveries");
        return { ok: true, deletedDeliveries: 0, deletedRateEvents: 0 };
      },
    },
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers: new FakeTimers(),
    nowMonotonicMs: () => 0,
  });
  expect(await scheduler.startAndWaitReady()).toEqual({ ok: true });
  expect(order).toEqual([
    "expire",
    "request-results",
    "requests",
    "additional",
    "deliveries",
    "read",
  ]);
  scheduler.stop();
});

test("additional and delivery maintenance failures map to scheduler fault ownership", async () => {
  for (const [phase, returned, expected] of [
    ["additional", { ok: false, code: "ownership_lost" }, "ownership_lost"],
    ["additional", { ok: false, code: "contract" }, "port_contract_violation"],
    ["additional", { ok: false, code: "disk" }, "storage_failure"],
    ["delivery", new OwnershipLostFault("lost"), "ownership_lost"],
    ["delivery", new Error("disk"), "storage_failure"],
    ["delivery", { malformed: true }, "port_contract_violation"],
  ] as const) {
    let reads = 0;
    const faults: string[] = [];
    const scheduler = new RequestDeadlineScheduler({
      requests: {
        expireDueRequests: async () => ({ ok: true, requests: [] }),
        readNextPendingDeadline: async () => {
          reads += 1;
          return { storeObservedAtMs: 0, maximumSleepMs: 100 };
        },
      },
      ...(phase === "additional"
        ? { additionalMaintenance: async () => returned as never }
        : {
            deliveryRetention: {
              garbageCollectMetadata: async () => {
                if (returned instanceof Error) throw returned;
                return returned;
              },
            },
          }),
      notifications: { notifyTerminal: () => undefined },
      fencingToken: token,
      workspaceKey,
      timers: new FakeTimers(),
      nowMonotonicMs: () => 0,
      onFault: (fault) => {
        faults.push(fault.code);
        return undefined;
      },
    });
    scheduler.start();
    await scheduler.drain();
    expect(faults).toEqual([expected]);
    expect(reads).toBe(0);
  }
});

test("a rejected additional maintenance operation faults at the pump boundary", async () => {
  const faults: string[] = [];
  const scheduler = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: async () => ({ ok: true, requests: [] }),
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
    },
    additionalMaintenance: async () => {
      throw new Error("maintenance unavailable");
    },
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers: new FakeTimers(),
    nowMonotonicMs: () => 0,
    onFault: (fault) => {
      faults.push(fault.code);
      return undefined;
    },
  });
  scheduler.start();
  await scheduler.drain();
  expect(faults).toEqual(["storage_failure"]);
});

test("stop drains an in-flight deadline read and discards its late schedule", async () => {
  let release!: (schedule: NextPendingRequestDeadline) => void;
  const timers = new FakeTimers();
  const scheduler = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: async () => ({ ok: true, requests: [] }),
      readNextPendingDeadline: () => new Promise((resolve) => (release = resolve)),
    },
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers,
    nowMonotonicMs: () => 0,
  });
  scheduler.start();
  while (!release) await Promise.resolve();
  scheduler.stop();
  release({ storeObservedAtMs: 0, maximumSleepMs: 100 });
  await scheduler.drain();
  expect(timers.pending.size).toBe(0);
  expect(scheduler.status).toBe("stopped");
});

test("elapsed schedule reads can consume a lease sleep without a stored deadline", async () => {
  const readings = [10, 20, 30, 30];
  const timers = new FakeTimers();
  const scheduler = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: async () => ({ ok: true, requests: [] }),
      readNextPendingDeadline: async () =>
        readings.length === 3
          ? { storeObservedAtMs: 0, maximumSleepMs: 5 }
          : { storeObservedAtMs: 0, maximumSleepMs: 100 },
    },
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers,
    nowMonotonicMs: () => readings.shift() as number,
  });
  scheduler.start();
  await scheduler.drain();
  expect(timers.delays).toEqual([100]);
});

test("stop drains each in-flight maintenance phase without reading or arming afterward", async () => {
  for (const phase of ["request", "additional", "delivery"] as const) {
    let release: ((value: unknown) => void) | undefined;
    let reads = 0;
    const gate = () => new Promise<unknown>((resolve) => (release = resolve));
    const scheduler = new RequestDeadlineScheduler({
      requests: {
        expireDueRequests: async () => ({ ok: true, requests: [] }),
        readNextPendingDeadline: async () => {
          reads += 1;
          return { storeObservedAtMs: 0, maximumSleepMs: 100 };
        },
      },
      ...(phase === "request"
        ? {
            maintenance: {
              resultRetention: { expireAvailableResults: gate },
              requestRetention: {
                collectRequestRetention: async () => ({
                  ok: true,
                  deletedRequests: 0,
                  deletedRateEvents: 0,
                }),
              },
            },
          }
        : {}),
      ...(phase === "additional" ? { additionalMaintenance: gate as never } : {}),
      ...(phase === "delivery"
        ? { deliveryRetention: { garbageCollectMetadata: gate as never } }
        : {}),
      notifications: { notifyTerminal: () => undefined },
      fencingToken: token,
      workspaceKey,
      timers: new FakeTimers(),
      nowMonotonicMs: () => 0,
    } as RequestDeadlineSchedulerOptions);
    scheduler.start();
    while (!release) await Promise.resolve();
    scheduler.stop();
    const drained = scheduler.drain();
    release(
      phase === "request"
        ? { ok: true, requests: [] }
        : phase === "delivery"
          ? { ok: true, deletedDeliveries: 0, deletedRateEvents: 0 }
          : { ok: true },
    );
    await drained;
    expect(reads).toBe(0);
    expect(scheduler.status).toBe("stopped");
  }
});

test("a stop racing timer installation clears the uncommitted handle without reactivating", async () => {
  const faults: string[] = [];
  let scheduler!: RequestDeadlineScheduler;
  let clearCalls = 0;
  const timers: RequestDeadlineTimerPort = {
    set: () => {
      scheduler.stop();
      return 17;
    },
    clear: (handle) => {
      expect(handle).toBe(17);
      clearCalls += 1;
      throw new Error("native timer cleanup failed");
    },
  };
  scheduler = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: async () => ({ ok: true, requests: [] }),
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
    },
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers,
    nowMonotonicMs: () => 0,
    onFault: (fault) => {
      faults.push(fault.code);
      return undefined;
    },
  });
  scheduler.start();
  await scheduler.drain();
  expect(clearCalls).toBe(1);
  expect(faults).toEqual([]);
  expect(scheduler.status).toBe("stopped");
});
