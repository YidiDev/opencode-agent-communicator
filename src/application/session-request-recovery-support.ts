import { OwnershipLostFault, validateFencingToken } from "../domain/ownership";
import type { RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import { validateWorkspaceKey, type WorkspaceKey } from "../domain/workspaces";
import type { OperationControl } from "./delivery-ports";
import {
  type RequestStoreFailureCode,
  requestStoreFailureCodes,
  type SessionRequestRecoveryPhaseInput,
  type SessionRequestRecoveryPorts,
} from "./request-ports";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import { operationControlStopped } from "./safe-clock";

export function requestRecoveryFailure(code: RequestStoreFailureCode): DomainResult<never> {
  const message =
    code === "ownership_lost"
      ? "Coordinator ownership was lost."
      : code === "state_conflict"
        ? "Request recovery state is inconsistent."
        : "Request recovery storage is unavailable.";
  return domainFailure(code, message, code === "storage_unavailable" || code === "rate_limited");
}

export function rejectedRequestRecoveryFailure(
  cause: unknown,
  message: string,
): DomainResult<never> {
  return cause instanceof OwnershipLostFault
    ? requestRecoveryFailure("ownership_lost")
    : domainFailure("storage_unavailable", message, true);
}

export function validSessionRequestRecoveryPhaseInput(
  input: SessionRequestRecoveryPhaseInput,
): boolean {
  return (
    validateWorkspaceKey(input.workspaceKey).ok &&
    validateFencingToken(input.fencingToken).ok &&
    typeof input.abort === "object" &&
    input.abort !== null &&
    typeof input.abort.aborted === "boolean" &&
    typeof input.effectSignal === "object" &&
    input.effectSignal !== null &&
    typeof input.effectSignal.aborted === "boolean" &&
    Number.isSafeInteger(input.limit) &&
    input.limit >= 1 &&
    input.limit <= 100 &&
    (input.deadlineMs === undefined ||
      (Number.isSafeInteger(input.deadlineMs) && input.deadlineMs >= 0))
  );
}

export function sessionRequestRecoveryControlStopped(
  ports: SessionRequestRecoveryPorts,
  input: OperationControl,
): boolean {
  return operationControlStopped(ports.clock, input.abort, input.deadlineMs);
}

export function validRequestStoreFailure(value: unknown): value is RequestStoreFailureCode {
  return typeof value === "string" && requestStoreFailureCodes.some((code) => code === value);
}

export function snapshotRecoveryRequest(
  request: unknown,
  workspaceKey: WorkspaceKey,
  state: "prepared" | "submitting",
): RequestMetadata | undefined {
  const snapshot = inspectRequestMetadata(request);
  return snapshot && snapshot.workspaceKey === workspaceKey && snapshot.deliveryState === state
    ? snapshot
    : undefined;
}
