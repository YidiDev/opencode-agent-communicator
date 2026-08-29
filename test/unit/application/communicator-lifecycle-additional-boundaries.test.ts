import { describe, expect, test } from "bun:test";

import { startReadyLifecycle } from "../../../src/application/communicator-ready-lifecycle";
import {
  CommunicatorStartupRecoveryLifecycle,
  type CommunicatorStartupRecoverySummary,
  markCommunicatorLifecycleReady,
} from "../../../src/application/communicator-startup-lifecycle";
import type { CommunicatorStartupRecoveryPorts } from "../../../src/application/communicator-startup-types";
import { recoverCommunicatorStartup } from "../../../src/application/recover-communicator-startup";
import {
  RequestDeadlineScheduler,
  RequestDeadlineSchedulerFault,
} from "../../../src/application/request-deadline-scheduler";
import { RequestRuntime } from "../../../src/application/request-runtime";
import type { StartLimits } from "../../../src/application/session-start-ports";
import { OwnershipLostFault, validateFencingToken } from "../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const token = value(validateFencingToken(25));
const workspaceKey = value(validateWorkspaceKey("workspace:lifecycle-additional"));
const summary: CommunicatorStartupRecoverySummary = {
  participantDeletionCandidates: 0,
  participantDeletionsObserved: 0,
  participantDeletionUnknown: 0,
  participantRequestsTerminalized: 0,
  staleMessages: 0,
  staleRequests: 0,
  preparedStartsAwaitingApproval: 0,
  startCreationOutcomesUnknown: 0,
  startTitleOutcomesUnknown: 0,
  startAdmissionsUnknown: 0,
  dueRequestsBeforePrepared: 0,
  preparedMessagesSubmitted: 0,
  preparedMessagesCancelled: 0,
  preparedRequestsObserved: 0,
  preparedRequestsSubmitted: 0,
  preparedRequestsSkipped: 0,
  requestsTerminalizedAtClaim: 0,
  dueRequestsAfterPrepared: 0,
  expiredResults: 0,
  retainedRequestsDeleted: 0,
  retainedRateEventsDeleted: 0,
  retainedStartOperationsDeleted: 0,
  retainedStartRateEventsDeleted: 0,
  retainedDeliveriesDeleted: 0,
  retainedDeliveryRateEventsDeleted: 0,
};

