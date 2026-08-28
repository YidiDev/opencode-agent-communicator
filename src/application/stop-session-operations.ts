import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { pendingRequestsPerWorkspaceHardCeiling } from "../domain/safety-ceilings";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { boundedExternalCall } from "./bounded-external-call";
import type { RequestParticipantActivityObservation } from "./request-ports";
import type { SessionStopContext, SessionStopPorts, SessionStopResult } from "./stop-session-types";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

export class StopDeadlineFault extends Error {}

export async function stopExternal<Value>(
  context: SessionStopContext,
  operation: () => Promise<Value> | Value,
): Promise<Value> {
  const deadlineMs = context.deadlineMs ?? Date.now() + 3_600_000;
  const result = await boundedExternalCall(operation, context.abort, deadlineMs);
  if (result.kind === "expired") throw new StopDeadlineFault();
  if (result.kind === "rejected") throw result.cause;
  if (context.abort.aborted || Date.now() >= deadlineMs) throw new StopDeadlineFault();
  return result.value;
}

export async function observeStopParticipants(
  ports: SessionStopPorts,
  context: SessionStopContext,
  target: SessionId,
): Promise<DomainResult<RequestParticipantActivityObservation>> {
  try {
    const raw: unknown = await stopExternal(context, () =>
      ports.activity.observeRequestParticipants(
        context.workspaceKey,
        context.sourceSessionId,
        target,
        context.abort,
      ),
    );
    const value = snapshotDataRecord(raw, 3);
    const targetStatus =
      value?.targetStatus === "busy" ||
      value?.targetStatus === "retry" ||
      value?.targetStatus === "idle" ||
      value?.targetStatus === "unknown"
        ? value.targetStatus
        : undefined;
    if (
      !value ||
      Object.keys(value).length !== 3 ||
      typeof value.sourceVisible !== "boolean" ||
      typeof value.targetVisible !== "boolean" ||
      targetStatus === undefined
    ) {
      return domainFailure("native_unavailable", "Current session state is unavailable.", true);
    }
    return {
      ok: true,
      value: {
        sourceVisible: value.sourceVisible,
        targetVisible: value.targetVisible,
        targetStatus,
      },
    };
  } catch (cause: unknown) {
    if (cause instanceof StopDeadlineFault) throw cause;
    return cause instanceof OwnershipLostFault
      ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
      : domainFailure("native_unavailable", "Current session state is unavailable.", true);
  }
}

export function stopVisibilityFailure(
  observation: RequestParticipantActivityObservation,
): DomainResult<never> | undefined {
  if (!observation.sourceVisible) {
    return domainFailure(
      "caller_not_visible",
      "Caller is not a current visible root session.",
      false,
    );
  }
  if (!observation.targetVisible) {
    return domainFailure(
      "target_not_visible",
      "Target is not a current visible root session.",
      false,
    );
  }
  return undefined;
}

export function communicatorStopState(
  requests: readonly RequestMetadata[],
): SessionStopResult["communicatorState"] {
  let targetStopped = 0;
  let sourceStopped = 0;
  for (const request of requests) {
    if (request.resolutionState === "target_stopped") targetStopped += 1;
    else if (request.resolutionState === "source_stopped") sourceStopped += 1;
    else throw new TypeError("Stop persistence returned a non-stop terminal state.");
  }
  return Object.freeze({
    outcome: "applied",
    requestsTerminalized: requests.length,
    targetStopped,
    sourceStopped,
  });
}

export function inspectStoppedRequests(
  raw: unknown,
  workspaceKey: WorkspaceKey,
  stoppedSessionId: SessionId,
): DomainResult<readonly RequestMetadata[]> {
  const result = snapshotDataRecord(raw, 2);
  if (!result || typeof result.ok !== "boolean") {
    return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
  }
  if (!result.ok) {
    const code = result.code;
    if (
      Object.keys(result).length !== 2 ||
      (code !== "ownership_lost" && code !== "storage_unavailable")
    ) {
      return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
    }
    return domainFailure(
      code,
      code === "ownership_lost"
        ? "Coordinator ownership was lost."
        : "Request storage is unavailable.",
      code === "storage_unavailable",
    );
  }
  if (Object.keys(result).length !== 2) {
    return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
  }
  const terminalized = snapshotDenseArray(
    result.terminalized,
    pendingRequestsPerWorkspaceHardCeiling,
  );
  if (!terminalized) {
    return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
  }
  const ids = new Set<string>();
  const validated: RequestMetadata[] = [];
  for (const request of terminalized) {
    if (
      !isCoherentRequestMetadata(request) ||
      request.workspaceKey !== workspaceKey ||
      ids.has(request.id) ||
      (request.sourceSessionId !== stoppedSessionId &&
        request.targetSessionId !== stoppedSessionId) ||
      request.resolutionState !==
        (request.targetSessionId === stoppedSessionId ? "target_stopped" : "source_stopped")
    ) {
      return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
    }
    ids.add(request.id);
    validated.push(request);
  }
  return { ok: true, value: Object.freeze(validated) };
}

function unknownNativeOutcome(state: SessionStopResult["communicatorState"]): DomainResult<never> {
  return domainFailure(
    "native_outcome_unknown",
    "Communicator state was applied, but native interruption could not be confirmed.",
    false,
    {
      communicator_state: {
        outcome: state.outcome,
        requests_terminalized: state.requestsTerminalized,
        target_stopped: state.targetStopped,
        source_stopped: state.sourceStopped,
      },
    },
  );
}

export async function applyNativeStop(
  ports: SessionStopPorts,
  context: SessionStopContext,
  target: SessionId,
  fencingToken: FencingToken,
  state: SessionStopResult["communicatorState"],
): Promise<DomainResult<SessionStopResult>> {
  const success = (
    nativeOutcome: SessionStopResult["nativeOutcome"],
  ): DomainResult<SessionStopResult> => ({
    ok: true,
    value: { sessionId: target, communicatorState: state, nativeOutcome },
  });
  try {
    const current = await observeStopParticipants(ports, context, target);
    if (!current.ok || stopVisibilityFailure(current.value)) return unknownNativeOutcome(state);
    if (current.value.targetStatus === "idle") return success("already_idle");
    if (current.value.targetStatus === "unknown") return unknownNativeOutcome(state);
    if (!(await stopExternal(context, () => ports.ownership.isCurrent(fencingToken)))) {
      return unknownNativeOutcome(state);
    }
    const native = await stopExternal(context, () =>
      ports.nativeInterrupt.interruptSession({ targetSessionId: target, abort: context.abort }),
    );
    if (
      native !== "interrupted" ||
      !(await stopExternal(context, () => ports.ownership.isCurrent(fencingToken)))
    ) {
      return unknownNativeOutcome(state);
    }
    return success("interrupted");
  } catch {
    // Durable request terminalization has committed, so later failures are partial outcomes.
    return unknownNativeOutcome(state);
  }
}
