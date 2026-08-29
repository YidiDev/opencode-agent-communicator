import type { GeneratedIdFactory } from "../domain/generated-ids";
import {
  digestMessageContent,
  type Sha256Digest,
  type Sha256DigestPort,
} from "../domain/message-payload";
import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import {
  canonicalizeSerializeAndDigestPendingRequestPayload,
  serializeVerifiedRequestEnvelope,
} from "../domain/request-serialization";
import type {
  PendingRequestMetadata,
  PendingRequestPayload,
  RequestMetadata,
} from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { wakeRequestScheduler } from "./blocking-request-creation-preconditions";
import type { RequestDeadlineWakePort } from "./blocking-session-request-boundaries";
import {
  assertCommunicatorReady,
  type CommunicatorReadinessPort,
} from "./communicator-readiness-port";
import type {
  ClockPort,
  CurrentWorkspaceMembershipPort,
  MessageAuthorizationPort,
  NativeQueueAdmissionPort,
  OwnershipPort,
} from "./delivery-ports";
import { inspectMessageAuthorizationDecision } from "./delivery-ports";
import type { RequestAuthorizationPort } from "./request-authorization-port";
import { inspectRequestAuthorizationDecision } from "./request-authorization-port";
import type { RequestAdmissionPersistencePort } from "./request-ports";
import { createLinkedEffectControl } from "./startup-effect-control";

export interface ImmediateSessionRequestPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly messageAuthorization: MessageAuthorizationPort;
  readonly requestAuthorization: RequestAuthorizationPort;
  readonly requests: RequestAdmissionPersistencePort;
  readonly scheduler: RequestDeadlineWakePort;
  readonly nativeQueue: NativeQueueAdmissionPort;
  readonly ownership: OwnershipPort;
  readonly clock: ClockPort;
  readonly ids: GeneratedIdFactory;
  readonly digest: Sha256DigestPort;
}

export interface ImmediateSessionRequestContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly fencingToken: FencingToken;
  readonly abort: AbortSignal;
  readonly deadlineMs: number;
}

export interface ImmediateSessionRequestArguments {
  readonly session_id: SessionId;
  readonly content: string;
  readonly request: PendingRequestPayload;
}

const storageFailure = (requestId?: string): DomainResult<never> =>
  domainFailure(
    "storage_unavailable",
    "Request storage is unavailable.",
    true,
    requestId ? { request_id: requestId } : undefined,
  );

async function visible(
  ports: ImmediateSessionRequestPorts,
  context: ImmediateSessionRequestContext,
  target: SessionId,
) {
  try {
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
  } catch {
    return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }
}

function authorizationFailure(
  kind: "deny" | "approval_rejected",
  label: string,
): DomainResult<never> {
  return kind === "deny"
    ? domainFailure("permission_denied", `${label} permission was denied.`, false)
    : domainFailure("approval_rejected", `${label} approval was rejected.`, false);
}

type CanonicalPendingPayload = Extract<
  Awaited<ReturnType<typeof canonicalizeSerializeAndDigestPendingRequestPayload>>,
  { readonly ok: true }
