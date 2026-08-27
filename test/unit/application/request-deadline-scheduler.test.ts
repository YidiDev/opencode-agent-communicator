import { expect, expectTypeOf, test } from "bun:test";

import {
  RequestDeadlineScheduler,
  RequestDeadlineSchedulerFault,
  type RequestDeadlineSchedulerOptions,
  type RequestDeadlineTimerPort,
  requestDeadlineMaximumTimerDelayMs,
} from "../../../src/application/request-deadline-scheduler";
import type {
  ExpireDueRequestsResult,
  NextPendingRequestDeadline,
  RequestDeadlinePersistencePort,
} from "../../../src/application/request-ports";
import { validateNativeMessageId, validateRequestId } from "../../../src/domain/generated-ids";
import type { FencingToken } from "../../../src/domain/ownership";
import { OwnershipLostFault } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function fixtureValue<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("bad fixture");
  return result.value;
}

const workspaceKey = fixtureValue(validateWorkspaceKey("scheduler"));
const sourceId = fixtureValue(validateSessionId("ses_source"));
const targetId = fixtureValue(validateSessionId("ses_target"));
const token = 1 as FencingToken;

test("fault callback contract returns exactly undefined synchronously", () => {
  type FaultCallback = NonNullable<RequestDeadlineSchedulerOptions["onFault"]>;
  expectTypeOf<ReturnType<FaultCallback>>().toEqualTypeOf<undefined>();
  expectTypeOf<
    (fault: RequestDeadlineSchedulerFault) => Promise<void>
  >().not.toExtend<FaultCallback>();
});

