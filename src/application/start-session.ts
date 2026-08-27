import {
  validateManagedSessionId,
  validateNativeMessageId,
  validateStartOperationId,
} from "../domain/generated-ids";
import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import {
  digestStartArguments,
  isCoherentStartOperation,
  type StartOperation,
  type ValidatedStartArguments,
  validateStartAgent,
  validateStartIdempotencyKey,
  validateStartInitialMessage,
  validateStartModel,
  validateStartTitle,
} from "../domain/session-start";
import type { SessionStartPolicy } from "../domain/session-start-policy";
import { runUntilAborted } from "./abortable-operation";
import {
  assertCommunicatorReady,
  communicatorLifecycleFencingToken,
  stopCommunicatorForOwnershipLoss,
} from "./communicator-readiness-port";
import type {
  SessionStartArguments,
  SessionStartContext,
  SessionStartPorts,
} from "./session-start-application";
import type { StartStoreResult } from "./session-start-ports";
import { approvePreparedStart } from "./start-session-approval";
import {
  projectStartOutcome,
  reconcileStartCreation,
  runStartAdmission,
  runStartCreation,
  runStartTitle,
  StartEffectContractFault,
  startStoreFailure,
} from "./start-session-effects";
import { createLinkedEffectControl } from "./startup-effect-control";

export type {
  SessionStartArguments,
  SessionStartContext,
  SessionStartPorts,
} from "./session-start-application";

function validateArguments(args: SessionStartArguments): DomainResult<ValidatedStartArguments> {
  const key = validateStartIdempotencyKey(args.idempotency_key);
  if (!key.ok) return domainFailure("invalid_arguments", key.message, false);
  const message = validateStartInitialMessage(args.initial_message);
  if (!message.ok) return domainFailure("invalid_arguments", message.message, false);
  const title = validateStartTitle(args.title);
  if (!title.ok) return domainFailure("invalid_arguments", title.message, false);
  const agent = validateStartAgent(args.agent);
  if (!agent.ok) return domainFailure("invalid_arguments", agent.message, false);
  const model = validateStartModel(args.model);
  if (!model.ok) return domainFailure("invalid_arguments", model.message, false);
  return {
    ok: true,
    value: {
      idempotencyKey: key.value,
      initialMessage: message.value,
      ...(title.value === undefined ? {} : { title: title.value }),
      ...(agent.value === undefined ? {} : { agent: agent.value }),
      ...(model.value === undefined ? {} : { model: model.value }),
    },
  };
}

function policyFailure(
  policy: SessionStartPolicy,
  input: ValidatedStartArguments,
): DomainResult<never> | undefined {
  if (input.agent !== undefined && !policy.allowedAgents.has(input.agent))
    return domainFailure(
      "permission_denied",
      "The requested agent override is not allowed.",
      false,
    );
  if (input.model !== undefined && !policy.allowedModels.has(input.model))
    return domainFailure(
      "permission_denied",
      "The requested model override is not allowed.",
      false,
    );
  return undefined;
}

async function callerVisible(
  ports: SessionStartPorts,
  context: SessionStartContext,
): Promise<DomainResult<true>> {
  const current = await runUntilAborted(context.abort, () =>
    ports.membership.readCurrentRoots(
      context.workspaceKey,
      context.sourceSessionId,
      context.sourceSessionId,
    ),
  );
  if (current.kind === "aborted")
    return domainFailure(
      "deadline_expired",
      "The session-start invocation deadline elapsed.",
      false,
    );
  if (current.kind === "rejected")
    return domainFailure("native_unavailable", "Current caller visibility is unavailable.", true);
  try {
    return current.value.sourceVisible && current.value.targetVisible
      ? { ok: true, value: true }
      : domainFailure("caller_not_visible", "Caller is not a current visible root session.", false);
  } catch {
    return domainFailure("native_unavailable", "Current caller visibility is unavailable.", true);
  }
}

function validControl(ports: SessionStartPorts, context: SessionStartContext) {
  if (!Number.isSafeInteger(context.deadlineMs) || context.deadlineMs < 0) return undefined;
  return createLinkedEffectControl({
    signals: [context.abort],
    deadlineMs: context.deadlineMs,
    clock: ports.clock,
  });
}

async function acquireStartToken(ports: SessionStartPorts): Promise<DomainResult<FencingToken>> {
  try {
    return { ok: true, value: communicatorLifecycleFencingToken(ports.readiness) };
  } catch (cause: unknown) {
    return startStoreFailure(
      cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
    );
  }
}

async function recursionAllowed(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
): Promise<DomainResult<true>> {
  let managed: unknown;
  try {
    managed = await ports.starts.isManagedSession({
      fencingToken: token,
      workspaceKey: context.workspaceKey,
      sessionId: context.sourceSessionId,
    });
  } catch (cause: unknown) {
    return startStoreFailure(
      cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
    );
  }
  if (typeof managed !== "boolean")
    throw new StartEffectContractFault("The managed-session query returned a malformed result.");
  return !ports.policy.allowManagedSessionRecursion && managed
    ? domainFailure(
        "permission_denied",
        "Managed sessions cannot recursively start sessions.",
        false,
      )
    : { ok: true, value: true };
}

