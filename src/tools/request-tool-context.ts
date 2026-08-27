import type { SessionBlockingRequestContext } from "../application/create-blocking-session-request";
import type { SessionRequestMutationContext } from "../application/request-terminal-use-case";
import { type FencingToken, validateFencingToken } from "../domain/ownership";
import { blockingRequestDeadlineMarginMs } from "../domain/request-constants";
import { type DomainResult, domainFailure } from "../domain/results";
import { validateSessionId } from "../domain/sessions";
import { validateWorkspaceKey, type WorkspaceKey } from "../domain/workspaces";
import { type StructuralToolContext, ToolContractFault } from "./contracts";

export interface RequestToolIdentityScope {
  readonly workspaceKey: WorkspaceKey;
  readonly fencingToken: FencingToken;
}

export interface RequestToolScope extends RequestToolIdentityScope {
  /** Must outlive every request deadline; ToolContext.abort is the only explicit cancellation. */
  readonly invocationDeadlineMs: (minimumDurationMs?: number) => number;
}

/**
 * Finite time reserved on both sides of durable request creation. One margin bounds pre-persistence
 * external I/O; the other remains after the persisted deadline for terminal read/cleanup I/O.
 */
export function blockingRequestMinimumInvocationDurationMs(timeoutSeconds: number): number {
  const timeoutMs = timeoutSeconds * 1_000;
  const durationMs = timeoutMs + blockingRequestDeadlineMarginMs * 2;
  if (
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    !Number.isSafeInteger(durationMs)
  ) {
    throw new ToolContractFault();
  }
  return durationMs;
}

export function requestToolIdentity(
  scope: RequestToolIdentityScope,
  context: StructuralToolContext,
): DomainResult<{
  readonly workspaceKey: WorkspaceKey;
  readonly callerSessionId: import("../domain/sessions").SessionId;
  readonly fencingToken: FencingToken;
}> {
  const workspace = validateWorkspaceKey(scope.workspaceKey);
  const caller = validateSessionId(context.sessionID);
  const fencing = validateFencingToken(scope.fencingToken);
  if (!workspace.ok || !fencing.ok) throw new ToolContractFault();
  if (!caller.ok) return domainFailure("invalid_arguments", caller.message, false);
  return {
    ok: true,
    value: {
      workspaceKey: workspace.value,
      callerSessionId: caller.value,
      fencingToken: fencing.value,
    },
  };
}

export function requestToolContext(
  scope: RequestToolScope,
  context: StructuralToolContext,
  minimumDurationMs?: number | (() => number),
): DomainResult<SessionBlockingRequestContext & SessionRequestMutationContext> {
  const identity = requestToolIdentity(scope, context);
  if (!identity.ok) return identity;
  let deadlineMs: number;
  try {
    const minimum =
      typeof minimumDurationMs === "function" ? minimumDurationMs() : minimumDurationMs;
    deadlineMs = scope.invocationDeadlineMs(minimum);
  } catch {
    throw new ToolContractFault();
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) {
    throw new ToolContractFault();
  }
  return {
    ok: true,
    value: {
      ...identity.value,
      sourceSessionId: identity.value.callerSessionId,
      abort: context.abort,
      deadlineMs,
    },
  };
}
