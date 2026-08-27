import type { FencingToken } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import {
  digestStartArguments,
  isCoherentStartOperation,
  type StartOperation,
} from "../domain/session-start";
import { runUntilAborted } from "./abortable-operation";
import { stopCommunicatorForOwnershipLoss } from "./communicator-readiness-port";
import type { NativeQueueAdmission } from "./delivery-ports";
import type { SessionStartContext, SessionStartPorts } from "./session-start-application";
import type {
  ClaimedStartStep,
  StartStep,
  StartStoreFailureCode,
  StartStoreResult,
} from "./session-start-ports";

export class StartEffectContractFault extends Error {
  override readonly name = "StartEffectContractFault";
}

export function startStoreFailure(code: StartStoreFailureCode): DomainResult<never> {
  const messages: Record<StartStoreFailureCode, string> = {
    idempotency_conflict: "The idempotency key was already used with different arguments.",
    quota_exceeded: "The managed-session quota was exceeded.",
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
  if (
    operation.titleState === "payload_unavailable" ||
    operation.admissionState === "payload_unavailable"
  ) {
    return partialStartFailure("start_payload_unavailable", operation);
  }
  return { ok: true, value: operation };
}

async function ownershipCurrent(ports: SessionStartPorts, token: FencingToken): Promise<boolean> {
  try {
    const current = (await ports.ownership.isCurrent(token)) === true;
    if (!current) stopCommunicatorForOwnershipLoss(ports.readiness);
    return current;
  } catch {
    stopCommunicatorForOwnershipLoss(ports.readiness);
    return false;
  }
}

async function validateClaim(
  ports: SessionStartPorts,
  expected: StartOperation,
  step: StartStep,
  claim: ClaimedStartStep,
): Promise<Extract<ClaimedStartStep, { readonly ok: true }>> {
  if (!claim.ok)
    throw new StartEffectContractFault("A failed claim cannot be validated as successful.");
  const operation = claim.operation;
  if (
    !isCoherentStartOperation(operation) ||
    operation.id !== expected.id ||
    operation.sessionId !== expected.sessionId ||
    operation.nativeMessageId !== expected.nativeMessageId ||
    operation.sourceSessionId !== expected.sourceSessionId ||
    operation.workspaceKey !== expected.workspaceKey ||
    operation[`${step}State`] !== "submitting"
  )
    throw new StartEffectContractFault(
      "The start persistence adapter returned an unrelated claim.",
    );
  const digest = await digestStartArguments(ports.digest, claim.arguments);
  if (
    digest !== operation.argumentsSha256 ||
    claim.arguments.idempotencyKey !== operation.idempotencyKey
  ) {
    throw new StartEffectContractFault(
      "The claimed start payload digest does not match its operation.",
    );
  }
  return claim;
}

async function restoreBeforeCall(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  operation: StartOperation,
  step: StartStep,
): Promise<DomainResult<StartOperation>> {
  let restored: StartStoreResult;
  const nowMs = ports.clock.nowMs();
  try {
    restored = await ports.starts.restorePreparedClaim({
      fencingToken: token,
      workspaceKey: context.workspaceKey,
      operationId: operation.id,
      step,
      nowMs,
    });
  } catch {
    return startStoreFailure("storage_unavailable");
  }
  return restored.ok ? { ok: true, value: restored.operation } : startStoreFailure(restored.code);
}

async function canBeginCall(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
): Promise<"allowed" | "cancelled" | "caller_hidden" | "ownership_lost"> {
  if (context.abort.aborted) return "cancelled";
  const { sourceSessionId, workspaceKey } = context;
  const current = await runUntilAborted(context.abort, () =>
    ports.membership.readCurrentRoots(workspaceKey, sourceSessionId, sourceSessionId),
  );
  if (current.kind !== "settled") return current.kind === "aborted" ? "cancelled" : "caller_hidden";
  try {
    if (!current.value.sourceVisible || !current.value.targetVisible) return "caller_hidden";
  } catch {
    return "caller_hidden";
  }
  if (context.abort.aborted) return "cancelled";
  return (await ownershipCurrent(ports, token)) ? "allowed" : "ownership_lost";
}

async function claimForEffect(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  operation: StartOperation,
  step: StartStep,
): Promise<DomainResult<Extract<ClaimedStartStep, { readonly ok: true }>>> {
  let claim: ClaimedStartStep;
  const nowMs = ports.clock.nowMs();
  try {
    claim = await ports.starts.claimStep({
      fencingToken: token,
      workspaceKey: context.workspaceKey,
      operationId: operation.id,
      step,
      nowMs,
    });
  } catch {
    return startStoreFailure("storage_unavailable");
  }
  if (!claim.ok) return startStoreFailure(claim.code);
  return { ok: true, value: await validateClaim(ports, operation, step, claim) };
}

function validQueueOutcome(value: unknown): value is NativeQueueAdmission {
  let candidate: Record<string, unknown>;
  let keys: PropertyKey[];
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    keys = Reflect.ownKeys(value);
    candidate = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return false;
      candidate[key] = descriptor.value;
    }
  } catch {
    return false;
  }
  if (candidate.kind === "unknown" || candidate.kind === "definitive_rejection")
    return keys.length === 1;
  if (candidate.kind === "admitted") {
    return (
      keys.length === 3 &&
      Number.isSafeInteger(candidate.admittedSeq) &&
      (candidate.admittedSeq as number) >= 0 &&
      Number.isSafeInteger(candidate.observedAtMs) &&
      (candidate.observedAtMs as number) >= 0
    );
  }
  return (
    candidate.kind === "promoted" &&
    keys.length === 4 &&
    Number.isSafeInteger(candidate.admittedSeq) &&
    (candidate.admittedSeq as number) >= 0 &&
    Number.isSafeInteger(candidate.promotedSeq) &&
    (candidate.promotedSeq as number) > (candidate.admittedSeq as number) &&
    Number.isSafeInteger(candidate.observedAtMs) &&
    (candidate.observedAtMs as number) >= 0
  );
}