>;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear persistence and admission boundary makes the no-replay transition auditable.
async function persistAndAdmitImmediateRequest(
  ports: ImmediateSessionRequestPorts,
  context: ImmediateSessionRequestContext,
  args: ImmediateSessionRequestArguments,
  payload: CanonicalPendingPayload,
  workBytes: Uint8Array,
  workSha256: Sha256Digest,
  createdAtMs: number,
  deadlineAtMs: number,
  interrupted: () => DomainResult<never>,
): Promise<DomainResult<RequestMetadata>> {
  try {
    if ((await ports.ownership.isCurrent(context.fencingToken)) !== true)
      throw new OwnershipLostFault();
    if (context.abort.aborted) return interrupted();
    const requestId = ports.ids.requestId();
    const nativeMessageId = ports.ids.nativeMessageId();
    const creationOperationId = ports.ids.startOperationId();
    const prepared: PendingRequestMetadata & { readonly deliveryState: "prepared" } = {
      id: requestId,
      workspaceKey: context.workspaceKey,
      sourceSessionId: context.sourceSessionId,
      targetSessionId: args.session_id,
      nativeMessageId,
      deliveryMode: "queue",
      kind: payload.value.kind,
      resolutionState: "pending",
      deliveryState: "prepared",
      resultState: "none",
      payloadByteLength: payload.byteLength,
      payloadSha256: payload.sha256,
      createdAtMs,
      updatedAtMs: createdAtMs,
      deadlineAtMs,
    };
    let envelope: string;
    try {
      envelope = await serializeVerifiedRequestEnvelope(
        {
          ...prepared,
          requestId,
          payload: payload.value,
          work: { content: args.content, byteLength: workBytes.length, sha256: workSha256 },
        },
        ports.digest,
      );
    } catch (cause: unknown) {
      if (cause instanceof RangeError) {
        return domainFailure(
          "invalid_arguments",
          "Combined work and request content exceeds the request envelope limit.",
          false,
        );
      }
      throw cause;
    }
    const persisted = await ports.requests.createPrepared({
      fencingToken: context.fencingToken,
      creationOperationId,
      deliveryMode: "queue",
      request: prepared,
      payloadJson: payload.serialized,
      envelopeJson: envelope,
    });
    if (!persisted.ok)
      return persisted.code === "quota_exceeded"
        ? domainFailure("quota_exceeded", "Request quota is exhausted.", false)
        : persisted.code === "rate_limited"
          ? domainFailure("rate_limited", "Request creation is rate limited.", true)
          : storageFailure(requestId);
    wakeRequestScheduler(ports.scheduler);
    if (context.abort.aborted) return interrupted();
    const claimed = await ports.requests.claimPrepared({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      requestId,
    });
    if (!claimed.ok) return storageFailure(requestId);
    if (claimed.request.deliveryState !== "submitting" || claimed.envelopeJson === undefined) {
      return { ok: true, value: claimed.request };
    }
    let native: Awaited<ReturnType<NativeQueueAdmissionPort["queueMessage"]>>;
    if (context.abort.aborted) native = { kind: "unknown" };
    else {
      const admission = await runUntilAborted(context.abort, () =>
        ports.nativeQueue.queueMessage({
          targetSessionId: args.session_id,
          nativeMessageId,
          envelope: claimed.envelopeJson,
          abort: context.abort,
        }),
      );
      native = admission.kind === "settled" ? admission.value : { kind: "unknown" };
    }
    const base = {
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      requestId,
    };
    const completion =
      native.kind === "unknown"
        ? { ...base, outcome: "delivery_unknown" as const }
        : native.kind === "definitive_rejection"
          ? { ...base, outcome: "delivery_failed" as const }
          : native.kind === "promoted"
            ? {
                ...base,
                outcome: "promoted" as const,
                nativeMessageId,
                admittedSeq: native.admittedSeq,
                promotedSeq: native.promotedSeq,
                evidenceObservedAtMs: native.observedAtMs,
              }
            : {
                ...base,
                outcome: "admitted" as const,
                nativeMessageId,
                admittedSeq: native.kind === "public_message" ? 0 : native.admittedSeq,
                evidenceObservedAtMs: native.observedAtMs,
              };
    const completed = await ports.requests.completeDelivery(completion);
    return completed.ok ? { ok: true, value: completed.request } : storageFailure(requestId);
  } catch (cause) {
    return cause instanceof OwnershipLostFault
      ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
      : storageFailure();
  }
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
    return storageFailure();
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
  if (messageAuthorization.kind === "rejected") return storageFailure();
  const messageDecision = inspectMessageAuthorizationDecision(messageAuthorization.value);
  if (context.abort.aborted) return interrupted();
  if (!messageDecision) return storageFailure();
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
  if (requestAuthorization.kind === "rejected") return storageFailure();
  const requestDecision = inspectRequestAuthorizationDecision(requestAuthorization.value);
  if (context.abort.aborted) return interrupted();
  if (!requestDecision) return storageFailure();
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
  return persistAndAdmitImmediateRequest(
    ports,
    context,
    args,
    payload,
    workBytes,
    workSha256,
    createdAtMs,
    deadlineAtMs,
    interrupted,
  );
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
