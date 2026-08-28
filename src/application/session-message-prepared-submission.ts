import type { DeliveryMetadata } from "../domain/deliveries";
import type { FencingToken } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import { admitClaimedMessage, deliveryStoreFailure } from "./admit-message-delivery";
import { boundedExternalCall } from "./bounded-external-call";
import { inspectDeliveryMutation } from "./message-recovery-boundaries";
import type { SessionSendContext, SessionSendPorts } from "./session-message-delivery-contracts";
import { readSessionSendMembership } from "./session-message-membership";
import { sendVisibilityFailure } from "./session-send-validation";

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

export function schedulePreparedCancellation(
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
export async function submitPreparedMessage(
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

  const currentMembership = await readSessionSendMembership(ports, context, target);
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
