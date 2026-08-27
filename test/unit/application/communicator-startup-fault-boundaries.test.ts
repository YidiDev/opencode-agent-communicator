import { expect, test } from "bun:test";
import {
  type CommunicatorStartupRecoveryPorts,
  recoverCommunicatorStartup,
} from "../../../src/application/recover-communicator-startup";
import { RequestRuntime } from "../../../src/application/request-runtime";
import { OwnershipLostFault, validateFencingToken } from "../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const token = value(validateFencingToken(47));
const workspaceKey = value(validateWorkspaceKey("workspace:startup-faults"));

type StartupOverrides = Readonly<{
  acquire: () => Promise<typeof token>;
  establish: () => Promise<unknown>;
  current: () => Promise<boolean>;
  expireResults: () => Promise<unknown>;
  readDeadline: () => Promise<unknown>;
  retainDeliveries: () => Promise<unknown>;
}>;

function startupPorts(overrides: Partial<StartupOverrides> = {}): CommunicatorStartupRecoveryPorts {
  return {
    membership: {
      readCurrentRoots: async () => ({
        sourceVisible: true,
        targetVisible: true,
        sourceTitle: "source",
      }),
    },
    deliveries: {
      listRecoverable: async () => [],
      garbageCollectMetadata:
        overrides.retainDeliveries ??
        (async () => ({ ok: true, deletedDeliveries: 0, deletedRateEvents: 0 })),
    } as never,
    nativeQueue: { queueMessage: async () => ({ kind: "unknown" as const }) },
    requests: {
      listParticipantDeletionCandidates: async () => ({ ok: true, sessionIds: [] }),
      deleteAbsentParticipantRequests: async () => ({ ok: true, terminalized: [] }),
      listRecoverableRequests: async () => [],
      expireDueRequests: async () => ({ ok: true as const, requests: [] }),
      readNextPendingDeadline:
        overrides.readDeadline ?? (async () => ({ storeObservedAtMs: 1, maximumSleepMs: 10 })),
    } as never,
    participantPresence: { readParticipantPresence: async () => "present" },
    activity: {
      observeRequestParticipants: async () => ({
        sourceVisible: true,
        targetVisible: true,
        targetStatus: "idle" as const,
      }),
    },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" as const }) },
    ownership: {
      acquire: overrides.acquire ?? (async () => token),
      isCurrent: overrides.current ?? (async () => true),
    },
    startupBarrier: {
      establish:
        overrides.establish ?? (async () => ({ established: true as const, fencingToken: token })),
    },
    clock: { nowMs: () => 1 },
    runtime: new RequestRuntime(),
    resultRetention: {
      expireAvailableResults:
        overrides.expireResults ?? (async () => ({ ok: true as const, requests: [] })),
    },
    requestRetention: {
      collectRequestRetention: async () => ({
        ok: true as const,
        deletedRequests: 0,
        deletedRateEvents: 0,
      }),
    },
    starts: { listRecoverable: async () => [] } as never,
    nativeStart: { reconcileRootSession: async () => "unknown" } as never,
  } as CommunicatorStartupRecoveryPorts;
}

function startupInput(abort = new AbortController().signal) {
  return {
    workspaceKey,
    abort,
    deadlineMs: 100,
    limit: 10,
    timers: { set: () => 1, clear() {} },
    startupTimers: { set: () => 1, clear() {} },
    nowMonotonicMs: () => 1,
  };
}

test("maps participant deletion candidate reconciliation failures before native recovery", async () => {
  for (const [candidate, expected] of [
    [{ ok: false, code: "ownership_lost" }, "ownership_lost"],
    [{ ok: false, code: "storage_unavailable" }, "storage_unavailable"],
    [{ ok: true, sessionIds: "malformed" }, "storage_unavailable"],
  ] as const) {
    const ports = startupPorts();
    const result = await recoverCommunicatorStartup(
      {
        ...ports,
        requests: {
          ...ports.requests,
          listParticipantDeletionCandidates: async () => candidate as never,
        },
      },
      startupInput(),
    );
    expect(result).toMatchObject({ ok: false, error: { code: expected } });
  }
});