function expired(seed: number): RequestMetadata {
  const hex = seed.toString(16).padStart(32, "0");
  const request = validateRequestId(`req_${hex}`);
  const native = validateNativeMessageId(`msg_${hex}`);
  if (!request.ok || !native.ok) throw new Error("bad generated fixture");
  return {
    id: request.value,
    workspaceKey,
    sourceSessionId: sourceId,
    targetSessionId: targetId,
    nativeMessageId: native.value,
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

function schedulerFixture(input: {
  readonly expires?: ExpireDueRequestsResult[];
  readonly schedules?: NextPendingRequestDeadline[];
  readonly timers?: FakeTimers;
  readonly onNotify?: (requestId: string) => void;
  readonly onFault?: (fault: RequestDeadlineSchedulerFault) => undefined;
}) {
  const expires = [...(input.expires ?? [{ ok: true, requests: [] }])];
  const schedules = [...(input.schedules ?? [{ storeObservedAtMs: 10, maximumSleepMs: 100 }])];
  let expiryCalls = 0;
  let readCalls = 0;
  const requests: RequestDeadlinePersistencePort = {
    expireDueRequests: async () => {
      expiryCalls++;
      return expires.shift() ?? { ok: true, requests: [] };
    },
    readNextPendingDeadline: async () => {
      readCalls++;
      return schedules.shift() ?? { storeObservedAtMs: 10, maximumSleepMs: 100 };
    },
  };
  const timers = input.timers ?? new FakeTimers();
  const scheduler = new RequestDeadlineScheduler({
    requests,
    fencingToken: token,
    workspaceKey,
    timers,
    nowMonotonicMs: () => 0,
    notifications: {
      notifyTerminal: (event) => {
        input.onNotify?.(event.requestId);
        return undefined;
      },
    },
    ...(input.onFault ? { onFault: input.onFault } : {}),
  });
  return { scheduler, timers, calls: () => ({ expiryCalls, readCalls }) };
}

test("no deadline still arms a lease renewal timer and duplicate wake stays serialized", async () => {
  const fixture = schedulerFixture({});
  fixture.scheduler.start();
  fixture.scheduler.start();
  fixture.scheduler.wake();
  await fixture.scheduler.drain();
  expect(fixture.calls()).toEqual({ expiryCalls: 1, readCalls: 1 });
  expect(fixture.timers.pending.size).toBe(1);
  expect(fixture.timers.delays).toEqual([100]);
});

test("earliest deadline arms one timer and an early fire rechecks store", async () => {
  const fixture = schedulerFixture({
    expires: [
      { ok: true, requests: [] },
      { ok: true, requests: [] },
      { ok: true, requests: [expired(1)] },
    ],
    schedules: [
      { storeObservedAtMs: 10, maximumSleepMs: 100, nextDeadlineAtMs: 20 },
      { storeObservedAtMs: 11, maximumSleepMs: 100, nextDeadlineAtMs: 20 },
      { storeObservedAtMs: 20, maximumSleepMs: 100 },
    ],
  });
  fixture.scheduler.start();
  await fixture.scheduler.drain();
  expect(fixture.timers.delays).toEqual([10]);
  fixture.timers.fire();
  await fixture.scheduler.drain();
  expect(fixture.timers.delays).toEqual([10, 9]);
  fixture.timers.fire();
  await fixture.scheduler.drain();
  expect(fixture.calls().expiryCalls).toBe(3);
});

test("full batches drain before read and committed rows notify in order", async () => {
  const notifications: string[] = [];
  const first = Array.from({ length: 100 }, (_, index) => expired(index + 1));
  const last = expired(200);
  const fixture = schedulerFixture({
    expires: [
      { ok: true, requests: first },
      { ok: true, requests: [last] },
    ],
    onNotify: (requestId) => notifications.push(requestId),
  });
  fixture.scheduler.start();
  await fixture.scheduler.drain();
  expect(fixture.calls()).toEqual({ expiryCalls: 2, readCalls: 1 });
  expect(notifications).toHaveLength(101);
  expect(notifications.at(-1)).toBe(last.id);
});

test("wake replaces an armed later timer and long delays are capped", async () => {
  const fixture = schedulerFixture({
    expires: [
      { ok: true, requests: [] },
      { ok: true, requests: [] },
    ],
    schedules: [
      {
        storeObservedAtMs: 0,
        maximumSleepMs: requestDeadlineMaximumTimerDelayMs + 10,
        nextDeadlineAtMs: requestDeadlineMaximumTimerDelayMs + 10,
      },
      { storeObservedAtMs: 5, maximumSleepMs: 100, nextDeadlineAtMs: 15 },
    ],
  });
  fixture.scheduler.start();
  await fixture.scheduler.drain();
  expect(fixture.timers.delays).toEqual([requestDeadlineMaximumTimerDelayMs]);
  fixture.scheduler.wake();
  await fixture.scheduler.drain();
  expect(fixture.timers.pending.size).toBe(1);
  expect(fixture.timers.delays).toEqual([requestDeadlineMaximumTimerDelayMs, 10]);
});

test("wake during read cannot lose an earlier deadline", async () => {
  let release: ((value: NextPendingRequestDeadline) => void) | undefined;
  let reads = 0;
  const timers = new FakeTimers();
  const requests: RequestDeadlinePersistencePort = {
    expireDueRequests: async () => ({ ok: true, requests: [] }),
    readNextPendingDeadline: async () => {
      reads++;
      if (reads === 1) return new Promise((resolve) => (release = resolve));
      return { storeObservedAtMs: 5, maximumSleepMs: 100, nextDeadlineAtMs: 7 };
    },
  };
  const scheduler = new RequestDeadlineScheduler({
    requests,
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers,
    nowMonotonicMs: () => 0,
  });
  scheduler.start();
  while (!release) await Promise.resolve();
  scheduler.wake();
  release({ storeObservedAtMs: 5, maximumSleepMs: 100, nextDeadlineAtMs: 20 });
  await scheduler.drain();
  expect(reads).toBe(2);
  expect(timers.delays).toEqual([2]);
});

test("stop drain waits for the in-flight store completion before disposal can close it", async () => {
  let release: (() => void) | undefined;
  let storeClosed = false;
  const scheduler = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: () =>
        new Promise((resolve) => {
          release = () => {
            expect(storeClosed).toBe(false);
            resolve({ ok: true, requests: [] });
          };
        }),
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
    },
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers: new FakeTimers(),
    nowMonotonicMs: () => 0,
  });
  let drained = false;
  const drain = scheduler.drain().then(() => {
    drained = true;
    storeClosed = true;
  });
  // Replace the completion after drain has observed the scheduler's initial settled promise.
  scheduler.start();
  while (!release) await Promise.resolve();
  scheduler.stop();
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  await drain;
  expect(storeClosed).toBe(true);
});

