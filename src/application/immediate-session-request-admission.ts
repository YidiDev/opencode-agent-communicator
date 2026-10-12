import type { GeneratedIdFactory, RequestId } from "../domain/generated-ids";
import type { Sha256Digest, Sha256DigestPort } from "../domain/message-payload";
import { type FencingToken, OwnershipLostFault } from "../domain/ownership";
import { hasRequestIdentity, snapshotRequestIdentity } from "../domain/request-identity";
import type { canonicalizeSerializeAndDigestPendingRequestPayload } from "../domain/request-serialization";
import { serializeVerifiedRequestEnvelope } from "../domain/request-serialization";
import type { PendingRequestMetadata, RequestMetadata } from "../domain/request-types";
import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { admitClaimedSessionRequest } from "./admit-claimed-session-request";
import { wakeRequestScheduler } from "./blocking-request-creation-preconditions";
import type { RequestDeadlineWakePort } from "./blocking-session-request-boundaries";
import {
  type CommunicatorReadinessPort,
  stopCommunicatorForOwnershipLoss,
} from "./communicator-readiness-port";
import type { ContextAdmissionPersistencePort } from "./context-admission-ports";
import type { ContextAdmissionRuntimePort } from "./context-admission-runtime";
import type { ClockPort, NativeQueueAdmissionPort, OwnershipPort } from "./delivery-ports";
import type { ParticipantOperationPort } from "./participant-operation-gate";
import type {
  RequestAdmissionPersistencePort,
  RequestParticipantActivityPort,
} from "./request-ports";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import { snapshotDataRecord } from "./strict-port-boundaries";

export interface ImmediateRequestAdmissionPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly requests: RequestAdmissionPersistencePort;
  readonly scheduler: RequestDeadlineWakePort;
  readonly nativeQueue: NativeQueueAdmissionPort;
  /** Retained composition compatibility; public queue admission does not consume context state. */
  readonly contexts?: ContextAdmissionPersistencePort;
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

function inspectStoreRequest(
  raw: unknown,
  expected: RequestMetadata,
): DomainResult<RequestMetadata> {
  const result = snapshotDataRecord(raw, 3);
  if (!result) return immediateRequestStorageFailure(expected.id);
  if (result.ok === false) {
    return result.code === "ownership_lost"
      ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false, {
          request_id: expected.id,
        })
      : result.code === "quota_exceeded"
        ? domainFailure("quota_exceeded", "Request quota is exhausted.", false)
        : result.code === "rate_limited"
          ? domainFailure("rate_limited", "Request creation is rate limited.", true)
          : immediateRequestStorageFailure(expected.id);
  }
  const request = inspectRequestMetadata(result.request);
  return result.ok === true &&
    request &&
    hasRequestIdentity(snapshotRequestIdentity(expected), request)
    ? { ok: true, value: request }
    : immediateRequestStorageFailure(expected.id);
}

// The prepared record precedes the sole queue effect. Any interrupted or malformed claim remains
// durable for startup classification; the native effect is never retried by this invocation.
export async function persistAndAdmitImmediateRequest(
  ports: ImmediateRequestAdmissionPorts,
  input: ImmediateRequestAdmissionInput,
): Promise<DomainResult<RequestMetadata>> {
  const { context, args, payload, workBytes, workSha256, createdAtMs, deadlineAtMs } = input;
  let requestId: RequestId | undefined;
  try {
    if ((await ports.ownership.isCurrent(context.fencingToken)) !== true)
      throw new OwnershipLostFault();
    if (context.abort.aborted) return input.interrupted();
    const generatedRequestId = ports.ids.requestId();
    requestId = generatedRequestId;
    const nativeMessageId = ports.ids.nativeMessageId();
    const prepared: PendingRequestMetadata & { readonly deliveryState: "prepared" } = {
      id: generatedRequestId,
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
          requestId: generatedRequestId,
          payload: payload.value,
          work: { content: args.content, byteLength: workBytes.length, sha256: workSha256 },
        },
        ports.digest,
      );
    } catch (cause: unknown) {
      if (cause instanceof RangeError)
        return domainFailure(
          "invalid_arguments",
          "Combined work and request content exceeds the request envelope limit.",
          false,
        );
      throw cause;
    }
    const created = await runUntilAborted(context.abort, () =>
      ports.requests.createPrepared({
        fencingToken: context.fencingToken,
        creationOperationId: ports.ids.startOperationId(),
        deliveryMode: "queue",
        request: prepared,
        payloadJson: payload.serialized,
        envelopeJson: envelope,
      }),
    );
    if (created.kind === "aborted") return input.interrupted();
    if (created.kind === "rejected") throw created.cause;
    const stored = inspectStoreRequest(created.value, prepared);
    if (!stored.ok) return stored;
    wakeRequestScheduler(ports.scheduler);
    if (stored.value.deliveryState !== "prepared") return { ok: true, value: stored.value };

    const claimed = await runUntilAborted(context.abort, () =>
      ports.requests.claimPrepared({
        fencingToken: context.fencingToken,
        workspaceKey: context.workspaceKey,
        requestId: generatedRequestId,
      }),
    );
    if (claimed.kind === "aborted") return input.interrupted();
    if (claimed.kind === "rejected") throw claimed.cause;
    const claimData = snapshotDataRecord(claimed.value, 3);
    const claimedRequest = inspectRequestMetadata(claimData?.request);
    if (
      claimData?.ok !== true ||
      !claimedRequest ||
      !hasRequestIdentity(snapshotRequestIdentity(prepared), claimedRequest)
    ) {
      return immediateRequestStorageFailure(requestId);
    }
    if (claimedRequest.deliveryState !== "submitting") return { ok: true, value: claimedRequest };
    if (typeof claimData.envelopeJson !== "string")
      return immediateRequestStorageFailure(requestId);
    const admitted = await admitClaimedSessionRequest(
      {
        requests: ports.requests,
        nativeQueue: ports.nativeQueue,
        nativeSteer: {
          steerRequest: async () => {
            throw new Error("queue request cannot use steer admission");
          },
        },
        ownership: ports.ownership,
        notifications: { notifyTerminal: () => undefined },
        clock: ports.clock,
      },
      {
        workspaceKey: context.workspaceKey,
        fencingToken: context.fencingToken,
        request: claimedRequest,
        envelope: claimData.envelopeJson,
        control: {
          abort: context.abort,
          ...(context.deadlineMs === undefined ? {} : { deadlineMs: context.deadlineMs }),
        },
        effectSignal: context.abort,
        callerAbortPersistsUnknown: true,
      },
    );
    return admitted.ok ? { ok: true, value: admitted.value.request } : admitted;
  } catch (cause: unknown) {
    return cause instanceof OwnershipLostFault
      ? ownershipLost(ports, requestId)
      : immediateRequestStorageFailure(requestId);
  }
}
