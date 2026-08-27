import { isCoherentDeliveryMetadata, type ParticipantDelivery } from "../domain/deliveries";
import { validateDeliveryId } from "../domain/generated-ids";
import { OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { boundedExternalCall } from "./bounded-external-call";
import {
  assertCommunicatorReady,
  type CommunicatorReadinessPort,
} from "./communicator-readiness-port";
import type { CurrentWorkspaceMembershipPort, DeliveryPersistencePort } from "./delivery-ports";

export interface SessionDeliveryGetContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly abort?: AbortSignal;
  readonly deadlineMs?: number;
}

async function invoke<Value>(context: SessionDeliveryGetContext, operation: () => Promise<Value>) {
  if (context.abort && context.deadlineMs !== undefined) {
    return boundedExternalCall(operation, context.abort, context.deadlineMs);
  }
  try {
    return { kind: "value" as const, value: await operation() };
  } catch (cause: unknown) {
    return { kind: "rejected" as const, cause };
  }
}

export interface SessionDeliveryGetPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly deliveries: DeliveryPersistencePort;
}

const hiddenFailure = (): DomainResult<never> =>
  domainFailure(
    "not_found_or_unauthorized",
    "Delivery was not found or the caller is not authorized.",
    false,
  );

// biome-ignore format: keep the bounded port branches adjacent to their exact public mappings.
export async function getSessionDelivery(
  ports: SessionDeliveryGetPorts,
  context: SessionDeliveryGetContext,
  args: { readonly delivery_id: unknown },
): Promise<DomainResult<ParticipantDelivery>> {
  assertCommunicatorReady(ports.readiness);
  const deliveryId = validateDeliveryId(args.delivery_id);
  if (!deliveryId.ok) return domainFailure("invalid_arguments", deliveryId.message, false);

  {
    const membershipCall = await invoke(context, () => ports.membership.readCurrentRoots(
      context.workspaceKey,
      context.sourceSessionId,
      context.sourceSessionId,
    ));
    if (membershipCall.kind === "expired") {
      return domainFailure("deadline_expired", "Delivery query invocation deadline expired.", false);
    }
    if (membershipCall.kind === "rejected") {
      if (membershipCall.cause instanceof OwnershipLostFault) {
        return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
      }
      return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
    }
    const membership = membershipCall.value;
    if (!membership.sourceVisible) {
      return domainFailure(
        "caller_not_visible",
        "Caller is not a current visible root session.",
        false,
      );
    }
  }

  {
    const foundCall = await invoke(context, () => ports.deliveries.getForParticipant({
      workspaceKey: context.workspaceKey,
      deliveryId: deliveryId.value,
      participantSessionId: context.sourceSessionId,
    }));
    if (foundCall.kind === "expired") {
      return domainFailure("deadline_expired", "Delivery query invocation deadline expired.", false);
    }
    if (foundCall.kind === "rejected") {
      if (foundCall.cause instanceof OwnershipLostFault) {
        return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
      }
      return domainFailure("storage_unavailable", "Delivery storage is unavailable.", true);
    }
    const found = foundCall.value;
    return found && isCoherentDeliveryMetadata(found.delivery)
      ? { ok: true, value: found }
      : hiddenFailure();
  }
}
