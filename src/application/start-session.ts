import type { FencingToken } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { StartOperation } from "../domain/session-start";
import {
  assertCommunicatorReady,
  stopCommunicatorForOwnershipLoss,
} from "./communicator-readiness-port";
import type {
  SessionStartArguments,
  SessionStartContext,
  SessionStartPorts,
} from "./session-start-application";
import { approvePreparedStart } from "./start-session-approval";
import {
  projectStartOutcome,
  reconcileStartCreation,
  runStartAdmission,
  runStartCreation,
  runStartTitle,
  startStoreFailure,
} from "./start-session-effects";
import {
  acquireSessionStartToken,
  prepareStart,
  sessionStartCallerVisible,
  sessionStartPolicyFailure,
  sessionStartRecursionAllowed,
  validateSessionStartArguments,
  validSessionStartControl,
} from "./start-session-preconditions";

export type {
  SessionStartArguments,
  SessionStartContext,
  SessionStartPorts,
} from "./session-start-application";
export {
  acquireSessionStartToken,
  sessionStartCallerVisible,
  sessionStartPolicyFailure,
  sessionStartRecursionAllowed,
  validateSessionStartArguments,
  validSessionStartControl,
} from "./start-session-preconditions";

export async function executeStartEffects(
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
  const validated = validateSessionStartArguments(args);
  if (!validated.ok) return validated;
  const denied = sessionStartPolicyFailure(ports.policy, validated.value);
  if (denied) return denied;
  const control = validSessionStartControl(ports, context);
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
    const visible = await sessionStartCallerVisible(ports, linkedContext);
    if (!visible.ok) return visible;
    const token = await acquireSessionStartToken(ports);
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
    const recursion = await sessionStartRecursionAllowed(ports, linkedContext, token.value);
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