test("wake during arm clears the stale timer", async () => {
  const timers = new FakeTimers();
  let scheduler: RequestDeadlineScheduler;
  let sets = 0;
  const wakingTimers: RequestDeadlineTimerPort = {
    set: (delay, callback) => {
      const handle = timers.set(delay, callback);
      if (sets++ === 0) scheduler.wake();
      return handle;
    },
    clear: (handle) => timers.clear(handle),
  };
  const schedules = [
    { storeObservedAtMs: 1, maximumSleepMs: 100, nextDeadlineAtMs: 20 },
    { storeObservedAtMs: 2, maximumSleepMs: 100, nextDeadlineAtMs: 5 },
  ];
  scheduler = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: async () => ({ ok: true, requests: [] }),
      readNextPendingDeadline: async () =>
        schedules.shift() ?? { storeObservedAtMs: 2, maximumSleepMs: 100 },
    },
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers: wakingTimers,
    nowMonotonicMs: () => 0,
  });
  scheduler.start();
  await scheduler.drain();
  expect(timers.pending.size).toBe(1);
  expect(timers.delays).toEqual([19, 3]);
});

test("ownership, storage, and malformed contracts stop with typed faults", async () => {
  const cases: readonly [unknown, RequestDeadlineSchedulerFault["code"]][] = [
    [{ ok: false, code: "ownership_lost" }, "ownership_lost"],
    [{ ok: false, code: "storage_unavailable" }, "storage_failure"],
    [{ ok: true, requests: "bad" }, "port_contract_violation"],
    [{ ok: true, requests: [expired(1), expired(1)] }, "port_contract_violation"],
    [
      { ok: true, requests: [{ ...expired(1), resolutionState: "cancelled" }] },
      "port_contract_violation",
    ],
  ];
  for (const [result, code] of cases) {
    const faults: RequestDeadlineSchedulerFault[] = [];
    const fixture = schedulerFixture({
      expires: [result as ExpireDueRequestsResult],
      onFault: (fault) => {
        faults.push(fault);
        return undefined;
      },
    });
    fixture.scheduler.start();
    await fixture.scheduler.drain();
    expect(faults[0]).toBeInstanceOf(RequestDeadlineSchedulerFault);
    expect(faults[0]?.code).toBe(code);
    fixture.scheduler.start();
    fixture.scheduler.wake();
    expect(fixture.timers.pending.size).toBe(0);
  }
});

test("thrown ownership and storage errors are classified and callback failures are isolated", async () => {
  for (const [cause, expected] of [
    [new OwnershipLostFault("lost"), "ownership_lost"],
    [new Error("disk"), "storage_failure"],
  ] as const) {
    let code: string | undefined;
    const scheduler = new RequestDeadlineScheduler({
      requests: {
        expireDueRequests: async () => {
          throw cause;
        },
        readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
      },
      notifications: { notifyTerminal: () => undefined },
      fencingToken: token,
      workspaceKey,
      timers: new FakeTimers(),
      onFault: (fault) => {
        code = fault.code;
        return Promise.reject(new Error("ignored callback failure")) as never;
      },
    });
    scheduler.start();
    await scheduler.drain();
    await Promise.resolve();
    expect(code).toBe(expected);
  }
});