async function prepareStart(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  arguments_: ValidatedStartArguments,
): Promise<
  DomainResult<{
    readonly operation: StartOperation;
    readonly argumentsSha256: StartOperation["argumentsSha256"];
  }>
> {
  const argumentsSha256 = await digestStartArguments(ports.digest, arguments_);
  const generated = {
    operationId: ports.ids.startOperationId(),
    sessionId: ports.ids.managedSessionId(),
    nativeMessageId: ports.ids.nativeMessageId(),
  };
  if (
    !validateStartOperationId(generated.operationId).ok ||
    !validateManagedSessionId(generated.sessionId).ok ||
    !validateNativeMessageId(generated.nativeMessageId).ok
  ) {
    throw new StartEffectContractFault("The generated session-start identifiers are malformed.");
  }
  let prepared: StartStoreResult;
  try {
    prepared = await ports.starts.createOrResume({
      fencingToken: token,
      workspaceKey: context.workspaceKey,
      sourceSessionId: context.sourceSessionId,
      ...generated,
      argumentsSha256,
      arguments: arguments_,
      limits: ports.policy.limits,
      nowMs: ports.clock.nowMs(),
    });
  } catch (cause: unknown) {
    return startStoreFailure(
      cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
    );
  }
  if (!prepared.ok) return startStoreFailure(prepared.code);
  if (
    !isCoherentStartOperation(prepared.operation) ||
    prepared.operation.workspaceKey !== context.workspaceKey ||
    prepared.operation.sourceSessionId !== context.sourceSessionId ||
    prepared.operation.idempotencyKey !== arguments_.idempotencyKey ||
    prepared.operation.argumentsSha256 !== argumentsSha256
  ) {
    throw new StartEffectContractFault(
      "The start persistence adapter returned an unrelated operation.",
    );
  }
  return { ok: true, value: { operation: prepared.operation, argumentsSha256 } };
}

async function executeStartEffects(
  ports: SessionStartPorts,
  context: SessionStartContext,
  token: FencingToken,
  operation: StartOperation,
): Promise<DomainResult<StartOperation>> {
  const creation = await runStartCreation(ports, context, token, operation);
  if (!creation.ok) return creation;
  if (creation.value.creationState !== "created") return projectStartOutcome(creation.value);
  const title = await runStartTitle(ports, context, token, creation.value);
  if (!title.ok) return title;
  const admission = await runStartAdmission(ports, context, token, title.value);
  return admission.ok ? projectStartOutcome(admission.value) : admission;
}

export async function startSession(
  ports: SessionStartPorts,
  context: SessionStartContext,
  args: SessionStartArguments,
): Promise<DomainResult<StartOperation>> {
  assertCommunicatorReady(ports.readiness);
  const validated = validateArguments(args);
  if (!validated.ok) return validated;
  const denied = policyFailure(ports.policy, validated.value);
  if (denied) return denied;
  const control = validControl(ports, context);
  if (!control)
    return domainFailure("invalid_arguments", "Session-start deadline control is invalid.", false);
  const linkedContext = { ...context, abort: control.signal };
  try {
    if (control.signal.aborted)
      return domainFailure(
        "deadline_expired",
        "The session-start invocation deadline elapsed.",
        false,
      );
    const visible = await callerVisible(ports, linkedContext);
    if (!visible.ok) return visible;
    const token = await acquireStartToken(ports);
    if (!token.ok) return token;
    try {
      if ((await ports.ownership.isCurrent(token.value)) !== true) {
        stopCommunicatorForOwnershipLoss(ports.readiness);
        return startStoreFailure("ownership_lost");
      }
    } catch {
      stopCommunicatorForOwnershipLoss(ports.readiness);
      return startStoreFailure("ownership_lost");
    }
    const recursion = await recursionAllowed(ports, linkedContext, token.value);
    if (!recursion.ok) return recursion;
    const prepared = await prepareStart(ports, linkedContext, token.value, validated.value);
    if (!prepared.ok) return prepared;
    const reconciled = await reconcileStartCreation(
      ports,
      linkedContext,
      token.value,
      prepared.value.operation,
    );
    if (!reconciled.ok) return reconciled;
    const operation = reconciled.value;
    const hasPreparedEffect =
      operation.creationState === "prepared" ||
      operation.titleState === "prepared" ||
      operation.admissionState === "prepared";
    if (!hasPreparedEffect) return projectStartOutcome(operation);
    const approval = await approvePreparedStart(ports, linkedContext, token.value, {
      ...prepared.value,
      operation,
    });
    if (!approval.ok) return approval;
    return await executeStartEffects(ports, linkedContext, token.value, operation);
  } finally {
    control.dispose();
  }
}