function startupPorts(): CommunicatorStartupRecoveryPorts {
  return {
    membership: {
      readCurrentRoots: async () => ({
        sourceTitle: "source",
        sourceVisible: true,
        targetVisible: true,
      }),
    },
    deliveries: {
      listRecoverable: async () => [],
      garbageCollectMetadata: async () => ({
        ok: true,
        deletedDeliveries: 0,
        deletedRateEvents: 0,
      }),
    } as never,
    nativeQueue: { queueMessage: async () => ({ kind: "unknown" }) },
    requests: {
      listParticipantDeletionCandidates: async () => ({ ok: true, sessionIds: [] }),
      deleteAbsentParticipantRequests: async () => ({ ok: true, terminalized: [] }),
      listRecoverableRequests: async () => [],
      expireDueRequests: async () => ({ ok: true, requests: [] }),
      readNextPendingDeadline: async () => ({ storeObservedAtMs: 1, maximumSleepMs: 10 }),
    } as never,
    participantPresence: { readParticipantPresence: async () => "present" },
    activity: {
      observeRequestParticipants: async () => ({
        sourceVisible: true,
        targetVisible: true,
        targetStatus: "idle",
      }),
    },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" }) },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    startupBarrier: {
      establish: async () => ({ established: true as const, fencingToken: token }),
    },
    clock: { nowMs: () => 1 },
    runtime: new RequestRuntime(),
    resultRetention: {
      expireAvailableResults: async () => ({ ok: true as const, requests: [] }),
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

function input(abort = new AbortController().signal) {
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

describe("communicator lifecycle state machine", () => {
  test("enforces ready authority and makes stop idempotent", () => {
    const stops: string[] = [];
    const scheduler = {
      fault: undefined,
      stop: () => stops.push("scheduler"),
    } as never;
    const runtime = { stop: (reason: string) => stops.push(`runtime:${reason}`) } as never;
    const lifecycle = new CommunicatorStartupRecoveryLifecycle(token, scheduler, summary, runtime);
    expect(lifecycle.status).toBe("starting");
    expect(() => lifecycle.assertReady()).toThrow("not ready");
    expect(() => lifecycle.markReady(Symbol("forged"))).toThrow(
      "Invalid lifecycle ready authority",
    );
    markCommunicatorLifecycleReady(lifecycle);
    expect(lifecycle.status).toBe("ready");
    lifecycle.stop("shutdown", new RequestDeadlineSchedulerFault("storage_failure"));
    lifecycle.stop("ownership_lost");
    markCommunicatorLifecycleReady(lifecycle);
    expect(lifecycle.status).toBe("stopped");
    expect(lifecycle.schedulerFault?.code).toBe("storage_failure");
    expect(stops).toEqual(["scheduler", "runtime:shutdown"]);
  });

  test("reads a scheduler fault when no explicit lifecycle fault was supplied", () => {
    const fault = new RequestDeadlineSchedulerFault("ownership_lost");
    const lifecycle = new CommunicatorStartupRecoveryLifecycle(
      token,
      { fault, stop() {} } as never,
      summary,
      { stop() {} } as never,
    );
    expect(lifecycle.schedulerFault).toBe(fault);
  });

  test("exposes the runtime effect signal for lifecycle-owned work", () => {
    const effects = new AbortController();
    const lifecycle = new CommunicatorStartupRecoveryLifecycle(
      token,
      { stop() {} } as never,
      summary,
      { effectSignal: effects.signal, stop() {} } as never,
    );
    expect(lifecycle.effectSignal).toBe(effects.signal);
  });

  test("stops the ready lifecycle when an ordinary workflow reports ownership loss", () => {
    const stops: string[] = [];
    const lifecycle = new CommunicatorStartupRecoveryLifecycle(
      token,
      { stop: () => stops.push("scheduler") } as never,
      summary,
      { stop: (reason: string) => stops.push(`runtime:${reason}`) } as never,
    );
    markCommunicatorLifecycleReady(lifecycle);

    lifecycle.ownershipLost();

    expect(lifecycle.status).toBe("stopped");
    expect(lifecycle.stopReason).toBe("ownership_lost");
    expect(stops).toEqual(["scheduler", "runtime:ownership_lost"]);
  });
});

describe("communicator readiness commit boundary", () => {
  test("maps initial scheduler storage failure and final ownership loss", async () => {
    const storage = startupPorts();
    storage.requests.expireDueRequests = async () => ({ ok: false, code: "storage_unavailable" });
    expect(
      await startReadyLifecycle(storage, input(), token, summary, new AbortController().signal),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

    const lost = startupPorts();
    lost.ownership.isCurrent = async () => false;
    expect(
      await startReadyLifecycle(lost, input(), token, summary, new AbortController().signal),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });

  test("distinguishes ownership and storage rejection at the final readiness fence", async () => {
    for (const cause of [new OwnershipLostFault("fenced"), new Error("ownership store")]) {
      const ports = startupPorts();
      ports.ownership.isCurrent = async () => {
        throw cause;
      };
      expect(
        await startReadyLifecycle(ports, input(), token, summary, new AbortController().signal),
      ).toMatchObject({
        ok: false,
        error: {
          code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
        },
      });
    }
  });

  test("fails the final commit when the wall clock becomes malformed after ownership verification", async () => {
    const ports = startupPorts();
    let now = 1;
    ports.clock.nowMs = () => now;
    ports.ownership.isCurrent = async () => {
      now = Number.NaN;
      return true;
    };
    expect(
      await startReadyLifecycle(ports, input(), token, summary, new AbortController().signal),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });

  test("stops a pending initial scheduler pump when caller control is interrupted", async () => {
    const ports = startupPorts();
    const controller = new AbortController();
    ports.requests.expireDueRequests = () => {
      controller.abort();
      return new Promise(() => undefined);
    };
    expect(
      await startReadyLifecycle(ports, input(controller.signal), token, summary, controller.signal),
    ).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });
  });

  test("contains an unexpected scheduler readiness rejection", async () => {
    const original = RequestDeadlineScheduler.prototype.startAndWaitReady;
    RequestDeadlineScheduler.prototype.startAndWaitReady = async () => {
      throw new Error("scheduler readiness rejected");
    };
    try {
      expect(
        await startReadyLifecycle(
          startupPorts(),
          input(),
          token,
          summary,
          new AbortController().signal,
        ),
      ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    } finally {
      RequestDeadlineScheduler.prototype.startAndWaitReady = original;
    }
  });

  test("supports native scheduler timing when no timer adapter is injected", async () => {
    const ports = startupPorts();
    const { timers: _timers, nowMonotonicMs: _nowMonotonicMs, ...nativeInput } = input();
    const result = await startReadyLifecycle(
      ports,
      nativeInput,
      token,
      summary,
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (result.ok) result.value.stop("shutdown");
  });

  test("fails the final readiness commit if the ready scheduler loses ownership", async () => {
    const ports = startupPorts();
    let expiryCalls = 0;
    let timerCallback: (() => void) | undefined;
    ports.requests.expireDueRequests = async () => {
      expiryCalls += 1;
      return expiryCalls === 1 ? { ok: true, requests: [] } : { ok: false, code: "ownership_lost" };
    };
    ports.ownership.isCurrent = async () => {
      timerCallback?.();
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      return true;
    };
    const schedulerInput = {
      ...input(),
      timers: {
        set(_delay: number, callback: () => void) {
          timerCallback = callback;
          return 1;
        },
        clear() {},
      },
    };
    expect(
      await startReadyLifecycle(
        ports,
        schedulerInput,
        token,
        summary,
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });
});

describe("communicator startup phase crash boundaries", () => {
  test("stops immediately when stale delivery or request classification fails", async () => {
    const deliveryFailure = startupPorts();
    deliveryFailure.deliveries.listRecoverable = async () => {
      throw new Error("delivery list");
    };
    expect(await recoverCommunicatorStartup(deliveryFailure, input())).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    const requestFailure = startupPorts();
    requestFailure.requests.listRecoverableRequests = async () => {
      throw new Error("request list");
    };
    expect(await recoverCommunicatorStartup(requestFailure, input())).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
  });

  test("contains start recovery and rejected barrier exceptions", async () => {
    const starts = startupPorts();
    starts.starts.listRecoverable = async () => {
      throw new Error("start recovery");
    };
    expect(await recoverCommunicatorStartup(starts, input())).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    const barrier = startupPorts();
    barrier.startupBarrier.establish = async () => {
      throw new OwnershipLostFault("barrier fenced");
    };
    expect(await recoverCommunicatorStartup(barrier, input())).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });
  });

  test("stops for a failed due-request phase and control expiry after start recovery", async () => {
    const due = startupPorts();
    due.requests.expireDueRequests = async () => ({ ok: false, code: "storage_unavailable" });
    expect(await recoverCommunicatorStartup(due, input())).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    let now = 1;
    const expired = startupPorts();
    expired.clock.nowMs = () => now;
    expired.starts.listRecoverable = async () => {
      now = 100;
      return [];
    };
    expect(await recoverCommunicatorStartup(expired, input())).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });
  });

  test("stops at prepared-message, prepared-request, and second due-request failures", async () => {
    const messages = startupPorts();
    messages.deliveries.listRecoverable = async (query) => {
      if (query.state === "prepared") throw new Error("prepared messages");
      return [];
    };
    expect(await recoverCommunicatorStartup(messages, input())).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    const requests = startupPorts();
    requests.requests.listRecoverableRequests = async (query) => {
      if (query.state === "prepared") throw new Error("prepared requests");
      return [];
    };
    expect(await recoverCommunicatorStartup(requests, input())).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    const due = startupPorts();
    let expiryCalls = 0;
    due.requests.expireDueRequests = async () => {
      expiryCalls += 1;
      return expiryCalls === 1
        ? { ok: true, requests: [] }
        : { ok: false, code: "storage_unavailable" };
    };
    expect(await recoverCommunicatorStartup(due, input())).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
  });

  test("rechecks control and ownership after maintenance hygiene", async () => {
    let now = 1;
    const stopped = startupPorts();
    stopped.clock.nowMs = () => now;
    stopped.requestRetention.collectRequestRetention = async () => {
      now = 100;
      return { ok: true, deletedRequests: 0, deletedRateEvents: 0 };
    };
    expect(await recoverCommunicatorStartup(stopped, input())).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });

    const lost = startupPorts();
    let ownershipReads = 0;
    lost.ownership.isCurrent = async () => {
      ownershipReads += 1;
      return ownershipReads === 1;
    };
    expect(await recoverCommunicatorStartup(lost, input())).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });
  });

  test("does not expose a lifecycle when scheduler readiness fails after all recovery phases", async () => {
    const ports = startupPorts();
    ports.requests.readNextPendingDeadline = async () => ({ malformed: true }) as never;
    expect(await recoverCommunicatorStartup(ports, input())).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
  });

  test("runs bounded start retention during startup and recurring scheduler readiness", async () => {
    const ports = startupPorts();
    const startLimits: StartLimits = {
      managedSessionsPerWorkspace: 64,
      unresolvedProvenancePerWorkspace: 16,
      operationsPerWorkspace: 4_096,
      payloadBytesPerWorkspace: 8 * 1_024 * 1_024,
      startsPerSourceWindow: 5,
      startsPerWorkspaceWindow: 25,
      rateWindowMs: 60_000,
      terminalRetentionMs: 86_400_000,
    };
    (ports as { startLimits: StartLimits }).startLimits = startLimits;
    let collections = 0;
    ports.starts.collectRetention = async () => {
      collections += 1;
      return {
        ok: true,
        deletedOperations: collections === 1 ? 3 : 0,
        deletedRateEvents: collections === 1 ? 2 : 0,
      };
    };
    const recovered = await recoverCommunicatorStartup(ports, input());
    expect(recovered).toMatchObject({
      ok: true,
      value: {
        summary: {
          retainedStartOperationsDeleted: 3,
          retainedStartRateEventsDeleted: 2,
        },
      },
    });
    expect(collections).toBeGreaterThanOrEqual(2);
    if (recovered.ok) recovered.value.stop("shutdown");
  });
});
