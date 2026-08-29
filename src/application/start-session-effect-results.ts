import { type DomainResult, domainFailure } from "../domain/results";
import type { StartOperation } from "../domain/session-start";
import type { StartStoreFailureCode } from "./session-start-ports";

export class StartEffectContractFault extends Error {
  override readonly name = "StartEffectContractFault";
}

export function startStoreFailure(code: StartStoreFailureCode): DomainResult<never> {
  const messages: Record<StartStoreFailureCode, string> = {
    idempotency_conflict: "The idempotency key was already used with different arguments.",
    quota_exceeded: "The communicator-started session quota was exceeded.",
    unresolved_provenance_quota_exceeded:
      "The unresolved session-creation provenance quota was exceeded; operator reconciliation is required.",
    rate_limited: "The session-start rate limit was exceeded.",
    state_conflict: "The durable start operation could not make the requested transition.",
    ownership_lost: "Coordinator ownership was lost.",
    storage_unavailable: "Start operation storage is unavailable.",
  };
  if (!Object.hasOwn(messages, code)) {
    throw new StartEffectContractFault(
      "The start persistence adapter returned an unknown failure.",
    );
  }
  return domainFailure(
    code,
    messages[code],
    code === "storage_unavailable" || code === "rate_limited",
  );
}

export function partialStartFailure(
  code:
    | "native_outcome_unknown"
    | "native_unavailable"
    | "admission_failed"
    | "admission_unknown"
    | "start_payload_unavailable",
  operation: StartOperation,
): DomainResult<never> {
  const messages = {
    native_outcome_unknown:
      "The native start outcome is unknown and will not be retried automatically.",
    native_unavailable: "Native session creation failed.",
    admission_failed: "The initial message was definitively rejected.",
    admission_unknown: "Initial-message admission could not be confirmed.",
    start_payload_unavailable:
      "The session was authoritatively found, but its erased continuation payload is unavailable.",
  } as const;
  return domainFailure(code, messages[code], false, { operation });
}

export function projectStartOutcome(operation: StartOperation): DomainResult<StartOperation> {
  if (operation.creationState === "policy_denied") {
    return domainFailure("permission_denied", "Session start is denied by policy.", false, {
      operation,
    });
  }
  if (operation.creationState === "approval_rejected") {
    return domainFailure("approval_rejected", "Session start approval was rejected.", false, {
      operation,
    });
  }
  if (operation.creationState === "submitting" || operation.creationState === "outcome_unknown") {
    return partialStartFailure("native_outcome_unknown", operation);
  }
  if (operation.creationState === "failed")
    return partialStartFailure("native_unavailable", operation);
  if (operation.titleState === "submitting")
    return partialStartFailure("native_outcome_unknown", operation);
  if (
    operation.admissionState === "submitting" ||
    operation.admissionState === "admission_unknown"
  ) {
    return partialStartFailure("admission_unknown", operation);
  }
  if (operation.admissionState === "failed")
    return partialStartFailure("admission_failed", operation);
  if (operation.creationState === "request_terminal") {
    return domainFailure(
      "start_payload_unavailable",
      "The linked request became terminal before session creation; no managed root was started.",
      false,
      { operation },
    );
  }
  if (
    operation.titleState === "payload_unavailable" ||
    operation.admissionState === "payload_unavailable"
  ) {
    return partialStartFailure("start_payload_unavailable", operation);
  }
  return { ok: true, value: operation };
}
