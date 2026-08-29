import { expect, test } from "bun:test";
import type { AdvisoryLockPersistencePort } from "../../../src/application/advisory-lock-ports";
import {
  advisoryLockCleanupLimitPerPump,
  RequestDeadlineScheduler,
  type RequestDeadlineTimerPort,
} from "../../../src/application/request-deadline-scheduler";
import type { FencingToken } from "../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("lock-scheduler");
if (!workspace.ok) throw new Error("bad workspace");

class Timer implements RequestDeadlineTimerPort {
  delay = -1;
  callback: (() => void) | undefined;
  set(delay: number, callback: () => void): unknown {
    this.delay = delay;
    this.callback = callback;
    return callback;
  }
  clear(): void {
    this.callback = undefined;
  }
  fire(): void {
    const callback = this.callback;
    this.callback = undefined;
    callback?.();
  }
}

function locks(overrides: Partial<AdvisoryLockPersistencePort> = {}): AdvisoryLockPersistencePort {
  return {
    publish: async () => ({ ok: false, code: "storage_unavailable" }),
    list: async () => ({ locks: [] }),
    renew: async () => ({ ok: false, code: "storage_unavailable" }),
    release: async () => ({ ok: false, code: "storage_unavailable" }),
    cleanupExpired: async () => ({ deleted: 0 }),
    readNextExpiry: async () => ({ storeObservedAtMs: 100, maximumSleepMs: 1_000 }),
    ...overrides,
  };
}

test("startup and recurring pump perform one bounded cleanup and arm the single timer at the earliest lock deadline", async () => {
  const timer = new Timer();
  const cleanupLimits: number[] = [];
  let cleanupCalls = 0;
  const scheduler = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: async () => ({ ok: true, requests: [] }),
      readNextPendingDeadline: async () => ({
        storeObservedAtMs: 100,
        maximumSleepMs: 1_000,
        nextDeadlineAtMs: 150,
      }),
    },
    locks: locks({
      cleanupExpired: async (input) => {
        cleanupCalls += 1;
        cleanupLimits.push(input.limit);
        return { deleted: input.limit };
      },
      readNextExpiry: async () => ({
        storeObservedAtMs: 100,
        maximumSleepMs: 500,
        nextExpiryAtMs: 120,
      }),
    }),
    notifications: { notifyTerminal: () => undefined },
    fencingToken: 1 as FencingToken,
    workspaceKey: workspace.value,
    timers: timer,
    nowMonotonicMs: () => 0,
  });
  scheduler.start();
  await scheduler.drain();
  expect(cleanupCalls).toBe(1);
  expect(cleanupLimits).toEqual([advisoryLockCleanupLimitPerPump]);
  expect(timer.delay).toBe(20);
  timer.fire();
  await scheduler.drain();
  expect(cleanupCalls).toBe(2);
});

test("malformed bounded-cleanup outcomes fault the owned lifecycle scheduler", async () => {
  const faults: string[] = [];
  const scheduler = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: async () => ({ ok: true, requests: [] }),
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 1, maximumSleepMs: 100 }),
    },
    locks: locks({
      cleanupExpired: async () => ({ deleted: advisoryLockCleanupLimitPerPump + 1 }),
    }),
    notifications: { notifyTerminal: () => undefined },
    fencingToken: 1 as FencingToken,
    workspaceKey: workspace.value,
    timers: new Timer(),
    nowMonotonicMs: () => 0,
    onFault: (fault) => {
      faults.push(fault.code);
      return undefined;
    },
  });
  scheduler.start();
  await scheduler.drain();
  expect(scheduler.status).toBe("faulted");
  expect(faults).toEqual(["port_contract_violation"]);
});
