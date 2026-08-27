import type { DeliveryMetadata } from "../domain/deliveries";
import type { GeneratedIdFactory } from "../domain/generated-ids";
import {
  digestMessageContent,
  type Sha256DigestPort,
  serializeVerifiedMessageEnvelope,
} from "../domain/message-payload";
import type { FencingToken } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import { sanitizeDisplayTitle } from "../domain/sanitize-display";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { admitClaimedMessage, deliveryStoreFailure } from "./admit-message-delivery";
import { boundedExternalCall } from "./bounded-external-call";
import {
  assertCommunicatorReady,
  type CommunicatorReadinessPort,
  communicatorLifecycleFencingToken,
  stopCommunicatorForOwnershipLoss,
} from "./communicator-readiness-port";
import {
  type ClockPort,
  type CurrentRootMembership,
  type CurrentWorkspaceMembershipPort,
  type DeliveryPersistencePort,
  inspectMessageAuthorizationDecision,
  type MessageAuthorizationPort,
  type NativeQueueAdmissionPort,
  type OwnershipPort,
} from "./delivery-ports";
import { inspectDeliveryMutation, inspectMembership } from "./message-recovery-boundaries";
import {
  type SessionSendArguments,
  sendVisibilityFailure,
  validateSendArguments,
} from "./session-send-validation";

export type { SessionSendArguments } from "./session-send-validation";

export interface SessionSendContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly abort: AbortSignal;
  readonly deadlineMs?: number;
}

export interface SessionSendPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly authorization: MessageAuthorizationPort;
  readonly deliveries: DeliveryPersistencePort;
  readonly nativeQueue: NativeQueueAdmissionPort;
  readonly ownership: OwnershipPort;
  readonly clock: ClockPort;
  readonly ids: GeneratedIdFactory;
  readonly digest: Sha256DigestPort;
}

// biome-ignore format: keep the bounded membership call visually linear.
async function readMembership(
  ports: SessionSendPorts,
  context: SessionSendContext,
  target: SessionId,
): Promise<DomainResult<CurrentRootMembership>> {
  const operation = () => ports.membership.readCurrentRoots(
      context.workspaceKey,
      context.sourceSessionId,
      target,
    );
  if (context.deadlineMs !== undefined) {
    const result = await boundedExternalCall(operation, context.abort, context.deadlineMs);
    if (result.kind === "expired") {
      return domainFailure("deadline_expired", "Message invocation deadline expired.", false);
    }
    if (result.kind === "rejected") {
      return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
    }
    const membership = inspectMembership(result.value);
    return membership
      ? { ok: true, value: membership }
      : domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }
  try {
    const membership = inspectMembership(await operation());
    return membership
      ? { ok: true, value: membership }
      : domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  } catch {
    return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }
}

async function cancelPrepared(
  ports: SessionSendPorts,
  context: SessionSendContext,
  deliveryId: DeliveryMetadata["id"],
  fencingToken: FencingToken,
): Promise<DomainResult<DeliveryMetadata>> {
  let pending: Promise<unknown> | undefined;
  const operation = () => {
    pending = Promise.resolve(
      ports.deliveries.cancelPrepared({
        fencingToken,
        workspaceKey: context.workspaceKey,
        deliveryId,
        nowMs: ports.clock.nowMs(),
      }),
    );
    pending.catch(() => undefined);
    return pending;
  };
  const settlement =
    context.deadlineMs === undefined
      ? await Promise.resolve()
          .then(operation)
          .then(
            (value) => ({ kind: "value" as const, value }),
            (cause: unknown) => ({ kind: "rejected" as const, cause }),
          )
      : await boundedExternalCall(operation, context.abort, context.deadlineMs);
  if (settlement.kind === "expired") {
    if (pending === undefined) superviseCancellation(operation);
    return domainFailure("deadline_expired", "Message invocation deadline expired.", false);
  }
  if (settlement.kind === "rejected")
    return deliveryStoreFailure("storage_unavailable", deliveryId);
  const result = inspectDeliveryMutation(settlement.value);
  if (!result) return deliveryStoreFailure("state_conflict", deliveryId);
  if (!result.ok) return deliveryStoreFailure(result.code, deliveryId);
  return result.delivery.state === "cancelled"
    ? { ok: true, value: result.delivery }
    : deliveryStoreFailure("state_conflict", deliveryId);
}

function superviseCancellation(operation: () => Promise<unknown>): void {
  try {
    Promise.resolve(operation()).catch(() => undefined);
  } catch {}
}

