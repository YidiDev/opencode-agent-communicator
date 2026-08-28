import type { FencingToken } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import {
  digestStartArguments,
  isCoherentStartOperation,
  type StartOperation,
} from "../domain/session-start";
import { runUntilAborted } from "./abortable-operation";
import { stopCommunicatorForOwnershipLoss } from "./communicator-readiness-port";
import type { SessionStartContext, SessionStartPorts } from "./session-start-application";
import type { ClaimedStartStep, StartStep, StartStoreResult } from "./session-start-ports";
import { StartEffectContractFault, startStoreFailure } from "./start-session-effect-results";

export async function ownershipCurrent(
  ports: SessionStartPorts,
  token: FencingToken,
): Promise<boolean> {
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
  if (!claim.ok) {
    throw new StartEffectContractFault("A failed claim cannot be validated as successful.");
  }
  const operation = claim.operation;
  if (
    !isCoherentStartOperation(operation) ||
    operation.id !== expected.id ||
    operation.sessionId !== expected.sessionId ||
    operation.nativeMessageId !== expected.nativeMessageId ||
    operation.sourceSessionId !== expected.sourceSessionId ||
    operation.workspaceKey !== expected.workspaceKey ||
    operation[`${step}State`] !== "submitting"
  ) {
    throw new StartEffectContractFault(
      "The start persistence adapter returned an unrelated claim.",
    );
  }
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
  try {
    restored = await ports.starts.restorePreparedClaim({
      fencingToken: token,
      workspaceKey: context.workspaceKey,
      operationId: operation.id,
      step,
      nowMs: ports.clock.nowMs(),
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

export async function claimForEffect(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  operation: StartOperation,
  step: StartStep,
): Promise<DomainResult<Extract<ClaimedStartStep, { readonly ok: true }>>> {
  let claim: ClaimedStartStep;
  try {
    claim = await ports.starts.claimStep({
      fencingToken: token,
      workspaceKey: context.workspaceKey,
      operationId: operation.id,
      step,
      nowMs: ports.clock.nowMs(),
    });
  } catch {
    return startStoreFailure("storage_unavailable");
  }
  if (!claim.ok) return startStoreFailure(claim.code);
  return { ok: true, value: await validateClaim(ports, operation, step, claim) };
}

export async function preCallFailure(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  operation: StartOperation,
  step: StartStep,
  reason: Exclude<Awaited<ReturnType<typeof canBeginCall>>, "allowed">,
): Promise<DomainResult<never>> {
  const restored = await restoreBeforeCall(ports, context, token, operation, step);
  if (!restored.ok) return restored;
  if (step === "creation" && reason !== "ownership_lost") {
    let released: StartStoreResult;
    try {
      released = await ports.starts.releasePreparedReservation({
        fencingToken: token,
        workspaceKey: context.workspaceKey,
        operationId: operation.id,
        nowMs: ports.clock.nowMs(),
      });
    } catch {
      return startStoreFailure("storage_unavailable");
    }
    if (!released.ok) return startStoreFailure(released.code);
  }
  if (reason === "caller_hidden") {
    return domainFailure(
      "caller_not_visible",
      "Caller is not a current visible root session.",
      false,
    );
  }
  if (reason === "ownership_lost") return startStoreFailure("ownership_lost");
  return domainFailure(
    "deadline_expired",
    "The session-start invocation ended before native work began.",
    false,
    { operation: restored.value },
  );
}

export async function prepareStartEffect(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  operation: StartOperation,
  step: StartStep,
): Promise<DomainResult<Extract<ClaimedStartStep, { readonly ok: true }>>> {
  const claim = await claimForEffect(ports, context, token, operation, step);
  if (!claim.ok) return claim;
  const permission = await canBeginCall(ports, context, token);
  if (permission !== "allowed") {
    return preCallFailure(ports, context, token, claim.value.operation, step, permission);
  }
  return claim;
}
