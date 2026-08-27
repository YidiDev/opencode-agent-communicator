import type { FencingToken } from "../domain/ownership";
import type { WorkspaceKey } from "../domain/workspaces";
import {
  type DeliveryRetentionPersistencePort,
  drainDeliveryRetention,
} from "./delivery-retention";
import { drainRequestMaintenance, type RequestMaintenancePorts } from "./request-maintenance";

export type RequestDeadlinePumpFaultCode =
  | "ownership_lost"
  | "storage_failure"
  | "port_contract_violation";

type MaintenanceResult = Readonly<{ readonly ok: boolean; readonly code?: string }>;

export interface RequestDeadlineMaintenanceOptions {
  readonly maintenance?: RequestMaintenancePorts;
  readonly additionalMaintenance?: (
    shouldStop: () => boolean,
    abort: AbortSignal,
  ) => Promise<MaintenanceResult>;
  readonly deliveryRetention?: DeliveryRetentionPersistencePort;
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
}

export type RequestDeadlineMaintenanceDecision =
  | Readonly<{ readonly kind: "complete" }>
  | Readonly<{ readonly kind: "stopped" }>
  | Readonly<{ readonly kind: "failed"; readonly code: RequestDeadlinePumpFaultCode }>;

function classifyMaintenanceFailure(code: string | undefined): RequestDeadlinePumpFaultCode {
  if (code === "ownership_lost") return "ownership_lost";
  return code === "contract" ? "port_contract_violation" : "storage_failure";
}

export async function runRequestDeadlineMaintenance(input: {
  readonly options: RequestDeadlineMaintenanceOptions;
  readonly isActive: () => boolean;
  readonly abort: AbortSignal;
}): Promise<RequestDeadlineMaintenanceDecision> {
  const shouldStop = () => !input.isActive();
  const { options } = input;
  if (options.maintenance) {
    const result = await drainRequestMaintenance({
      ports: options.maintenance,
      fencingToken: options.fencingToken,
      workspaceKey: options.workspaceKey,
      shouldStop,
      abort: input.abort,
    });
    if (!input.isActive()) return { kind: "stopped" };
    if (!result.ok) return { kind: "failed", code: classifyMaintenanceFailure(result.code) };
  }
  if (options.additionalMaintenance) {
    const result = await options.additionalMaintenance(shouldStop, input.abort);
    if (!input.isActive()) return { kind: "stopped" };
    if (!result.ok) return { kind: "failed", code: classifyMaintenanceFailure(result.code) };
  }
  if (!options.deliveryRetention) {
    return input.isActive() ? { kind: "complete" } : { kind: "stopped" };
  }
  const result = await drainDeliveryRetention({
    persistence: options.deliveryRetention,
    fencingToken: options.fencingToken,
    workspaceKey: options.workspaceKey,
    shouldStop,
    abort: input.abort,
  });
  if (!input.isActive()) return { kind: "stopped" };
  return result.ok
    ? { kind: "complete" }
    : { kind: "failed", code: classifyMaintenanceFailure(result.code) };
}
