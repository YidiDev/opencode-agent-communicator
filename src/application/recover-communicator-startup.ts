import type { FencingToken } from "../domain/ownership";
import { OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import { validateWorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { startReadyLifecycle } from "./communicator-ready-lifecycle";
import type { CommunicatorStartupRecoveryLifecycle } from "./communicator-startup-lifecycle";
import { runCommunicatorStartupPhases } from "./communicator-startup-phases";
import type {
  CommunicatorStartupRecoveryInput,
  CommunicatorStartupRecoveryPorts,
} from "./communicator-startup-types";
import { inspectStartupBarrier } from "./message-recovery-boundaries";
import type { RequestRuntimeStopReason } from "./request-runtime";
import { readSafeClockMs } from "./safe-clock";
import { createLinkedStartupEffectControl } from "./startup-effect-control";

export {
  CommunicatorStartupRecoveryLifecycle,
  type CommunicatorStartupRecoverySummary,
} from "./communicator-startup-lifecycle";

export type {
  CommunicatorStartupRecoveryInput,
  CommunicatorStartupRecoveryPorts,
} from "./communicator-startup-types";

function startupFailure(
  code: "ownership_lost" | "storage_unavailable",
  message: string,
): DomainResult<never> {
  return domainFailure(code, message, code === "storage_unavailable");
}

function stopForFailure(
  ports: CommunicatorStartupRecoveryPorts,
  result: DomainResult<never>,
): DomainResult<never> {
  const reason: RequestRuntimeStopReason =
    !result.ok && result.error.code === "ownership_lost" ? "ownership_lost" : "shutdown";
  ports.runtime.stop(reason);
  return result;
}

function validStartupInput(
  ports: CommunicatorStartupRecoveryPorts,
  input: CommunicatorStartupRecoveryInput,
): boolean {
  if (
    !validateWorkspaceKey(input.workspaceKey).ok ||
    typeof input.abort !== "object" ||
    input.abort === null ||
    typeof input.abort.aborted !== "boolean" ||
    !Number.isSafeInteger(input.deadlineMs) ||
    input.deadlineMs < 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    return false;
  }
  const now = readSafeClockMs(ports.clock);
  return !input.abort.aborted && now !== undefined && now < input.deadlineMs;
}

async function verifyStartupOwnership(
  ports: CommunicatorStartupRecoveryPorts,
  fencingToken: FencingToken,
  signal: AbortSignal,
): Promise<DomainResult<undefined>> {
  const current = await runUntilAborted(signal, () => ports.ownership.isCurrent(fencingToken));
  if (current.kind === "aborted" || (current.kind === "settled" && current.value !== true)) {
    return startupFailure("ownership_lost", "Startup ownership was lost.");
  }
  if (current.kind === "rejected") {
    return startupFailure(
      current.cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
      current.cause instanceof OwnershipLostFault
        ? "Startup ownership was lost."
        : "Startup ownership verification failed.",
    );
  }
  return { ok: true, value: undefined };
}

export async function recoverCommunicatorStartup(
  ports: CommunicatorStartupRecoveryPorts,
  input: CommunicatorStartupRecoveryInput,
): Promise<DomainResult<CommunicatorStartupRecoveryLifecycle>> {
  if (!validStartupInput(ports, input)) {
    return stopForFailure(
      ports,
      domainFailure("invalid_arguments", "Startup recovery control is invalid.", false),
    );
  }
  const effectControl = createLinkedStartupEffectControl({
    caller: input.abort,
    runtime: ports.runtime.effectSignal,
    deadlineMs: input.deadlineMs,
    clock: ports.clock,
    ...(input.startupTimers ? { timers: input.startupTimers } : {}),
  });
  if (!effectControl || effectControl.signal.aborted) {
    try {
      effectControl?.dispose();
    } catch {
      // Invalid injected timer cleanup fails startup closed.
    }
    return stopForFailure(
      ports,
      domainFailure("invalid_arguments", "Startup deadline timer is invalid.", false),
    );
  }
  let lifecycle: CommunicatorStartupRecoveryLifecycle | undefined;
  const stop = (result: DomainResult<never>): DomainResult<never> => {
    const reason: RequestRuntimeStopReason =
      !result.ok && result.error.code === "ownership_lost" ? "ownership_lost" : "shutdown";
    if (lifecycle) lifecycle.stop(reason);
    else {
      ports.runtime.stop(reason);
    }
    return result;
  };
  try {
    const acquired = await runUntilAborted(effectControl.signal, () => ports.ownership.acquire());
    if (acquired.kind === "aborted") {
      return stop(
        startupFailure("ownership_lost", "Startup ownership acquisition was interrupted."),
      );
    }
    if (acquired.kind === "rejected") throw acquired.cause;
    const fencingToken = acquired.value;
    const established = await runUntilAborted(effectControl.signal, () =>
      ports.startupBarrier.establish(fencingToken, {
        abort: effectControl.signal,
        deadlineMs: input.deadlineMs,
      }),
    );
    if (established.kind === "aborted") {
      return stop(
        startupFailure("ownership_lost", "Startup barrier establishment was interrupted."),
      );
    }
    if (established.kind === "rejected") throw established.cause;
    const startupBarrier = inspectStartupBarrier(established.value, fencingToken);
    if (!startupBarrier) {
      return stop(startupFailure("storage_unavailable", "Startup barrier was malformed."));
    }
    const phases = await runCommunicatorStartupPhases(
      ports,
      input,
      fencingToken,
      startupBarrier,
      effectControl.signal,
      () => verifyStartupOwnership(ports, fencingToken, effectControl.signal),
    );
    if (!phases.ok) return stop(phases);
    const summary = phases.value;
    // This readiness boundary is also the creation gate: ordinary request creation must not be
    // exposed until the returned lifecycle exists, preventing inserts behind recovery keysets.
    const ready = await startReadyLifecycle(
      ports,
      input,
      fencingToken,
      summary,
      effectControl.signal,
    );
    if (!ready.ok) return ready;
    lifecycle = ready.value;
    effectControl.dispose();
    return ready;
  } catch (cause: unknown) {
    return stop(
      startupFailure(
        cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
        cause instanceof OwnershipLostFault
          ? "Startup ownership was lost."
          : "Communicator startup recovery failed.",
      ),
    );
  } finally {
    try {
      effectControl.dispose();
    } catch {
      // Composition owns the store; callers must close it after failure to release its lease.
    }
  }
}