test("startup acquisition maps ownership and private adapter faults", async () => {
  for (const cause of [new OwnershipLostFault("stale lease"), new Error("private store failure")]) {
    const result = await recoverCommunicatorStartup(
      startupPorts({
        acquire: async () => {
          throw cause;
        },
      }),
      startupInput(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      },
    });
  }
});

test("startup abort races bound ownership acquisition and barrier establishment", async () => {
  const acquiring = new AbortController();
  expect(
    await recoverCommunicatorStartup(
      startupPorts({
        acquire: () => {
          acquiring.abort();
          return new Promise(() => undefined);
        },
      }),
      startupInput(acquiring.signal),
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });

  const establishing = new AbortController();
  expect(
    await recoverCommunicatorStartup(
      startupPorts({
        establish: () => {
          establishing.abort();
          return new Promise(() => undefined);
        },
      }),
      startupInput(establishing.signal),
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});

test("startup rejects malformed barriers and failed maintenance hygiene", async () => {
  expect(
    await recoverCommunicatorStartup(
      startupPorts({ establish: async () => ({ established: true, fencingToken: 999 }) }),
      startupInput(),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  expect(
    await recoverCommunicatorStartup(
      startupPorts({
        expireResults: async () => ({ ok: false, code: "storage_unavailable" }),
      }),
      startupInput(),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});

test("startup fails closed on malformed delivery-retention port results", async () => {
  for (const returned of [
    null,
    { ok: true, deletedDeliveries: -1, deletedRateEvents: 0 },
    { ok: true, deletedDeliveries: 0, deletedRateEvents: 0, extra: true },
  ]) {
    expect(
      await recoverCommunicatorStartup(
        startupPorts({ retainDeliveries: async () => returned }),
        startupInput(),
      ),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  }
});

test("startup ownership verification distinguishes phase and final-check failures", async () => {
  expect(
    await recoverCommunicatorStartup(
      startupPorts({
        current: async () => {
          throw new Error("phase ownership unavailable");
        },
      }),
      startupInput(),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  for (const cause of [new OwnershipLostFault("lease replaced"), new Error("final read failed")]) {
    let checks = 0;
    const result = await recoverCommunicatorStartup(
      startupPorts({
        current: async () => {
          checks += 1;
          if (checks === 3) throw cause;
          return true;
        },
      }),
      startupInput(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      },
    });
  }
});

test("startup fails closed when the wall clock reaches its deadline during scheduler readiness", async () => {
  let now = 1;
  const ports = startupPorts({
    readDeadline: async () => {
      now = 100;
      return { storeObservedAtMs: 1, maximumSleepMs: 10 };
    },
  });
  ports.clock.nowMs = () => now;
  expect(await recoverCommunicatorStartup(ports, startupInput())).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });
});

test("startup contains a final ownership-check abort race", async () => {
  const controller = new AbortController();
  let checks = 0;
  expect(
    await recoverCommunicatorStartup(
      startupPorts({
        current: () => {
          checks += 1;
          if (checks === 3) {
            controller.abort();
            return new Promise(() => undefined);
          }
          return Promise.resolve(true);
        },
      }),
      startupInput(controller.signal),
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});

test("startup rejects an already-fired deadline even when injected cleanup throws", async () => {
  let now = 1;
  const ports = startupPorts();
  ports.clock.nowMs = () => now;
  const hostileSignal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {
      throw new Error("listener cleanup failed");
    },
  } as unknown as AbortSignal;
  const result = await recoverCommunicatorStartup(ports, {
    ...startupInput(hostileSignal),
    startupTimers: {
      set(_delay: number, callback: () => void) {
        now = 100;
        callback();
        return 1;
      },
      clear() {},
    },
  });
  expect(result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
});
