import { digestMessageContent, type Sha256Digest } from "../domain/message-payload";
import type { FencingToken } from "../domain/ownership";
import { canonicalizeSerializeAndDigestPendingRequestPayload } from "../domain/request-serialization";
import type { PendingRequestPayload, RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import {
  assertCommunicatorReady,
  type CommunicatorReadinessPort,
} from "./communicator-readiness-port";
import type {
  ClockPort,
  CurrentWorkspaceMembershipPort,
  MessageAuthorizationPort,
} from "./delivery-ports";
import { inspectMessageAuthorizationDecision } from "./delivery-ports";
import {
  type ImmediateRequestAdmissionArguments,
  type ImmediateRequestAdmissionContext,
  type ImmediateRequestAdmissionPorts,
  immediateRequestStorageFailure,
  persistAndAdmitImmediateRequest,
} from "./immediate-session-request-admission";
import type { RequestAuthorizationPort } from "./request-authorization-port";
import { inspectRequestAuthorizationDecision } from "./request-authorization-port";
import { createLinkedEffectControl } from "./startup-effect-control";

export interface ImmediateSessionRequestPorts extends ImmediateRequestAdmissionPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly messageAuthorization: MessageAuthorizationPort;
  readonly requestAuthorization: RequestAuthorizationPort;
  readonly clock: ClockPort;
}

export interface ImmediateSessionRequestContext extends ImmediateRequestAdmissionContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly fencingToken: FencingToken;
  readonly abort: AbortSignal;
  readonly deadlineMs: number;
}

export interface ImmediateSessionRequestArguments extends ImmediateRequestAdmissionArguments {
  readonly request: PendingRequestPayload;
}

async function visible(
  ports: ImmediateSessionRequestPorts,
  context: ImmediateSessionRequestContext,
  target: SessionId,
) {
  const membership = await ports.membership.readCurrentRoots(
    context.workspaceKey,
    context.sourceSessionId,
    target,
  );
  if (!membership.sourceVisible)
    return domainFailure(
      "caller_not_visible",
      "Caller is not a current visible root session.",
      false,
    );
  if (!membership.targetVisible)
    return domainFailure(
      "target_not_visible",
      "Target is not a current visible root session.",
      false,
    );
  return { ok: true as const, value: true as const };
}

function authorizationFailure(
  kind: "deny" | "approval_rejected",
  label: string,
): DomainResult<never> {
  return kind === "deny"
    ? domainFailure("permission_denied", `${label} permission was denied.`, false)
    : domainFailure("approval_rejected", `${label} approval was rejected.`, false);
}

