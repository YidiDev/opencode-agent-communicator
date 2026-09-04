import type { FencingToken } from "../domain/ownership";
import type { DomainResult } from "../domain/results";
import { isCoherentStartOperation, type StartOperation } from "../domain/session-start";
import { runUntilAborted } from "./abortable-operation";
import type { SessionStartContext, SessionStartPorts } from "./session-start-application";
import type { StartStoreResult } from "./session-start-ports";
import { ownershipCurrent, prepareStartEffect } from "./start-session-effect-preparation";
import {
  partialStartFailure,
  StartEffectContractFault,
  startStoreFailure,
} from "./start-session-effect-results";
import { createLinkedEffectControl } from "./startup-effect-control";

export {
  partialStartFailure,
  projectStartOutcome,
  StartEffectContractFault,
  startStoreFailure,
} from "./start-session-effect-results";

function startEffectControl(ports: SessionStartPorts, context: SessionStartContext) {
  const linked = createLinkedEffectControl({
    signals: [context.abort],
    deadlineMs: context.deadlineMs,
    clock: ports.clock,
  });
  if (linked) return linked;
  const controller = new AbortController();
  controller.abort("invalid start effect control");
  return { signal: controller.signal, dispose() {} };
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
  const effect = startEffectControl(ports, context);
  const called = await runUntilAborted(effect.signal, () =>
    ports.nativeStart.createRootSession({
      sessionId: operation.sessionId,
      ...(claim.value.arguments.agent === undefined ? {} : { agent: claim.value.arguments.agent }),
      ...(claim.value.arguments.model === undefined ? {} : { model: claim.value.arguments.model }),
      abort: effect.signal,
    }),
  ).finally(effect.dispose);
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
  const effect = startEffectControl(ports, context);
  const observed = await runUntilAborted(effect.signal, () =>
    ports.nativeStart.reconcileRootSession({
      sessionId: operation.sessionId,
      ...(operation.requestedAgent === undefined ? {} : { agent: operation.requestedAgent }),
      ...(operation.requestedModel === undefined ? {} : { model: operation.requestedModel }),
      abort: effect.signal,
    }),
  ).finally(effect.dispose);
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
  const effect = startEffectControl(ports, context);
  const called = await runUntilAborted(effect.signal, () =>
    ports.nativeStart.updateSessionTitle({
      sessionId: operation.sessionId,
      title,
      abort: effect.signal,
    }),
  ).finally(effect.dispose);
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
  const effect = startEffectControl(ports, context);
  const called = await runUntilAborted(effect.signal, () =>
    ports.nativeStart.admitInitialMessage({
      sessionId: operation.sessionId,
      nativeMessageId: operation.nativeMessageId,
      message: claim.value.arguments.initialMessage,
      ...(claim.value.arguments.agent === undefined ? {} : { agent: claim.value.arguments.agent }),
      ...(claim.value.arguments.model === undefined ? {} : { model: claim.value.arguments.model }),
      abort: effect.signal,
    }),
  ).finally(effect.dispose);
  const native: unknown = called.kind === "settled" ? called.value : "unknown";
  if (!new Set(["admitted", "definitive_rejection", "unknown"]).has(native as string))
    throw new StartEffectContractFault("The native start adapter returned a malformed outcome.");
  const state =
    native === "unknown"
      ? "admission_unknown"
      : native === "definitive_rejection"
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