function schedulePreparedCancellation(
  ports: SessionSendPorts,
  context: SessionSendContext,
  deliveryId: DeliveryMetadata["id"],
  fencingToken: FencingToken,
): void {
  superviseCancellation(() =>
    ports.deliveries.cancelPrepared({
      fencingToken,
      workspaceKey: context.workspaceKey,
      deliveryId,
      nowMs: ports.clock.nowMs(),
    }),
  );
}

function admissionUnknown(
  deliveryId: DeliveryMetadata["id"],
  message: string,
): DomainResult<never> {
  return domainFailure("admission_unknown", message, false, { delivery_id: deliveryId });
}

function reconcileUncertainClaim(
  ports: SessionSendPorts,
  context: SessionSendContext,
  fencingToken: FencingToken,
  deliveryId: DeliveryMetadata["id"],
  pending?: Promise<unknown>,
  cancelPreparedState = true,
): void {
  if (cancelPreparedState) {
    schedulePreparedCancellation(ports, context, deliveryId, fencingToken);
  }
  pending?.then(
    (raw) => {
      const claim = inspectDeliveryMutation(raw);
      if (!claim?.ok || claim.delivery.state !== "submitting") return;
      try {
        Promise.resolve(
          ports.deliveries.completeSubmission({
            fencingToken,
            workspaceKey: context.workspaceKey,
            deliveryId,
            state: "admission_unknown",
            nowMs: ports.clock.nowMs(),
          }),
        ).catch(() => undefined);
      } catch {}
    },
    () => undefined,
  );
}