test("invalid schedules, notification throws, and stop during a pump are safe", async () => {
  const faults: string[] = [];
  const invalid = schedulerFixture({
    schedules: [{ storeObservedAtMs: 10, maximumSleepMs: 100, nextDeadlineAtMs: -1 }],
    onFault: (fault) => {
      faults.push(fault.code);
      return undefined;
    },
  });
  invalid.scheduler.start();
  await invalid.scheduler.drain();
  expect(faults).toEqual(["port_contract_violation"]);

  const notifying = schedulerFixture({
    expires: [{ ok: true, requests: [expired(1)] }],
    onNotify: () => {
      throw new Error("observer");
    },
  });
  notifying.scheduler.start();
  await notifying.scheduler.drain();
  expect(notifying.calls().readCalls).toBe(1);

  let release!: (value: ExpireDueRequestsResult) => void;
  const stopped = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: () => new Promise((resolve) => (release = resolve)),
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
    },
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers: new FakeTimers(),
  });
  stopped.start();
  await Promise.resolve();
  stopped.stop();
  stopped.stop();
  release({ ok: true, requests: [expired(1)] });
  await stopped.drain();
});

test("forward and backward wall-clock skew cannot override store deadline authority", async () => {
  for (const wallNow of [40, 5] as const) {
    const timers = new FakeTimers();
    const faults: string[] = [];
    const options = {
      requests: {
        expireDueRequests: async () => ({ ok: true, requests: [] }),
        readNextPendingDeadline: async () => ({
          storeObservedAtMs: 10,
          maximumSleepMs: 100,
          nextDeadlineAtMs: 50,
        }),
      },
      notifications: { notifyTerminal: () => undefined },
      fencingToken: token,
      workspaceKey,
      timers,
      nowMonotonicMs: () => 0,
      // A stale caller compiled against the removed option cannot reintroduce wall-clock authority.
      nowWallMs: () => wallNow,
      onFault: (fault: RequestDeadlineSchedulerFault): undefined => {
        faults.push(fault.code);
        return undefined;
      },
    } as unknown as RequestDeadlineSchedulerOptions;
    const scheduler = new RequestDeadlineScheduler(options);
    scheduler.start();
    await scheduler.drain();
    expect(timers.delays).toEqual([40]);
    expect(faults).toEqual([]);
  }
});

test("monotonic query elapsed time crossing a future store deadline immediately rechecks", async () => {
  const readings = [100, 111, 200, 200];
  const timers = new FakeTimers();
  const fixture = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: async () => ({ ok: true, requests: [] }),
      readNextPendingDeadline: async () =>
        readings.length === 3
          ? { storeObservedAtMs: 1_000, maximumSleepMs: 100, nextDeadlineAtMs: 1_010 }
          : { storeObservedAtMs: 1_011, maximumSleepMs: 100 },
    },
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers,
    nowMonotonicMs: () => readings.shift() as number,
  });
  fixture.start();
  await fixture.drain();
  expect(timers.delays).toEqual([100]);
});

