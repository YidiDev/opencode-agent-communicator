import { isCoherentDeliveryMetadata, type ParticipantDelivery } from "../domain/deliveries";
import { validateDeliveryId } from "../domain/generated-ids";
import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { CurrentWorkspaceMembershipPort, DeliveryPersistencePort } from "./delivery-ports";

export interface SessionDeliveryGetContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
}

export interface SessionDeliveryGetPorts {
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly deliveries: DeliveryPersistencePort;
}

const hiddenFailure = (): DomainResult<never> =>
  domainFailure(
    "not_found_or_unauthorized",
    "Delivery was not found or the caller is not authorized.",
    false,
  );

export async function getSessionDelivery(
  ports: SessionDeliveryGetPorts,
  context: SessionDeliveryGetContext,
  args: { readonly delivery_id: unknown },
): Promise<DomainResult<ParticipantDelivery>> {
  const deliveryId = validateDeliveryId(args.delivery_id);
  if (!deliveryId.ok) return domainFailure("invalid_arguments", deliveryId.message, false);

  try {
    const membership = await ports.membership.readCurrentRoots(
      context.workspaceKey,
      context.sourceSessionId,
      context.sourceSessionId,
    );
    if (!membership.sourceVisible) {
      return domainFailure(
        "caller_not_visible",
        "Caller is not a current visible root session.",
        false,
      );
    }
  } catch (_cause: unknown) {
    return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }

  try {
    const found = await ports.deliveries.getForParticipant({
      workspaceKey: context.workspaceKey,
      deliveryId: deliveryId.value,
      participantSessionId: context.sourceSessionId,
    });
    return found && isCoherentDeliveryMetadata(found.delivery)
      ? { ok: true, value: found }
      : hiddenFailure();
  } catch (_cause: unknown) {
    return domainFailure("storage_unavailable", "Delivery storage is unavailable.", true);
  }
}
