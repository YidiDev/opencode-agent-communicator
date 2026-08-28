import type { FencingToken } from "../domain/ownership";
import type { DomainResult } from "../domain/results";
import { isCoherentStartOperation, type StartOperation } from "../domain/session-start";
import { runUntilAborted } from "./abortable-operation";
import type { NativeQueueAdmission } from "./delivery-ports";
import type { SessionStartContext, SessionStartPorts } from "./session-start-application";
import type { StartStoreResult } from "./session-start-ports";
import { ownershipCurrent, prepareStartEffect } from "./start-session-effect-preparation";
import {
  partialStartFailure,
  StartEffectContractFault,
  startStoreFailure,
} from "./start-session-effect-results";

export {
  partialStartFailure,
  projectStartOutcome,
  StartEffectContractFault,
  startStoreFailure,
} from "./start-session-effect-results";

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

export async function runStartCreation(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  operation: StartOperation,
): Promise<DomainResult<StartOperation>> {
  if (operation.creationState !== "prepared") return { ok: true, value: operation };
  const claim = await prepareStartEffect(ports, context, token, operation, "creation");
  if (!claim.ok) return claim;
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
  const claim = await prepareStartEffect(ports, context, token, operation, "title");
  if (!claim.ok) return claim;
  const title = claim.value.arguments.title;
  if (title === undefined)
    throw new StartEffectContractFault("A prepared title operation has no title.");
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
  const claim = await prepareStartEffect(ports, context, token, operation, "admission");
  if (!claim.ok) return claim;
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