// biome-ignore-all format: keep durable pre-claim and post-claim branches visibly distinct.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this linear boundary distinguishes cancellable prepared work from ambiguous claimed/native effects.
async function submitPrepared(
  ports: SessionSendPorts,
  context: SessionSendContext,
  target: SessionId,
  delivery: DeliveryMetadata,
  fencingToken: FencingToken,
): Promise<DomainResult<DeliveryMetadata>> {
  let abortCancellation: Promise<DomainResult<DeliveryMetadata>> | undefined;
  const onAbort = (): void => {
    abortCancellation ??= cancelPrepared(ports, context, delivery.id, fencingToken);
  };
  context.abort.addEventListener("abort", onAbort, { once: true });
  if (context.abort.aborted) onAbort();

  const currentMembership = await readMembership(ports, context, target);
  if (!currentMembership.ok || sendVisibilityFailure(currentMembership.value)) {
    context.abort.removeEventListener("abort", onAbort);
    if (!currentMembership.ok && currentMembership.error.code === "deadline_expired") {
      const cancellation = abortCancellation ?? cancelPrepared(ports, context, delivery.id, fencingToken);
      cancellation.catch(() => undefined);
      return currentMembership;
    }
    const cancelled = await (abortCancellation ??
      cancelPrepared(ports, context, delivery.id, fencingToken));
    if (!cancelled.ok) return cancelled;
    if (!currentMembership.ok) return currentMembership;
    return sendVisibilityFailure(currentMembership.value) ?? deliveryStoreFailure("state_conflict");
  }
  if (context.abort.aborted) {
    context.abort.removeEventListener("abort", onAbort);
    return abortCancellation ?? cancelPrepared(ports, context, delivery.id, fencingToken);
  }
  const ownership = context.deadlineMs === undefined
    ? await Promise.resolve().then(() => ports.ownership.isCurrent(fencingToken)).then(
        (value) => ({ kind: "value" as const, value }),
        (cause: unknown) => ({ kind: "rejected" as const, cause }),
      )
    : await boundedExternalCall(
        () => ports.ownership.isCurrent(fencingToken),
        context.abort,
        context.deadlineMs,
      );
  if (ownership.kind === "expired") {
    context.abort.removeEventListener("abort", onAbort);
    schedulePreparedCancellation(ports, context, delivery.id, fencingToken);
    return domainFailure("deadline_expired", "Message invocation deadline expired.", false);
  }
  if (ownership.kind === "rejected" || ownership.value !== true) {
    context.abort.removeEventListener("abort", onAbort);
    const cancelled = await (abortCancellation ??
      cancelPrepared(ports, context, delivery.id, fencingToken));
    return cancelled.ok ? deliveryStoreFailure("ownership_lost") : cancelled;
  }

  let pendingClaim: Promise<unknown> | undefined;
  const claimOperation = () => {
    pendingClaim = Promise.resolve(ports.deliveries.claimPrepared({
      fencingToken,
      workspaceKey: context.workspaceKey,
      deliveryId: delivery.id,
      nowMs: ports.clock.nowMs(),
    }));
    pendingClaim.catch(() => undefined);
    return pendingClaim;
  };
  const claim = context.deadlineMs === undefined
    ? await Promise.resolve().then(claimOperation).then(
        (value) => ({ kind: "value" as const, value }),
        (cause: unknown) => ({ kind: "rejected" as const, cause }),
      )
    : await boundedExternalCall(claimOperation, context.abort, context.deadlineMs);
  context.abort.removeEventListener("abort", onAbort);
  abortCancellation?.catch(() => undefined);
  if (claim.kind === "expired" && pendingClaim === undefined) {
    if (abortCancellation === undefined) {
      schedulePreparedCancellation(ports, context, delivery.id, fencingToken);
    }
    return domainFailure("deadline_expired", "Message invocation deadline expired.", false);
  }
  if (claim.kind === "expired" || claim.kind === "rejected") {
    reconcileUncertainClaim(
      ports,
      context,
      fencingToken,
      delivery.id,
      pendingClaim,
      abortCancellation === undefined,
    );
    return admissionUnknown(
      delivery.id,
      "Message claim outcome could not be determined before invocation settlement.",
    );
  }
  const inspectedClaim = inspectDeliveryMutation(claim.value);
  if (!inspectedClaim) {
    reconcileUncertainClaim(ports, context, fencingToken, delivery.id);
    return admissionUnknown(delivery.id, "Message claim outcome was malformed and is uncertain.");
  }
  const submitting = inspectedClaim;
  if (!submitting.ok) return deliveryStoreFailure(submitting.code, delivery.id);
  if (submitting.delivery.state === "cancelled") return { ok: true, value: submitting.delivery };
  if (submitting.delivery.state !== "submitting" || submitting.envelope === undefined) {
    return deliveryStoreFailure("state_conflict");
  }
  return admitClaimedMessage(ports, {
    workspaceKey: context.workspaceKey,
    fencingToken,
    delivery: submitting.delivery,
    envelope: submitting.envelope,
    abort: context.abort,
    ...(context.deadlineMs === undefined ? {} : { deadlineMs: context.deadlineMs }),
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ordered authorization, preparation, and submission boundaries remain deliberately linear.
export async function sendSessionMessage(
  ports: SessionSendPorts,
  context: SessionSendContext,
  args: SessionSendArguments,
): Promise<DomainResult<DeliveryMetadata>> {
  assertCommunicatorReady(ports.readiness);
  const input = validateSendArguments(args);
  if (!input.ok) return input;
  const initialMembership = await readMembership(ports, context, input.value.target);
  if (!initialMembership.ok) return initialMembership;
  const initialVisibility = sendVisibilityFailure(initialMembership.value);
  if (initialVisibility) return initialVisibility;

  const deliveryId = ports.ids.deliveryId();
  const nativeMessageId = ports.ids.nativeMessageId();
  const digestCall =
    context.deadlineMs === undefined
      ? await Promise.resolve()
          .then(() => digestMessageContent(ports.digest, input.value.bytes))
          .then(
            (value) => ({ kind: "value" as const, value }),
            (cause: unknown) => ({ kind: "rejected" as const, cause }),
          )
      : await boundedExternalCall(
          () => digestMessageContent(ports.digest, input.value.bytes),
          context.abort,
          context.deadlineMs,
        );
  if (digestCall.kind === "expired") {
    return domainFailure("deadline_expired", "Message invocation deadline expired.", false);
  }
  if (digestCall.kind === "rejected") {
    return domainFailure("storage_unavailable", "Message digest is unavailable.", true);
  }
  const digest = digestCall.value;
  const fencingToken = communicatorLifecycleFencingToken(ports.readiness);
  const initialOwnership =
    context.deadlineMs === undefined
      ? await Promise.resolve()
          .then(() => ports.ownership.isCurrent(fencingToken))
          .then(
            (value) => ({ kind: "value" as const, value }),
            (cause: unknown) => ({ kind: "rejected" as const, cause }),
          )
      : await boundedExternalCall(
          () => ports.ownership.isCurrent(fencingToken),
          context.abort,
          context.deadlineMs,
        );
  if (initialOwnership.kind === "expired") {
    return domainFailure("deadline_expired", "Message invocation deadline expired.", false);
  }
  if (initialOwnership.kind === "rejected" || initialOwnership.value !== true) {
    stopCommunicatorForOwnershipLoss(ports.readiness);
    return deliveryStoreFailure("ownership_lost");
  }
  const authorize = () =>
    ports.authorization.authorizeMessage(
      {
        workspaceKey: context.workspaceKey,
        sourceSessionId: context.sourceSessionId,
        targetSessionId: input.value.target,
        operation: "message",
        contentSha256: digest,
        contentByteLength: input.value.byteLength,
      },
      {
        abort: context.abort,
        ...(context.deadlineMs === undefined ? {} : { deadlineMs: context.deadlineMs }),
      },
    );
  const authorizationCall =
    context.deadlineMs === undefined
      ? await Promise.resolve()
          .then(authorize)
          .then(
            (value) => ({ kind: "value" as const, value }),
            (cause: unknown) => ({ kind: "rejected" as const, cause }),
          )
      : await boundedExternalCall(authorize, context.abort, context.deadlineMs);
  if (authorizationCall.kind === "expired") {
    return domainFailure("deadline_expired", "Message invocation deadline expired.", false);
  }
  if (authorizationCall.kind === "rejected") {
    return domainFailure("storage_unavailable", "Message authorization is unavailable.", true);
  }
  const authorization = inspectMessageAuthorizationDecision(authorizationCall.value);
  if (!authorization) {
    return domainFailure("storage_unavailable", "Message authorization is unavailable.", true);
  }
  if (authorization.kind === "deny") {
    return domainFailure("permission_denied", "Message permission was denied.", false);
  }
  if (authorization.kind === "approval_rejected") {
    return domainFailure("approval_rejected", "Message approval was rejected.", false);
  }
  const persistenceMembership = await readMembership(ports, context, input.value.target);
  if (!persistenceMembership.ok) return persistenceMembership;
  const persistenceVisibility = sendVisibilityFailure(persistenceMembership.value);
  if (persistenceVisibility) return persistenceVisibility;
  const envelope = serializeVerifiedMessageEnvelope({
    sourceSessionId: context.sourceSessionId,
    targetSessionId: input.value.target,
    workspaceKey: context.workspaceKey,
    deliveryId,
    content: input.value.content,
    sourceTitle: sanitizeDisplayTitle(persistenceMembership.value.sourceTitle ?? ""),
  });
  const prepareInput = {
    fencingToken,
    id: deliveryId,
    workspaceKey: context.workspaceKey,
    sourceSessionId: context.sourceSessionId,
    targetSessionId: input.value.target,
    nativeMessageId,
    envelope,
    contentByteLength: input.value.byteLength,
    contentSha256: digest,
    nowMs: ports.clock.nowMs(),
  };
  let pendingPrepare: Promise<unknown> | undefined;
  const createPrepared = () => {
    pendingPrepare = Promise.resolve(ports.deliveries.createPrepared(prepareInput));
    pendingPrepare.catch(() => undefined);
    return pendingPrepare;
  };
  const prepareCall =
    context.deadlineMs === undefined
      ? await Promise.resolve()
          .then(createPrepared)
          .then(
            (value) => ({ kind: "value" as const, value }),
            (cause: unknown) => ({ kind: "rejected" as const, cause }),
          )
      : await boundedExternalCall(createPrepared, context.abort, context.deadlineMs);
  if (prepareCall.kind === "expired") {
    schedulePreparedCancellation(ports, context, deliveryId, fencingToken);
    pendingPrepare?.then(
      (raw) => {
        const late = inspectDeliveryMutation(raw);
        if (late?.ok && late.delivery.id === deliveryId && late.delivery.state === "prepared") {
          schedulePreparedCancellation(ports, context, deliveryId, fencingToken);
        }
      },
      () => undefined,
    );
    return domainFailure("deadline_expired", "Message invocation deadline expired.", false);
  }
  if (prepareCall.kind === "rejected") {
    schedulePreparedCancellation(ports, context, deliveryId, fencingToken);
    return deliveryStoreFailure("storage_unavailable", deliveryId);
  }
  const prepared = inspectDeliveryMutation(prepareCall.value);
  if (!prepared) {
    return deliveryStoreFailure("state_conflict", deliveryId);
  }
  if (!prepared.ok) return deliveryStoreFailure(prepared.code);
  if (prepared.delivery.state !== "prepared")
    return deliveryStoreFailure("state_conflict", deliveryId);
  const submitted = await submitPrepared(
    ports,
    context,
    input.value.target,
    prepared.delivery,
    fencingToken,
  );
  if (!submitted.ok && submitted.error.code === "ownership_lost") {
    stopCommunicatorForOwnershipLoss(ports.readiness);
  }
  return submitted;
}
