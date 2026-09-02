import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { startReadyLifecycle } from "../../../src/application/communicator-ready-lifecycle";
import type { CommunicatorStartupRecoverySummary } from "../../../src/application/communicator-startup-lifecycle";
import type {
  CommunicatorStartupRecoveryInput,
  CommunicatorStartupRecoveryPorts,
} from "../../../src/application/communicator-startup-types";
import { RequestRuntime } from "../../../src/application/request-runtime";
import { ActiveInvocationRegistry } from "../../../src/composition/active-invocations";
import {
  type CommunicatorGenerationHandle,
  CommunicatorGenerationManager,
} from "../../../src/composition/communicator-generation-manager";
import { validateFencingToken } from "../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const fencingToken = value(validateFencingToken(8));
const workspaceKey = value(validateWorkspaceKey("workspace:ready-failure"));
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

function generation(
  token: number,
  options: {
    stopped?: boolean;
    cause?: "ownership_lost" | "storage_failure" | "contract_fault";
    takeoverDelayMs?: number;
  } = {},
): CommunicatorGenerationHandle {
  const invocations = new ActiveInvocationRegistry();
  const cause = options.cause ?? "ownership_lost";
  const diagnostic =
    cause === "ownership_lost"
      ? "Communicator ownership ended."
      : cause === "storage_failure"
        ? "Communicator storage became unavailable."
        : "A communicator port contract failed.";
  const lifecycle = {
    fencingToken: token,
    status: options.stopped ? "stopped" : "ready",
    stopState: options.stopped
      ? {
          cause,
          reason: "ownership_lost",
          recoverable: cause === "ownership_lost",
          diagnostic,
        }
      : undefined,
  };
  return {
    lifecycle: lifecycle as never,
    invocations,
    fencingToken: token as never,
    contracts: {
      session_list: {
        description: "fixture",
        args: z.object({}).strict(),
        execute: async () => `generation-${token}`,
      },
    } as never,
    event: async () => undefined,
    chat: async () => undefined,
    quiesce() {
      invocations.closeAdmission("ownership_lost");
    },
    async drainInvocations() {
      return invocations.drain();
    },
    settleInvocations: () => invocations.settled(),
    ownershipTakeoverDelayMs: () => options.takeoverDelayMs ?? 0,
    shutdownUnpublished() {
      if (lifecycle.status === "ready") {
        lifecycle.status = "stopped";
        lifecycle.stopState = {
          cause: "contract_fault",
          reason: "shutdown",
          recoverable: false,
          diagnostic: "A communicator port contract failed.",
        };
      }
      invocations.closeAdmission("unpublished_shutdown");
    },
    async disposeResources() {},
  };
}

test("readiness reports an initial scheduler ownership fault and stops its runtime", async () => {
  const runtime = new RequestRuntime();
  const ports = {
    requests: {
      async expireDueRequests() {
        return { ok: false as const, code: "ownership_lost" as const };
      },
      async readNextPendingDeadline() {
        throw new Error("must not schedule after expiry fault");
      },
    },
    runtime,
    ownership: { acquire: async () => fencingToken, isCurrent: async () => true },
    clock: { nowMs: () => 1 },
    resultRetention: {},
    requestRetention: {},
  } as unknown as CommunicatorStartupRecoveryPorts;
  const input = {
    workspaceKey,
    abort: new AbortController().signal,
    deadlineMs: 100,
    limit: 100,
    timers: { set: () => 1, clear() {} },
    nowMonotonicMs: () => 1,
  } satisfies CommunicatorStartupRecoveryInput;

  const result = await startReadyLifecycle(ports, input, fencingToken, summary, input.abort);
  expect(result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});

describe("communicator readiness cause classification", () => {
  function createManager(
    initial: CommunicatorGenerationHandle,
    create: () => Promise<CommunicatorGenerationHandle>,
  ) {
    return new CommunicatorGenerationManager(
      initial,
      create,
      { nowMs: () => 1_000, wait: async () => "completed" },
      1_000,
    );
  }

  function invoke(manager: CommunicatorGenerationManager): Promise<string> {
    return manager.invoke(
      "session_list",
      new AbortController().signal,
      (contract, context) => contract.execute({}, context),
      { sessionID: "session", messageID: "message", ask: async () => undefined },
    );
  }

  test("recovers when lifecycle stopped with ownership_lost", async () => {
    const stale = generation(1, { stopped: true, cause: "ownership_lost" });
    let builds = 0;
    const manager = createManager(stale, async () => {
      builds += 1;
      return generation(2);
    });

    await invoke(manager);
    expect({ builds, state: manager.state }).toEqual({ builds: 1, state: "active" });
    expect(manager.terminalState).toBeUndefined();
  });

  test("recovers from a contract_fault stop when the expired lease is free to retake", async () => {
    const stale = generation(1, {
      stopped: true,
      cause: "contract_fault",
      takeoverDelayMs: 0,
    });
    let builds = 0;
    const manager = createManager(stale, async () => {
      builds += 1;
      return generation(2);
    });

    await invoke(manager);
    expect({ builds, state: manager.state }).toEqual({ builds: 1, state: "active" });
    expect(manager.terminalState).toBeUndefined();
  });

  test("keeps a contract_fault terminal while another host still holds the lease", async () => {
    const stale = generation(1, {
      stopped: true,
      cause: "contract_fault",
      takeoverDelayMs: 500,
    });
    let builds = 0;
    const manager = createManager(stale, async () => {
      builds += 1;
      return generation(2);
    });

    await expect(invoke(manager)).rejects.toThrow("A communicator port contract failed.");
    expect({ builds, state: manager.state }).toEqual({ builds: 0, state: "failed" });
    expect(manager.terminalState?.classification).toBe("contract_fault");
  });
});
