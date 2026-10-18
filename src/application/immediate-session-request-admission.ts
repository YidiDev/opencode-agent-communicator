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

export async function persistAndAdmitImmediateRequest(
  ports: ImmediateRequestAdmissionPorts,
  input: ImmediateRequestAdmissionInput,
): Promise<DomainResult<RequestMetadata>> {
  if (input.context.abort.aborted) return input.interrupted();
  // Caller cancellation releases the foreground, while lifecycle-owned persistence settles the
  // one claim and records ambiguity. It must not strand a current-generation submitting record.
  const result = await runUntilAborted(input.context.abort, () =>
    settleImmediateRequest(ports, input),
  );
  return result.kind === "aborted"
    ? input.interrupted()
    : result.kind === "rejected"
      ? immediateRequestStorageFailure()
      : result.value;
}

async function settleImmediateRequest(
  ports: ImmediateRequestAdmissionPorts,
  input: ImmediateRequestAdmissionInput,
): Promise<DomainResult<RequestMetadata>> {
  const { context, args, payload, workBytes, workSha256, createdAtMs, deadlineAtMs } = input;
  const effectSignal = admissionEffectSignal(ports);
  let requestId: RequestId | undefined;
  let expected: RequestMetadata | undefined;
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
    expected = prepared;
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
    const created = await runUntilAborted(effectSignal, () =>
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
    if (stored.value.deliveryState !== "prepared")
      return reconcileImmediateClaim(ports, context, prepared, effectSignal);

    const claimed = await runUntilAborted(effectSignal, () =>
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
      throw new Error("Immediate claim requires durable reconciliation.");
    }
    if (claimedRequest.deliveryState !== "submitting") return { ok: true, value: claimedRequest };
    if (typeof claimData.envelopeJson !== "string")
      throw new Error("Immediate claim envelope requires durable reconciliation.");
    const admitted = await admitClaimedSessionRequest(
      {
        ...ports,
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
        effectSignal,
        callerAbortPersistsUnknown: true,
      },
    );
    return admitted.ok ? { ok: true, value: admitted.value.request } : admitted;
  } catch (cause: unknown) {
    return reconcileImmediateFailure(ports, context, expected, effectSignal, cause, requestId);
  }
}

function reconcileImmediateFailure(
  ports: ImmediateRequestAdmissionPorts,
  context: ImmediateRequestAdmissionContext,
  expected: RequestMetadata | undefined,
  signal: AbortSignal,
  cause: unknown,
  requestId: RequestId | undefined,
): Promise<DomainResult<RequestMetadata>> | DomainResult<RequestMetadata> {
  if (cause instanceof OwnershipLostFault) return ownershipLost(ports, requestId);
  return expected
    ? reconcileImmediateClaim(ports, context, expected, signal)
    : immediateRequestStorageFailure(requestId);
}

function admissionEffectSignal(ports: ImmediateRequestAdmissionPorts): AbortSignal {
  return ports.contextRuntime?.effectSignal ?? new AbortController().signal;
}

async function reconcileImmediateClaim(
  ports: ImmediateRequestAdmissionPorts,
  context: ImmediateRequestAdmissionContext,
  expected: RequestMetadata,
  signal: AbortSignal,
): Promise<DomainResult<RequestMetadata>> {
  try {
    const input = {
      workspaceKey: context.workspaceKey,
      fencingToken: context.fencingToken,
      requestId: expected.id,
    };
    const settled = await runUntilAborted(signal, () =>
      ports.requests.reconcilePreparedClaim(input),
    );
    if (settled.kind === "rejected") throw settled.cause;
    if (settled.kind !== "settled") return immediateRequestStorageFailure(expected.id);
    const data = snapshotDataRecord(settled.value, 3);
    const current = inspectRequestMetadata(data?.request);
    if (!current || !hasRequestIdentity(snapshotRequestIdentity(expected), current))
      return immediateRequestStorageFailure(expected.id);
    if (
      data?.outcome === "settled" &&
      (current.deliveryState !== "submitting" || current.resolutionState !== "pending")
    )
      return { ok: true, value: current };
    if (
      data?.outcome !== "current_claim" ||
      current.deliveryState !== "submitting" ||
      current.resolutionState !== "pending"
    ) {
      return immediateRequestStorageFailure(expected.id);
    }
    const completion = await runUntilAborted(signal, () =>
      ports.requests.completeDelivery({ ...input, outcome: "delivery_unknown" }),
    );
    if (completion.kind === "rejected") throw completion.cause;
    if (completion.kind !== "settled") return immediateRequestStorageFailure(expected.id);
    const result = inspectStoreRequest(completion.value, expected);
    return result.ok && result.value.deliveryState !== "delivery_unknown"
      ? immediateRequestStorageFailure(expected.id)
      : result;
  } catch (cause: unknown) {
    return cause instanceof OwnershipLostFault
      ? ownershipLost(ports, expected.id)
      : immediateRequestStorageFailure(expected.id);
  }
}