async function preCallFailure(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  operation: StartOperation,
  step: StartStep,
  reason: Exclude<Awaited<ReturnType<typeof canBeginCall>>, "allowed">,
): Promise<DomainResult<StartOperation>> {
  const restored = await restoreBeforeCall(ports, context, token, operation, step);
  if (!restored.ok) return restored;
  if (step === "creation" && reason !== "ownership_lost") {
    let released: StartStoreResult;
    const nowMs = ports.clock.nowMs();
    try {
      released = await ports.starts.releasePreparedReservation({
        fencingToken: token,
        workspaceKey: context.workspaceKey,
        operationId: operation.id,
        nowMs,
      });
    } catch {
      return startStoreFailure("storage_unavailable");
    }
    if (!released.ok) return startStoreFailure(released.code);
  }
  if (reason === "caller_hidden")
    return domainFailure(
      "caller_not_visible",
      "Caller is not a current visible root session.",
      false,
    );
  if (reason === "ownership_lost") return startStoreFailure("ownership_lost");
  return domainFailure(
    "deadline_expired",
    "The session-start invocation ended before native work began.",
    false,
    { operation: restored.value },
  );
}

export async function runStartCreation(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  operation: StartOperation,
): Promise<DomainResult<StartOperation>> {
  if (operation.creationState !== "prepared") return { ok: true, value: operation };
  const claim = await claimForEffect(ports, context, token, operation, "creation");
  if (!claim.ok) return claim;
  const permission = await canBeginCall(ports, context, token);
  if (permission !== "allowed")
    return preCallFailure(ports, context, token, claim.value.operation, "creation", permission);
  const called = await runUntilAborted(context.abort, () =>
    ports.nativeStart.createRootSession({
      sessionId: operation.sessionId,
      ...(claim.value.arguments.agent === undefined ? {} : { agent: claim.value.arguments.agent }),
      ...(claim.value.arguments.model === undefined ? {} : { model: claim.value.arguments.model }),
      abort: context.abort,
    }),
  );
  const native = called.kind === "settled" ? called.value : "unknown";
  if (!["created", "collision", "definitive_rejection", "unknown"].includes(native as string))
    throw new StartEffectContractFault("The native create adapter returned an unknown outcome.");
  const state =
    native === "created"
      ? "created"
      : native === "collision" || native === "definitive_rejection"
        ? "failed"
        : "outcome_unknown";
  if (!(await ownershipCurrent(ports, token)))
    return partialStartFailure("native_outcome_unknown", claim.value.operation);
  let completed: StartStoreResult;
  const nowMs = ports.clock.nowMs();
  try {
    completed = await ports.starts.completeCreation({
      fencingToken: token,
      workspaceKey: context.workspaceKey,
      operationId: operation.id,
      state,
      nowMs,
    });
  } catch {
    return partialStartFailure("native_outcome_unknown", claim.value.operation);
  }
  if (!completed.ok) return partialStartFailure("native_outcome_unknown", claim.value.operation);
  if (
    !isCoherentStartOperation(completed.operation) ||
    completed.operation.id !== operation.id ||
    completed.operation.creationState !== state
  )
    throw new StartEffectContractFault("The creation completion result is malformed.");
  return { ok: true, value: completed.operation };
}

