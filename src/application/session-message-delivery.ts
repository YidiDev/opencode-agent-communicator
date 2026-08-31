import type { ContextAdmissionMetadata } from "../domain/context-admissions";
import type { DeliveryMetadata } from "../domain/deliveries";
import { digestMessageContent, serializeVerifiedMessageEnvelope } from "../domain/message-payload";
import { type DomainResult, domainFailure } from "../domain/results";
import { sanitizeDisplayTitle } from "../domain/sanitize-display";
import { deliveryStoreFailure } from "./admit-message-delivery";
import { boundedExternalCall } from "./bounded-external-call";
import {
  assertCommunicatorReady,
  communicatorLifecycleFencingToken,
  stopCommunicatorForOwnershipLoss,
} from "./communicator-readiness-port";
import { inspectMessageAuthorizationDecision } from "./delivery-ports";
import { inspectDeliveryMutation } from "./message-recovery-boundaries";
import { sendContextSessionMessage } from "./session-context-message-delivery";
import type { SessionSendContext, SessionSendPorts } from "./session-message-delivery-contracts";
import { readSessionSendMembership } from "./session-message-membership";
import {
  schedulePreparedCancellation,
  submitPreparedMessage,
} from "./session-message-prepared-submission";
import {
  type SessionSendArguments,
  sendVisibilityFailure,
  validateSendArguments,
} from "./session-send-validation";

export type {
  SessionSendContext,
  SessionSendPorts,
} from "./session-message-delivery-contracts";
export type { SessionSendArguments } from "./session-send-validation";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ordered authorization, preparation, and submission boundaries remain deliberately linear.
export async function sendSessionMessage(
  ports: SessionSendPorts,
  context: SessionSendContext,
  args: SessionSendArguments,
): Promise<DomainResult<DeliveryMetadata | ContextAdmissionMetadata>> {
  assertCommunicatorReady(ports.readiness);
  const input = validateSendArguments(args);
  if (!input.ok) return input;
  if (input.value.delivery === "context") {
    return sendContextSessionMessage(ports, context, input.value);
  }
  const initialMembership = await readSessionSendMembership(ports, context, input.value.target);
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
  const persistenceMembership = await readSessionSendMembership(ports, context, input.value.target);
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
  const submitted = await submitPreparedMessage(
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
