import type { GeneratedIdFactory, RequestId } from "../domain/generated-ids";
import {
  digestMessageContent,
  type Sha256Digest,
  type Sha256DigestPort,
} from "../domain/message-payload";
import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import type { canonicalizeSerializeAndDigestPendingRequestPayload } from "../domain/request-serialization";
import { serializeVerifiedRequestEnvelope } from "../domain/request-serialization";
import type { PendingRequestMetadata, RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { wakeRequestScheduler } from "./blocking-request-creation-preconditions";
import type { RequestDeadlineWakePort } from "./blocking-session-request-boundaries";
import { boundedExternalCall } from "./bounded-external-call";
import {
  type CommunicatorReadinessPort,
  stopCommunicatorForOwnershipLoss,
} from "./communicator-readiness-port";
import type { ContextAdmissionPersistencePort } from "./context-admission-ports";
import type {
  ContextAdmissionRegistration,
  ContextAdmissionRuntimePort,
} from "./context-admission-runtime";
import type { ClockPort, NativeQueueAdmissionPort, OwnershipPort } from "./delivery-ports";
import type { ParticipantOperationPort } from "./participant-operation-gate";
import {
  ParticipantOperationAbortedFault,
  ParticipantOperationCapacityFault,
} from "./participant-operation-gate";
import type {
  RequestAdmissionPersistencePort,
  RequestParticipantActivityPort,
} from "./request-ports";
import { waitForContextAdmission } from "./wait-for-context-admission";

export interface ImmediateRequestAdmissionPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly requests: RequestAdmissionPersistencePort;
  readonly scheduler: RequestDeadlineWakePort;
  readonly contexts?: ContextAdmissionPersistencePort;
  /** Legacy test and persisted-recovery seam; new existing-root requests never call it. */
  readonly nativeQueue: NativeQueueAdmissionPort;
  readonly contextRuntime?: ContextAdmissionRuntimePort;
  readonly activity?: RequestParticipantActivityPort;
  readonly participantOperations?: ParticipantOperationPort;
  readonly ownership: OwnershipPort;
  readonly ids: GeneratedIdFactory;
  readonly digest: Sha256DigestPort;
  readonly clock: ClockPort;
}

export interface ImmediateRequestAdmissionContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly fencingToken: FencingToken;
  readonly abort: AbortSignal;
  readonly deadlineMs?: number;
}

export interface ImmediateRequestAdmissionArguments {
  readonly session_id: SessionId;
  readonly content: string;
}

type CanonicalPendingPayload = Extract<
  Awaited<ReturnType<typeof canonicalizeSerializeAndDigestPendingRequestPayload>>,
  { readonly ok: true }
>;

export interface ImmediateRequestAdmissionInput {
  readonly context: ImmediateRequestAdmissionContext;
  readonly args: ImmediateRequestAdmissionArguments;
  readonly payload: CanonicalPendingPayload;
  readonly workBytes: Uint8Array;
  readonly workSha256: Sha256Digest;
  readonly createdAtMs: number;
  readonly deadlineAtMs: number;
  readonly interrupted: () => DomainResult<never>;
}

export const immediateRequestStorageFailure = (requestId?: string): DomainResult<never> =>
  domainFailure(
    "storage_unavailable",
    "Request storage is unavailable.",
    true,
    requestId ? { request_id: requestId } : undefined,
  );

function ownershipLost(
  ports: ImmediateRequestAdmissionPorts,
  requestId?: RequestId,
): DomainResult<never> {
  stopCommunicatorForOwnershipLoss(ports.readiness);
  return domainFailure(
    "ownership_lost",
    "Coordinator ownership was lost.",
    false,
    requestId ? { request_id: requestId } : undefined,
  );
}

function readContextAdmission(
  contexts: ContextAdmissionPersistencePort,
  context: ImmediateRequestAdmissionContext,
  requestId: RequestId,
  deadlineMs: number,
) {
  return boundedExternalCall(
    () =>
      contexts.getContextAdmission({
        fencingToken: context.fencingToken,
        workspaceKey: context.workspaceKey,
        id: requestId,
      }),
    new AbortController().signal,
    deadlineMs,
  );
}