// Request persistence, claim, and the one queue call are deliberately linear. A queue call is never retried.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keeping authorization, durable preparation, and the single native effect linear makes the no-replay boundary auditable.
async function createImmediateSessionRequestInternal(
  ports: ImmediateSessionRequestPorts,
  context: ImmediateSessionRequestContext,
  args: ImmediateSessionRequestArguments,
  callerAbort: AbortSignal,
): Promise<DomainResult<RequestMetadata>> {
  const interrupted = (): DomainResult<never> =>
    callerAbort.aborted
      ? domainFailure("request_cancelled", "Request creation was cancelled.", false)
      : domainFailure("deadline_expired", "Request creation deadline elapsed.", false);
  if (context.abort.aborted) return interrupted();
  const firstVisibilitySettlement = await runUntilAborted(context.abort, () =>
    visible(ports, context, args.session_id),
  );
  if (firstVisibilitySettlement.kind === "aborted") return interrupted();
  if (firstVisibilitySettlement.kind === "rejected") {
    return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }
  const firstVisibility = firstVisibilitySettlement.value;
  if (!firstVisibility.ok) return firstVisibility;
  if (context.abort.aborted) return interrupted();
  const workBytes = new TextEncoder().encode(args.content);
  let workSha256: Sha256Digest;
  const payload = await canonicalizeSerializeAndDigestPendingRequestPayload(
    ports.digest,
    args.request,
  );
  if (!payload.ok) return domainFailure("invalid_arguments", payload.message, false);
  try {
    workSha256 = await digestMessageContent(ports.digest, workBytes);
  } catch {
    return immediateRequestStorageFailure();
  }
  if (context.abort.aborted) return interrupted();
  const createdAtMs = ports.clock.nowMs();
  const deadlineAtMs = createdAtMs + payload.value.timeoutSeconds * 1_000;
  if (
    !Number.isSafeInteger(createdAtMs) ||
    !Number.isSafeInteger(deadlineAtMs) ||
    deadlineAtMs <= createdAtMs
  ) {
    return domainFailure(
      "invalid_arguments",
      "Request timeout cannot form a safe deadline.",
      false,
    );
  }
  const control = { abort: context.abort, deadlineMs: context.deadlineMs };
  const messageAuthorization = await runUntilAborted(context.abort, () =>
    ports.messageAuthorization.authorizeMessage(
      {
        workspaceKey: context.workspaceKey,
        sourceSessionId: context.sourceSessionId,
        targetSessionId: args.session_id,
        operation: "message",
        contentSha256: workSha256,
        contentByteLength: workBytes.length,
      },
      control,
    ),
  );
  if (messageAuthorization.kind === "aborted") return interrupted();
  if (messageAuthorization.kind === "rejected") return immediateRequestStorageFailure();
  const messageDecision = inspectMessageAuthorizationDecision(messageAuthorization.value);
  if (context.abort.aborted) return interrupted();
  if (!messageDecision) return immediateRequestStorageFailure();
  if (messageDecision.kind !== "allow")
    return authorizationFailure(messageDecision.kind, "Message");
  const requestAuthorization = await runUntilAborted(context.abort, () =>
    ports.requestAuthorization.authorizeRequest(
      {
        workspaceKey: context.workspaceKey,
        sourceSessionId: context.sourceSessionId,
        targetSessionId: args.session_id,
        operation: payload.value.kind,
        payloadSha256: payload.sha256,
        payloadByteLength: payload.byteLength,
        timeoutSeconds: payload.value.timeoutSeconds,
        createdAtMs,
        deadlineAtMs,
      },
      control,
    ),
  );
  if (requestAuthorization.kind === "aborted") return interrupted();
  if (requestAuthorization.kind === "rejected") return immediateRequestStorageFailure();
  const requestDecision = inspectRequestAuthorizationDecision(requestAuthorization.value);
  if (context.abort.aborted) return interrupted();
  if (!requestDecision) return immediateRequestStorageFailure();
  if (requestDecision.kind !== "allow")
    return authorizationFailure(requestDecision.kind, "Request");
  const finalVisibilitySettlement = await runUntilAborted(context.abort, () =>
    visible(ports, context, args.session_id),
  );
  if (finalVisibilitySettlement.kind === "aborted") return interrupted();
  if (finalVisibilitySettlement.kind === "rejected") {
    return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }
  const finalVisibility = finalVisibilitySettlement.value;
  if (!finalVisibility.ok) return finalVisibility;
  if (context.abort.aborted) return interrupted();
  return persistAndAdmitImmediateRequest(ports, {
    context,
    args,
    payload,
    workBytes,
    workSha256,
    createdAtMs,
    deadlineAtMs,
    interrupted,
  });
}

export async function createImmediateSessionRequest(
  ports: ImmediateSessionRequestPorts,
  context: ImmediateSessionRequestContext,
  args: ImmediateSessionRequestArguments,
): Promise<DomainResult<RequestMetadata>> {
  assertCommunicatorReady(ports.readiness, context.fencingToken);
  const control = createLinkedEffectControl({
    signals: [context.abort],
    deadlineMs: context.deadlineMs,
    clock: ports.clock,
  });
  if (!control)
    return domainFailure(
      "invalid_arguments",
      "Request creation deadline control is invalid.",
      false,
    );
  try {
    return await createImmediateSessionRequestInternal(
      ports,
      { ...context, abort: control.signal },
      args,
      context.abort,
    );
  } finally {
    control.dispose();
  }
}
