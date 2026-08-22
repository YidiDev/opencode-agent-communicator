import { type DeliveryMetadata, isCoherentDeliveryMetadata } from "../domain/deliveries";
import type { GeneratedIdFactory } from "../domain/generated-ids";
import {
  digestMessageContent,
  type Sha256DigestPort,
  serializeVerifiedMessageEnvelope,
  validateMessageContent,
} from "../domain/message-payload";
import type { FencingToken } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import { sanitizeDisplayTitle } from "../domain/sanitize-display";
import { type SessionId, validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { admitClaimedMessage, deliveryStoreFailure } from "./admit-message-delivery";
import type {
  ClockPort,
  CurrentRootMembership,
  CurrentWorkspaceMembershipPort,
  DeliveryClaimResult,
  DeliveryPersistencePort,
  MessageAuthorizationPort,
  NativeQueueAdmissionPort,
  OwnershipPort,
} from "./delivery-ports";

export interface SessionSendArguments {
  readonly session_id: unknown;
  readonly content: unknown;
}

export interface SessionSendContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly abort: AbortSignal;
  readonly deadlineMs?: number;
}

export interface SessionSendPorts {
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly authorization: MessageAuthorizationPort;
  readonly deliveries: DeliveryPersistencePort;
  readonly nativeQueue: NativeQueueAdmissionPort;
  readonly ownership: OwnershipPort;
  readonly clock: ClockPort;
  readonly ids: GeneratedIdFactory;
  readonly digest: Sha256DigestPort;
}

function visibilityFailure(membership: CurrentRootMembership): DomainResult<never> | undefined {
  if (!membership.sourceVisible) {
    return domainFailure(
      "caller_not_visible",
      "Caller is not a current visible root session.",
      false,
    );
  }
  if (!membership.targetVisible) {
    return domainFailure(
      "target_not_visible",
      "Target is not a current visible root session.",
      false,
    );
  }
  return undefined;
}

async function readMembership(
  ports: SessionSendPorts,
  context: SessionSendContext,
  target: SessionId,
): Promise<DomainResult<CurrentRootMembership>> {
  try {
    const value = await ports.membership.readCurrentRoots(
      context.workspaceKey,
      context.sourceSessionId,
      target,
    );
    return { ok: true, value };
  } catch (_cause: unknown) {
    return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }
}

async function cancelPrepared(
  ports: SessionSendPorts,
  context: SessionSendContext,
  deliveryId: DeliveryMetadata["id"],
  fencingToken: FencingToken,
): Promise<DomainResult<DeliveryMetadata>> {
  const result = await ports.deliveries.cancelPrepared({
    fencingToken,
    workspaceKey: context.workspaceKey,
    deliveryId,
    nowMs: ports.clock.nowMs(),
  });
  if (!result.ok) return deliveryStoreFailure(result.code);
  return isCoherentDeliveryMetadata(result.delivery)
    ? { ok: true, value: result.delivery }
    : deliveryStoreFailure("state_conflict", deliveryId);
}

interface ValidatedSendInput {
  readonly target: SessionId;
  readonly content: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
}

function validateSendArguments(args: SessionSendArguments): DomainResult<ValidatedSendInput> {
  const target = validateSessionId(args.session_id);
  if (!target.ok) return domainFailure("invalid_arguments", target.message, false);
  const content = validateMessageContent(args.content);
  if (!content.ok) return domainFailure("invalid_arguments", content.message, false);
  return {
    ok: true,
    value: {
      target: target.value,
      content: args.content as string,
      bytes: content.bytes,
      byteLength: content.byteLength,
    },
  };
}

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
  if (!currentMembership.ok || visibilityFailure(currentMembership.value)) {
    context.abort.removeEventListener("abort", onAbort);
    const cancelled = await (abortCancellation ??
      cancelPrepared(ports, context, delivery.id, fencingToken));
    if (!cancelled.ok) return cancelled;
    if (!currentMembership.ok) return currentMembership;
    return visibilityFailure(currentMembership.value) ?? deliveryStoreFailure("state_conflict");
  }
  if (context.abort.aborted) {
    context.abort.removeEventListener("abort", onAbort);
    return abortCancellation ?? cancelPrepared(ports, context, delivery.id, fencingToken);
  }
  if (!(await ports.ownership.isCurrent(fencingToken))) {
    context.abort.removeEventListener("abort", onAbort);
    const cancelled = await (abortCancellation ??
      cancelPrepared(ports, context, delivery.id, fencingToken));
    return cancelled.ok ? deliveryStoreFailure("ownership_lost") : cancelled;
  }

  const submitting: DeliveryClaimResult = await ports.deliveries.claimPrepared({
    fencingToken,
    workspaceKey: context.workspaceKey,
    deliveryId: delivery.id,
    nowMs: ports.clock.nowMs(),
  });
  context.abort.removeEventListener("abort", onAbort);
  if (!submitting.ok) return deliveryStoreFailure(submitting.code, delivery.id);
  if (!isCoherentDeliveryMetadata(submitting.delivery)) {
    return deliveryStoreFailure("state_conflict", delivery.id);
  }
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
  });
}

export async function sendSessionMessage(
  ports: SessionSendPorts,
  context: SessionSendContext,
  args: SessionSendArguments,
): Promise<DomainResult<DeliveryMetadata>> {
  const input = validateSendArguments(args);
  if (!input.ok) return input;
  const initialMembership = await readMembership(ports, context, input.value.target);
  if (!initialMembership.ok) return initialMembership;
  const initialVisibility = visibilityFailure(initialMembership.value);
  if (initialVisibility) return initialVisibility;

  const deliveryId = ports.ids.deliveryId();
  const nativeMessageId = ports.ids.nativeMessageId();
  const digest = await digestMessageContent(ports.digest, input.value.bytes);
  const fencingToken = await ports.ownership.acquire();
  const authorization = await ports.authorization.authorizeMessage(
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
  if (authorization.kind === "deny") {
    return domainFailure("permission_denied", "Message permission was denied.", false);
  }
  if (authorization.kind === "approval_rejected") {
    return domainFailure("approval_rejected", "Message approval was rejected.", false);
  }
  const persistenceMembership = await readMembership(ports, context, input.value.target);
  if (!persistenceMembership.ok) return persistenceMembership;
  const persistenceVisibility = visibilityFailure(persistenceMembership.value);
  if (persistenceVisibility) return persistenceVisibility;
  const envelope = serializeVerifiedMessageEnvelope({
    sourceSessionId: context.sourceSessionId,
    targetSessionId: input.value.target,
    workspaceKey: context.workspaceKey,
    deliveryId,
    content: input.value.content,
    sourceTitle: sanitizeDisplayTitle(persistenceMembership.value.sourceTitle ?? ""),
  });
  const prepared = await ports.deliveries.createPrepared({
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
  });
  if (!prepared.ok) return deliveryStoreFailure(prepared.code);
  if (!isCoherentDeliveryMetadata(prepared.delivery)) {
    return deliveryStoreFailure("state_conflict", deliveryId);
  }
  return submitPrepared(ports, context, input.value.target, prepared.delivery, fencingToken);
}
