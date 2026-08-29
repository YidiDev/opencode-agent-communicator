import type { GeneratedIdFactory } from "../domain/generated-ids";
import type { Sha256Digest, Sha256DigestPort } from "../domain/message-payload";
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
import type { NativeQueueAdmissionPort, OwnershipPort } from "./delivery-ports";
import type { RequestAdmissionPersistencePort } from "./request-ports";

export interface ImmediateRequestAdmissionPorts {
  readonly requests: RequestAdmissionPersistencePort;
  readonly scheduler: RequestDeadlineWakePort;
  readonly nativeQueue: NativeQueueAdmissionPort;
  readonly ownership: OwnershipPort;
  readonly ids: GeneratedIdFactory;
  readonly digest: Sha256DigestPort;
}

export interface ImmediateRequestAdmissionContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly fencingToken: FencingToken;
  readonly abort: AbortSignal;
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

// One linear persistence and admission boundary preserves the auditable no-replay transition.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: persistence, ownership, and the single native effect must remain ordered.
export async function persistAndAdmitImmediateRequest(
  ports: ImmediateRequestAdmissionPorts,
  input: ImmediateRequestAdmissionInput,
): Promise<DomainResult<RequestMetadata>> {
  const { context, args, payload, workBytes, workSha256, createdAtMs, deadlineAtMs } = input;
  try {
    if ((await ports.ownership.isCurrent(context.fencingToken)) !== true)
      throw new OwnershipLostFault();
    if (context.abort.aborted) return input.interrupted();
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
          : immediateRequestStorageFailure(requestId);
    wakeRequestScheduler(ports.scheduler);
    if (context.abort.aborted) return input.interrupted();
    const claimed = await ports.requests.claimPrepared({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      requestId,
    });
    if (!claimed.ok) return immediateRequestStorageFailure(requestId);
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
    return completed.ok
      ? { ok: true, value: completed.request }
      : immediateRequestStorageFailure(requestId);
  } catch (cause) {
    return cause instanceof OwnershipLostFault
      ? domainFailure("ownership_lost", "Coordinator ownership was lost.", false)
      : immediateRequestStorageFailure();
  }
}