/** Reads authoritative native state only; it never retries the ambiguous create call. */
export async function reconcileStartCreation(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  operation: StartOperation,
): Promise<DomainResult<StartOperation>> {
  if (operation.creationState !== "outcome_unknown") return { ok: true, value: operation };
  const observed = await runUntilAborted(context.abort, () =>
    ports.nativeStart.reconcileRootSession({
      sessionId: operation.sessionId,
      ...(operation.requestedAgent === undefined ? {} : { agent: operation.requestedAgent }),
      ...(operation.requestedModel === undefined ? {} : { model: operation.requestedModel }),
      abort: context.abort,
    }),
  );
  const native = observed.kind === "settled" ? observed.value : "unknown";
  if (!["matching", "absent", "collision", "unknown"].includes(native as string)) {
    throw new StartEffectContractFault(
      "The native create reconciliation adapter returned an unknown outcome.",
    );
  }
  if (native === "unknown" || !(await ownershipCurrent(ports, token))) {
    return partialStartFailure("native_outcome_unknown", operation);
  }
  let completed: StartStoreResult;
  try {
    completed = await ports.starts.reconcileUnknownCreation({
      fencingToken: token,
      workspaceKey: context.workspaceKey,
      operationId: operation.id,
      outcome: native,
      nowMs: ports.clock.nowMs(),
    });
  } catch {
    return partialStartFailure("native_outcome_unknown", operation);
  }
  if (!completed.ok) return startStoreFailure(completed.code);
  if (!isCoherentStartOperation(completed.operation) || completed.operation.id !== operation.id) {
    throw new StartEffectContractFault("The creation reconciliation result is malformed.");
  }
  return { ok: true, value: completed.operation };
}

export async function runStartTitle(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  operation: StartOperation,
): Promise<DomainResult<StartOperation>> {
  if (operation.titleState !== "prepared") return { ok: true, value: operation };
  const claim = await claimForEffect(ports, context, token, operation, "title");
  if (!claim.ok) return claim;
  const title = claim.value.arguments.title;
  if (title === undefined)
    throw new StartEffectContractFault("A prepared title operation has no title.");
  const permission = await canBeginCall(ports, context, token);
  if (permission !== "allowed")
    return preCallFailure(ports, context, token, claim.value.operation, "title", permission);
  const called = await runUntilAborted(context.abort, () =>
    ports.nativeStart.updateSessionTitle({
      sessionId: operation.sessionId,
      title,
      abort: context.abort,
    }),
  );
  const native = called.kind === "settled" ? called.value : "unknown";
  if (!["updated", "definitive_rejection", "unknown"].includes(native as string))
    throw new StartEffectContractFault("The native title adapter returned an unknown outcome.");
  const state =
    native === "updated"
      ? "updated"
      : native === "definitive_rejection"
        ? "failed"
        : "outcome_unknown";
  if (!(await ownershipCurrent(ports, token)))
    return partialStartFailure("native_outcome_unknown", claim.value.operation);
  let completed: StartStoreResult;
  const nowMs = ports.clock.nowMs();
  try {
    completed = await ports.starts.completeTitle({
      fencingToken: token,
      workspaceKey: context.workspaceKey,
      operationId: operation.id,
      state,
      nowMs,
    });
  } catch {
    return partialStartFailure("native_outcome_unknown", claim.value.operation);
  }
  if (!completed.ok) return partialStartFailure("native_outcome_unknown", claim.value.operation);
  if (
    !isCoherentStartOperation(completed.operation) ||
    completed.operation.id !== operation.id ||
    completed.operation.titleState !== state
  )
    throw new StartEffectContractFault("The title completion result is malformed.");
  return { ok: true, value: completed.operation };
}

export async function runStartAdmission(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  operation: StartOperation,
): Promise<DomainResult<StartOperation>> {
  if (operation.admissionState !== "prepared") return { ok: true, value: operation };
  const claim = await claimForEffect(ports, context, token, operation, "admission");
  if (!claim.ok) return claim;
  const permission = await canBeginCall(ports, context, token);
  if (permission !== "allowed")
    return preCallFailure(ports, context, token, claim.value.operation, "admission", permission);
  const called = await runUntilAborted(context.abort, () =>
    ports.nativeQueue.queueMessage({
      targetSessionId: operation.sessionId,
      nativeMessageId: operation.nativeMessageId,
      envelope: claim.value.arguments.initialMessage,
      abort: context.abort,
    }),
  );
  const native: unknown = called.kind === "settled" ? called.value : { kind: "unknown" };
  if (!validQueueOutcome(native))
    throw new StartEffectContractFault("The native queue adapter returned a malformed outcome.");
  const state =
    native.kind === "unknown"
      ? "admission_unknown"
      : native.kind === "definitive_rejection"
        ? "failed"
        : "admitted";
  if (!(await ownershipCurrent(ports, token)))
    return partialStartFailure("admission_unknown", claim.value.operation);
  let completed: StartStoreResult;
  const nowMs = ports.clock.nowMs();
  try {
    completed = await ports.starts.completeAdmission({
      fencingToken: token,
      workspaceKey: context.workspaceKey,
      operationId: operation.id,
      state,
      nowMs,
    });
  } catch {
    return partialStartFailure("admission_unknown", claim.value.operation);
  }
  if (!completed.ok) return partialStartFailure("admission_unknown", claim.value.operation);
  if (
    !isCoherentStartOperation(completed.operation) ||
    completed.operation.id !== operation.id ||
    completed.operation.admissionState !== state
  )
    throw new StartEffectContractFault("The admission completion result is malformed.");
  return { ok: true, value: completed.operation };
}
