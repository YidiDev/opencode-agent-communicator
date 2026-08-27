import { expect, test } from "bun:test";

import {
  RequestDeadlineScheduler,
  type RequestDeadlineSchedulerFault,
  type RequestDeadlineTimerPort,
} from "../../../src/application/request-deadline-scheduler";
import {
  drainRequestMaintenance,
  type RequestMaintenancePorts,
} from "../../../src/application/request-maintenance";
import type { FencingToken } from "../../../src/domain/ownership";
import { OwnershipLostFault } from "../../../src/domain/ownership";
import { requestFixture, requestTestWorkspace } from "../../support/request-store";

const token = 1 as FencingToken;
const workspaceKey = requestTestWorkspace();

function schedulerFor(input: {
  expire?: () => Promise<unknown>;
  read?: () => Promise<unknown>;
  maintenance?: RequestMaintenancePorts;
  timers?: RequestDeadlineTimerPort;
}) {
  const faults: string[] = [];
  const scheduler = new RequestDeadlineScheduler({
    requests: {
      expireDueRequests: input.expire ?? (async () => ({ ok: true, requests: [] })),
      readNextPendingDeadline:
        input.read ?? (async () => ({ storeObservedAtMs: 0, maximumSleepMs: 100 })),
    } as never,
    notifications: { notifyTerminal: () => undefined },
    fencingToken: token,
    workspaceKey,
    timers: input.timers ?? { set: () => 1, clear: () => undefined },
    nowMonotonicMs: () => 0,
    ...(input.maintenance ? { maintenance: input.maintenance } : {}),
    onFault: (fault: RequestDeadlineSchedulerFault) => {
      faults.push(fault.code);
      return undefined;
    },
  });
  return { scheduler, faults };
}

test("scheduler rejects malformed expiration result variants at the strict port boundary", async () => {
  for (const returned of [
    null,
    { ok: false, code: "future" },
    { ok: false, code: "ownership_lost", extra: true },
    { ok: true, requests: [], extra: true },
  ]) {
    const harness = schedulerFor({ expire: async () => returned });
    harness.scheduler.start();
    await harness.scheduler.drain();
    expect(harness.faults).toEqual(["port_contract_violation"]);
  }
});

test("scheduler maps each maintenance failure and never reads a deadline afterward", async () => {
  for (const [maintenanceResult, expected] of [
    [{ ok: false, code: "ownership_lost" }, "ownership_lost"],
    [{ ok: false, code: "contract" }, "port_contract_violation"],
    [{ ok: false, code: "storage_unavailable" }, "storage_failure"],
  ] as const) {
    let reads = 0;
    const harness = schedulerFor({
      maintenance: {
        resultRetention: { expireAvailableResults: async () => maintenanceResult as never },
        requestRetention: {
          collectRequestRetention: async () => ({
            ok: true,
            deletedRequests: 0,
            deletedRateEvents: 0,
          }),
        },
      },
      read: async () => {
        reads += 1;
        return { storeObservedAtMs: 0, maximumSleepMs: 100 };
      },
    });
    harness.scheduler.start();
    await harness.scheduler.drain();
    expect(harness.faults).toEqual([expected]);
    expect(reads).toBe(0);
  }
});

