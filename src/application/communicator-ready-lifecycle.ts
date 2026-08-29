import type { FencingToken } from "../domain/ownership";
import { OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import { runUntilAborted } from "./abortable-operation";
import {
  CommunicatorStartupRecoveryLifecycle,
  type CommunicatorStartupRecoverySummary,
  markCommunicatorLifecycleReady,
} from "./communicator-startup-lifecycle";
import type {
  CommunicatorStartupRecoveryInput,
  CommunicatorStartupRecoveryPorts,
} from "./communicator-startup-types";
import {
  RequestDeadlineScheduler,
  type RequestDeadlineSchedulerFault,
} from "./request-deadline-scheduler";
import { readSafeClockMs } from "./safe-clock";
import { drainStartMaintenance } from "./start-maintenance";

function startupFailure(
  code: "ownership_lost" | "storage_unavailable",
  message: string,
): DomainResult<never> {
  return domainFailure(code, message, code === "storage_unavailable");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: scheduler settlement and the final abort, clock, and ownership race checks form one readiness commit boundary.
export async function startReadyLifecycle(
  ports: CommunicatorStartupRecoveryPorts,
  input: CommunicatorStartupRecoveryInput,
  fencingToken: FencingToken,
  summary: Readonly<CommunicatorStartupRecoverySummary>,
  signal: AbortSignal,
): Promise<DomainResult<CommunicatorStartupRecoveryLifecycle>> {
  let lifecycle: CommunicatorStartupRecoveryLifecycle | undefined;
  const scheduler = new RequestDeadlineScheduler({
    requests: ports.requests,
    ...(ports.locks ? { locks: ports.locks } : {}),
    notifications: ports.runtime,
    fencingToken,
    workspaceKey: input.workspaceKey,
    maintenance: {
      resultRetention: ports.resultRetention,
      requestRetention: ports.requestRetention,
    },
    ...(ports.startLimits
      ? {
          additionalMaintenance: (shouldStop: () => boolean, abort: AbortSignal) =>
            drainStartMaintenance({
              starts: ports.starts,
              limits: ports.startLimits as NonNullable<typeof ports.startLimits>,
              fencingToken,
              workspaceKey: input.workspaceKey,
              nowMs: ports.clock.nowMs(),
              shouldStop,
              abort,
            }),
        }
      : {}),
    deliveryRetention: ports.deliveries,
    ...(input.timers ? { timers: input.timers } : {}),
    ...(input.nowMonotonicMs ? { nowMonotonicMs: input.nowMonotonicMs } : {}),
    onFault: (fault: RequestDeadlineSchedulerFault) => {
      lifecycle?.stop(fault.code === "ownership_lost" ? "ownership_lost" : "shutdown", fault);
      return undefined;
    },
  });
  lifecycle = new CommunicatorStartupRecoveryLifecycle(
    fencingToken,
    scheduler,
    summary,
    ports.runtime,
  );
  const readiness = await runUntilAborted(signal, () => scheduler.startAndWaitReady());
  if (readiness.kind === "aborted") {
    const fault = scheduler.fault;
    lifecycle.stop(fault?.code === "ownership_lost" ? "ownership_lost" : "shutdown", fault);
    return fault
      ? startupFailure(
          fault.code === "ownership_lost" ? "ownership_lost" : "storage_unavailable",
          "Request deadline scheduler failed initial readiness.",
        )
      : startupFailure("ownership_lost", "Startup scheduler readiness was interrupted.");
  }
  if (readiness.kind === "rejected") {
    lifecycle.stop("shutdown", scheduler.fault);
    return startupFailure("storage_unavailable", "Request deadline scheduler readiness rejected.");
  }
  if (!readiness.value.ok) {
    const fault = readiness.value.fault;
    lifecycle.stop(fault.code === "ownership_lost" ? "ownership_lost" : "shutdown", fault);
    return startupFailure(
      fault.code === "ownership_lost" ? "ownership_lost" : "storage_unavailable",
      "Request deadline scheduler failed initial readiness.",
    );
  }
  const nowMs = readSafeClockMs(ports.clock);
  if (signal.aborted || nowMs === undefined || nowMs >= input.deadlineMs) {
    lifecycle.stop("ownership_lost", scheduler.fault);
    return startupFailure("ownership_lost", "Startup readiness was interrupted.");
  }
  const finalOwnership = await runUntilAborted(signal, () =>
    ports.ownership.isCurrent(fencingToken),
  );
  if (finalOwnership.kind === "aborted") {
    const fault = scheduler.fault;
    lifecycle.stop(
      fault?.code === "ownership_lost" ? "ownership_lost" : fault ? "shutdown" : "ownership_lost",
      fault,
    );
    return fault
      ? startupFailure(
          fault.code === "ownership_lost" ? "ownership_lost" : "storage_unavailable",
          "Request deadline scheduler lost readiness.",
        )
      : startupFailure("ownership_lost", "Startup readiness was interrupted.");
  }
  if (finalOwnership.kind === "rejected") {
    const ownershipLost = finalOwnership.cause instanceof OwnershipLostFault;
    lifecycle.stop(ownershipLost ? "ownership_lost" : "shutdown", scheduler.fault);
    return startupFailure(
      ownershipLost ? "ownership_lost" : "storage_unavailable",
      ownershipLost
        ? "Startup ownership was lost."
        : "Startup final ownership verification failed.",
    );
  }
  if (finalOwnership.value !== true) {
    lifecycle.stop("ownership_lost", scheduler.fault);
    return startupFailure("ownership_lost", "Startup ownership was lost.");
  }
  const finalNowMs = readSafeClockMs(ports.clock);
  const schedulerFault = scheduler.fault;
  if (
    signal.aborted ||
    finalNowMs === undefined ||
    finalNowMs >= input.deadlineMs ||
    scheduler.status !== "ready" ||
    schedulerFault !== undefined ||
    lifecycle.status !== "starting"
  ) {
    const storageFault = schedulerFault !== undefined || scheduler.status === "faulted";
    lifecycle.stop(
      schedulerFault?.code === "ownership_lost"
        ? "ownership_lost"
        : storageFault
          ? "shutdown"
          : "ownership_lost",
      schedulerFault,
    );
    return startupFailure(
      schedulerFault?.code === "ownership_lost"
        ? "ownership_lost"
        : storageFault
          ? "storage_unavailable"
          : "ownership_lost",
      storageFault
        ? "Request deadline scheduler lost readiness."
        : "Startup readiness was interrupted.",
    );
  }
  markCommunicatorLifecycleReady(lifecycle);
  return { ok: true, value: lifecycle };
}