function contextReadDeadline(clock: ClockPort, invocationDeadlineMs: number | undefined) {
  const nowMs = clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return undefined;
  return (
    Date.now() +
    (invocationDeadlineMs === undefined ? 1_000 : Math.max(0, invocationDeadlineMs - nowMs))
  );
}

function readAdmittedRequest(
  requests: RequestAdmissionPersistencePort,
  getRequestMetadata: NonNullable<RequestAdmissionPersistencePort["getRequestMetadata"]>,
  context: ImmediateRequestAdmissionContext,
  requestId: RequestId,
  deadlineMs: number,
) {
  return boundedExternalCall(
    () =>
      getRequestMetadata.call(requests, {
        fencingToken: context.fencingToken,
        workspaceKey: context.workspaceKey,
        requestId,
      }),
    new AbortController().signal,
    deadlineMs,
  );
}

function immediatePreparedRequest(
  input: ImmediateRequestAdmissionInput,
  requestId: RequestId,
  nativeMessageId: ReturnType<GeneratedIdFactory["nativeMessageId"]>,
): PendingRequestMetadata & { readonly deliveryState: "prepared" } {
  const { context, args, payload, createdAtMs, deadlineAtMs } = input;
  return {
    id: requestId,
    workspaceKey: context.workspaceKey,
    sourceSessionId: context.sourceSessionId,
    targetSessionId: args.session_id,
    nativeMessageId,
    deliveryMode: "context",
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
}

// One linear persistence and admission boundary preserves the auditable no-replay transition.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: persistence, ownership, and the single native effect must remain ordered.
export async function persistAndAdmitImmediateRequest(
  ports: ImmediateRequestAdmissionPorts,
  input: ImmediateRequestAdmissionInput,
): Promise<DomainResult<RequestMetadata>> {
  const { context, args, payload, workBytes, workSha256 } = input;
  const contexts = ports.contexts;
  const contextRuntime = ports.contextRuntime;
  const activity = ports.activity;
  const participantOperations = ports.participantOperations;
  const getRequestMetadata = ports.requests.getRequestMetadata;
  if (!contexts || !contextRuntime || !activity || !participantOperations || !getRequestMetadata) {
    return immediateRequestStorageFailure();
  }
  let registration: ContextAdmissionRegistration | undefined;
  try {
    if ((await ports.ownership.isCurrent(context.fencingToken)) !== true)
      throw new OwnershipLostFault();
    if (context.abort.aborted) return input.interrupted();
    const requestId = ports.ids.requestId();
    const nativeMessageId = ports.ids.nativeMessageId();
    const creationOperationId = ports.ids.startOperationId();
    const prepared = immediatePreparedRequest(input, requestId, nativeMessageId);
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
    const envelopeBytes = new TextEncoder().encode(envelope);
    const envelopeDigest = await runUntilAborted(context.abort, () =>
      digestMessageContent(ports.digest, envelopeBytes),
    );
    if (envelopeDigest.kind !== "settled") return input.interrupted();
    try {
      registration = contextRuntime.attach({
        id: requestId,
        kind: "request",
        sourceSessionId: context.sourceSessionId,
        workspaceKey: context.workspaceKey,
      });
    } catch {
      return domainFailure(
        "quota_exceeded",
        "Context delivery waiter capacity is exhausted.",
        false,
      );
    }
    const persisted = await participantOperations.run(
      [context.sourceSessionId, args.session_id],
      context.abort,
      async () => {
        const observed = await activity.observeRequestParticipants(
          context.workspaceKey,
          context.sourceSessionId,
          args.session_id,
          context.abort,
        );
        if (!observed.sourceVisible) {
          return {
            kind: "failure" as const,
            result: domainFailure("caller_not_visible", "Caller is not visible.", false),
          };
        }
        if (!observed.targetVisible) {
          return {
            kind: "failure" as const,
            result: domainFailure("target_not_visible", "Target is not visible.", false),
          };
        }
        if (observed.targetStatus === "idle") {
          return {
            kind: "failure" as const,
            result: domainFailure("target_idle", "Target is idle.", true),
          };
        }
        if (observed.targetStatus !== "busy" && observed.targetStatus !== "retry") {
          return {
            kind: "failure" as const,
            result: domainFailure("target_status_unknown", "Target activity is unknown.", true),
          };
        }
        return {
          kind: "store" as const,
          result: await ports.requests.createPrepared({
            fencingToken: context.fencingToken,
            creationOperationId,
            deliveryMode: "context",
            request: prepared,
            payloadJson: payload.serialized,
            envelopeJson: envelope,
            contextAdmission: {
              requestId,
              envelopeJson: envelope,
              contentByteLength: envelopeBytes.length,
              contentSha256: envelopeDigest.value,
            },
          }),
        };
      },
    );
    if (persisted.kind === "failure") {
      return persisted.result;
    }
    const stored = persisted.result;
    if (!stored.ok) {
      return stored.code === "ownership_lost"
        ? ownershipLost(ports, requestId)
        : stored.code === "quota_exceeded"
          ? domainFailure("quota_exceeded", "Request quota is exhausted.", false)
          : stored.code === "rate_limited"
            ? domainFailure("rate_limited", "Request creation is rate limited.", true)
            : immediateRequestStorageFailure(requestId);
    }
    wakeRequestScheduler(ports.scheduler);
    const readDeadlineMs = contextReadDeadline(ports.clock, context.deadlineMs);
    if (readDeadlineMs === undefined) return immediateRequestStorageFailure(requestId);
    const contextAdmissionRead = await readContextAdmission(
      contexts,
      context,
      requestId,
      readDeadlineMs,
    );
    if (
      contextAdmissionRead.kind === "rejected" &&
      contextAdmissionRead.cause instanceof OwnershipLostFault
    ) {
      return ownershipLost(ports, requestId);
    }
    if (contextAdmissionRead.kind !== "value" || !contextAdmissionRead.value) {
      return immediateRequestStorageFailure(requestId);
    }
    const contextAdmission = contextAdmissionRead.value;
    const admissionRegistration = registration;
    registration = undefined;
    const admission = await waitForContextAdmission(
      {
        contexts,
        requests: {
          getRequestMetadata: (requestInput) =>
            getRequestMetadata.call(ports.requests, requestInput),
        },
      },
      {
        fencingToken: context.fencingToken,
        workspaceKey: context.workspaceKey,
        admission: contextAdmission,
        registration: admissionRegistration,
        abort: context.abort,
        ...(context.deadlineMs === undefined ? {} : { deadlineMs: context.deadlineMs }),
      },
    );
    if (!admission.ok) {
      return admission.error.code === "ownership_lost"
        ? ownershipLost(ports, requestId)
        : admission;
    }
    const requestRead = await readAdmittedRequest(
      ports.requests,
      getRequestMetadata,
      context,
      requestId,
      readDeadlineMs,
    );
    if (requestRead.kind === "rejected" && requestRead.cause instanceof OwnershipLostFault) {
      return ownershipLost(ports, requestId);
    }
    if (requestRead.kind !== "value") return immediateRequestStorageFailure(requestId);
    const request = requestRead.value;
    return request?.deliveryState === "context_admitted"
      ? { ok: true, value: request }
      : immediateRequestStorageFailure(requestId);
  } catch (cause) {
    if (cause instanceof OwnershipLostFault) {
      return ownershipLost(ports);
    }
    if (cause instanceof ParticipantOperationAbortedFault) return input.interrupted();
    return cause instanceof ParticipantOperationCapacityFault
      ? domainFailure("quota_exceeded", "Participant operation capacity is exhausted.", false)
      : immediateRequestStorageFailure();
  } finally {
    registration?.detach();
  }
}