test("stale timer callbacks are inert after a wake replaces their version", async () => {
  const callbacks: Array<() => void> = [];
  let expires = 0;
  const harness = schedulerFor({
    expire: async () => {
      expires += 1;
      return { ok: true, requests: [] };
    },
    timers: {
      set: (_delay, callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      clear: () => undefined,
    },
  });
  harness.scheduler.start();
  await harness.scheduler.drain();
  const stale = callbacks[0];
  harness.scheduler.wake();
  await harness.scheduler.drain();
  stale?.();
  await harness.scheduler.drain();
  expect(expires).toBe(2);
});

test("deadline reads classify ownership and storage rejection after expiry succeeds", async () => {
  for (const [cause, expected] of [
    [new OwnershipLostFault("lost"), "ownership_lost"],
    [new Error("disk"), "storage_failure"],
  ] as const) {
    const harness = schedulerFor({
      read: async () => {
        throw cause;
      },
    });
    harness.scheduler.start();
    await harness.scheduler.drain();
    expect(harness.faults).toEqual([expected]);
  }
});

test("scheduler faults when a timer replacement cannot clear its stale handle", async () => {
  let clears = 0;
  const harness = schedulerFor({
    timers: {
      set: () => 1,
      clear: () => {
        clears += 1;
        throw new Error("clear");
      },
    },
  });
  harness.scheduler.start();
  await harness.scheduler.drain();
  harness.scheduler.wake();
  expect(harness.faults).toEqual(["port_contract_violation"]);
  expect(clears).toBeGreaterThan(0);
});

test("expiration success envelopes must contain the exact requests member", async () => {
  for (const returned of [{ ok: true }, { ok: "yes", requests: [] }]) {
    const harness = schedulerFor({ expire: async () => returned });
    harness.scheduler.start();
    await harness.scheduler.drain();
    expect(harness.faults).toEqual(["port_contract_violation"]);
  }
});

test("scheduler exposes starting status before its first asynchronous pump", async () => {
  const harness = schedulerFor({});
  harness.scheduler.start();
  expect(harness.scheduler.status).toBe("starting");
  await harness.scheduler.drain();
  expect(harness.scheduler.status).toBe("ready");
});

test("maintenance rejects malformed containers, duplicate expiry rows, and aborted phases", async () => {
  const fixture = await requestFixture(token);
  const resolvedAtMs = fixture.request.createdAtMs + 3;
  const expired = {
    ...fixture.request,
    resolutionState: "reached" as const,
    resultState: "expired" as const,
    resolvedAtMs,
    updatedAtMs: resolvedAtMs + 10,
    resultAvailableAtMs: resolvedAtMs,
    resultExpiresAtMs: resolvedAtMs + 10,
    resultExpiredAtMs: resolvedAtMs + 10,
  };
  const retention = {
    collectRequestRetention: async () => ({
      ok: true as const,
      deletedRequests: 0,
      deletedRateEvents: 0,
    }),
  };
  for (const result of [
    null,
    { ok: "yes", requests: [] },
    { ok: true, requests: [expired, expired] },
  ]) {
    expect(
      await drainRequestMaintenance({
        fencingToken: token,
        workspaceKey,
        ports: {
          resultRetention: { expireAvailableResults: async () => result as never },
          requestRetention: retention,
        },
      }),
    ).toEqual({ ok: false, code: "contract" });
  }

  for (const phase of ["result", "retention"] as const) {
    const abort = new AbortController();
    abort.abort("stopped");
    expect(
      await drainRequestMaintenance({
        fencingToken: token,
        workspaceKey,
        abort: abort.signal,
        ports: {
          resultRetention: {
            expireAvailableResults: async () =>
              phase === "result" ? new Promise(() => undefined) : { ok: true, requests: [] },
          },
          requestRetention: {
            collectRequestRetention: async () => new Promise(() => undefined),
          },
        } as never,
      }),
    ).toEqual({ ok: false, code: "ownership_lost" });
  }
});

test("maintenance distinguishes ownership faults from ordinary persistence failures in both phases", async () => {
  for (const cause of [new OwnershipLostFault("lost"), new Error("disk")]) {
    for (const phase of ["result", "retention"] as const) {
      const ports: RequestMaintenancePorts = {
        resultRetention: {
          expireAvailableResults: async () => {
            if (phase === "result") throw cause;
            return { ok: true, requests: [] };
          },
        },
        requestRetention: {
          collectRequestRetention: async () => {
            throw cause;
          },
        },
      };
      expect(await drainRequestMaintenance({ ports, fencingToken: token, workspaceKey })).toEqual({
        ok: false,
        code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      });
    }
  }
});