test("hidden, symbol, and excessive reflected schedule data faults with bounded descriptor work", async () => {
  const hidden = Object.defineProperty({ storeObservedAtMs: 0, maximumSleepMs: 100 }, "hidden", {
    value: true,
  });
  const symbol = Object.defineProperty(
    { storeObservedAtMs: 0, maximumSleepMs: 100 },
    Symbol("hidden"),
    { value: true },
  );
  let descriptorCalls = 0;
  const excessive = new Proxy(
    {},
    {
      ownKeys: () => ["one", "two", "three", "four"],
      getOwnPropertyDescriptor: () => {
        descriptorCalls += 1;
        return { configurable: true, enumerable: true, value: 1 };
      },
    },
  );
  for (const schedule of [hidden, symbol, excessive]) {
    const faults: string[] = [];
    const scheduler = new RequestDeadlineScheduler({
      requests: {
        expireDueRequests: async () => ({ ok: true, requests: [] }),
        readNextPendingDeadline: async () => schedule as NextPendingRequestDeadline,
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
    expect(faults).toEqual(["port_contract_violation"]);
  }
  expect(descriptorCalls).toBe(0);
});

test("expiration arrays reject hidden and symbol keys", async () => {
  for (const key of ["hidden", Symbol("hidden")]) {
    const requests = Object.defineProperty([], key, { value: true });
    const faults: string[] = [];
    const scheduler = new RequestDeadlineScheduler({
      requests: {
        expireDueRequests: async () => ({ ok: true, requests }) as ExpireDueRequestsResult,
        readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
      },
      notifications: { notifyTerminal: () => undefined },
      fencingToken: token,
      workspaceKey,
      timers: new FakeTimers(),
      onFault: (fault) => {
        faults.push(fault.code);
        return undefined;
      },
    });
    scheduler.start();
    await scheduler.drain();
    expect(faults).toEqual(["port_contract_violation"]);
  }
});

test("an already due schedule immediately re-pumps and then arms the no-work lease timer", async () => {
  const faults: string[] = [];
  const fixture = schedulerFixture({
    expires: [
      { ok: true, requests: [] },
      { ok: true, requests: [expired(1)] },
    ],
    schedules: [
      { storeObservedAtMs: 10, maximumSleepMs: 100, nextDeadlineAtMs: 10 },
      { storeObservedAtMs: 11, maximumSleepMs: 100 },
    ],
    onFault: (fault) => {
      faults.push(fault.code);
      return undefined;
    },
  });
  fixture.scheduler.start();
  await fixture.scheduler.drain();
  expect(fixture.calls()).toEqual({ expiryCalls: 2, readCalls: 2 });
  expect(fixture.timers.delays).toEqual([100]);
  expect(faults).toEqual([]);
});

test("endless immediately due schedules and full batches stop at finite pump bounds", async () => {
  for (const mode of ["due", "full"] as const) {
    let expiryCalls = 0;
    let readCalls = 0;
    const faults: string[] = [];
    const scheduler = new RequestDeadlineScheduler({
      requests: {
        expireDueRequests: async () => {
          const batch = Array.from({ length: 100 }, (_, index) =>
            expired(expiryCalls * 100 + index + 1),
          );
          expiryCalls += 1;
          return { ok: true, requests: mode === "full" ? batch : [] };
        },
        readNextPendingDeadline: async () => {
          readCalls += 1;
          return {
            storeObservedAtMs: 10,
            maximumSleepMs: 100,
            nextDeadlineAtMs: 10,
          };
        },
      },
      notifications: { notifyTerminal: () => undefined },
      fencingToken: token,
      workspaceKey,
      timers: new FakeTimers(),
      nowMonotonicMs: () => 10,
      onFault: (fault) => {
        faults.push(fault.code);
        return undefined;
      },
    });
    scheduler.start();
    await scheduler.drain();
    expect(faults).toEqual(["port_contract_violation"]);
    expect(expiryCalls).toBeLessThanOrEqual(22);
    expect(readCalls).toBeLessThanOrEqual(22);
  }
});

test("timer set and clear exceptions fault without escaping public methods", async () => {
  for (const mode of ["set", "clear"] as const) {
    const faults: string[] = [];
    const timers: RequestDeadlineTimerPort = {
      set: () => {
        if (mode === "set") throw new Error("set");
        return 1;
      },
      clear: () => {
        if (mode === "clear") throw new Error("clear");
      },
    };
    const scheduler = new RequestDeadlineScheduler({
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
    expect(() => scheduler.start()).not.toThrow();
    await scheduler.drain();
    if (mode === "clear") expect(() => scheduler.stop()).not.toThrow();
    expect(faults).toEqual(["port_contract_violation"]);
  }
});

test("invalid, throwing, and regressing monotonic clocks fault", async () => {
  for (const readings of [
    [Number.NaN],
    [-1],
    [Number.POSITIVE_INFINITY],
    [2, 1],
    ["throw"],
  ] as const) {
    const faults: string[] = [];
    let index = 0;
    const scheduler = new RequestDeadlineScheduler({
      requests: {
        expireDueRequests: async () => ({ ok: true, requests: [] }),
        readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
      },
      notifications: { notifyTerminal: () => undefined },
      fencingToken: token,
      workspaceKey,
      timers: new FakeTimers(),
      nowMonotonicMs: () => {
        const reading = readings[index++] ?? readings.at(-1);
        if (reading === "throw") throw new Error("clock");
        return reading as number;
      },
      onFault: (fault) => {
        faults.push(fault.code);
        return undefined;
      },
    });
    scheduler.start();
    await scheduler.drain();
    expect(faults).toEqual(["port_contract_violation"]);
  }
});

test("stop aborts before drain and remains finite for a non-cooperative persistence promise", async () => {
  let reject!: (cause: unknown) => void;
  const scheduler = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: () => new Promise((_, fail) => (reject = fail)),
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
    },
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers: new FakeTimers(),
  });
  scheduler.start();
  while (!reject) await Promise.resolve();
  scheduler.stop();
  await scheduler.drain();
  expect(scheduler.status).toBe("stopped");
  reject(new OwnershipLostFault("late"));
  await Promise.resolve();
});

test("fault reporting does not assimilate thenables and observes ordinary native rejections", async () => {
  let thenReads = 0;
  let calls = 0;
  const hostileThenable = {};
  const thenKey = "then";
  Object.defineProperties(hostileThenable, {
    [thenKey]: { get: () => (thenReads += 1) },
    catch: { get: () => (thenReads += 1) },
    constructor: { get: () => 1 },
  });
  const rejected = Promise.reject(new Error("ignored callback failure"));
  Object.defineProperties(rejected, {
    catch: { configurable: true, get: () => 1 },
    // biome-ignore lint/suspicious/noThenProperty: verifies intrinsic then bypasses an own override.
    then: { configurable: true, get: () => 1 },
    constructor: { configurable: true, value: Promise },
  });
  for (const returned of [hostileThenable, rejected]) {
    const scheduler = new RequestDeadlineScheduler({
      requests: {
        expireDueRequests: async () => ({ ok: true, requests: "bad" }) as never,
        readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
      },
      notifications: { notifyTerminal: () => undefined },
      fencingToken: token,
      workspaceKey,
      timers: new FakeTimers(),
      onFault: () => {
        calls += 1;
        return returned as never;
      },
    });
    scheduler.start();
    await scheduler.drain();
  }
  expect(calls).toBe(2);
  expect(thenReads).toBe(0);
});

test("readiness and exact lifecycle status remain stable across ready, stop, and fault", async () => {
  const ready = schedulerFixture({});
  expect(ready.scheduler.status).toBe("idle");
  expect(await ready.scheduler.startAndWaitReady()).toEqual({ ok: true });
  expect(ready.scheduler.status).toBe("ready");
  expect(await ready.scheduler.startAndWaitReady()).toEqual({ ok: true });
  ready.scheduler.stop();
  expect(ready.scheduler.status).toBe("stopped");
  expect((await ready.scheduler.startAndWaitReady()).ok).toBe(false);

  const faulted = schedulerFixture({ expires: [{ ok: true, requests: "bad" } as never] });
  const readiness = await faulted.scheduler.startAndWaitReady();
  expect(readiness).toMatchObject({
    ok: false,
    fault: { code: "port_contract_violation" },
  });
  expect(faulted.scheduler.status).toBe("faulted");
  expect(faulted.scheduler.fault?.code).toBe("port_contract_violation");
  expect(await faulted.scheduler.startAndWaitReady()).toEqual(readiness);
});

test("default monotonic clock participates in readiness when no override is supplied", async () => {
  const timers = new FakeTimers();
  const scheduler = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: async () => ({ ok: true, requests: [] }),
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
    },
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers,
  });
  expect(await scheduler.startAndWaitReady()).toEqual({ ok: true });
  scheduler.stop();
});

test("lease rechecks run bounded request maintenance recurrently", async () => {
  const timers = new FakeTimers();
  let resultMaintenance = 0;
  let retentionMaintenance = 0;
  const scheduler = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: async () => ({ ok: true, requests: [] }),
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 }),
    },
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
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers,
    nowMonotonicMs: () => 0,
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
