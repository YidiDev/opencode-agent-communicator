import type { FencingToken } from "../domain/ownership";
import { OwnershipLostFault } from "../domain/ownership";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import { inspectPendingDeadlineSchedule } from "./request-deadline-boundaries";
import {
  inspectRequestDeadlineExpiration,
  type RequestDeadlineInspectionBudget,
  requestDeadlineBatchLimit,
} from "./request-deadline-inspection";
import {
  type RequestDeadlineMaintenanceOptions,
  type RequestDeadlinePumpFaultCode,
  runRequestDeadlineMaintenance,
} from "./request-deadline-maintenance";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import type { NextPendingRequestDeadline, RequestDeadlinePersistencePort } from "./request-ports";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";

export const requestDeadlineMaximumBatchesPerPump = 22;

export type RequestDeadlineTimedSchedule = Readonly<{
  schedule: NextPendingRequestDeadline;
  elapsedMs: number;
}>;

export interface RequestDeadlinePumpOptions extends RequestDeadlineMaintenanceOptions {
  readonly requests: RequestDeadlinePersistencePort;
  readonly notifications: CommittedRequestNotificationPort;
  readonly fencingToken: FencingToken;
  readonly workspaceKey: WorkspaceKey;
}

export interface RequestDeadlinePumpContext {
  readonly options: RequestDeadlinePumpOptions;
  readonly abort: AbortSignal;
  readonly isActive: () => boolean;
  readonly consumeDirty: () => boolean;
  readonly readMonotonicMs: () => number | undefined;
  readonly applySchedule: (schedule: RequestDeadlineTimedSchedule) => boolean;
  readonly fail: (code: RequestDeadlinePumpFaultCode) => void;
}

type BatchDecision = "full" | "done" | "stopped";

async function expireBatch(
  context: RequestDeadlinePumpContext,
  budget: RequestDeadlineInspectionBudget,
): Promise<BatchDecision> {
  let returned: unknown;
  try {
    const settlement = await runUntilAborted(context.abort, () =>
      context.options.requests.expireDueRequests({
        fencingToken: context.options.fencingToken,
        workspaceKey: context.options.workspaceKey,
        limit: requestDeadlineBatchLimit,
      }),
    );
    if (settlement.kind === "aborted") return "stopped";
    if (settlement.kind === "rejected") throw settlement.cause;
    returned = settlement.value;
  } catch (cause: unknown) {
    context.fail(cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_failure");
    return "stopped";
  }
  if (!context.isActive()) return "stopped";
  const inspected = inspectRequestDeadlineExpiration(
    returned,
    budget,
    context.options.workspaceKey,
  );
  if (!inspected.ok) {
    context.fail(inspected.code);
    return "stopped";
  }
  for (const request of inspected.requests) {
    try {
      notifyTerminalSafely(
        context.options.notifications,
        createTerminalNotificationEvent(request as never),
      );
    } catch {
      context.fail("port_contract_violation");
      return "stopped";
    }
  }
  return inspected.requests.length === requestDeadlineBatchLimit ? "full" : "done";
}

async function readSchedule(
  context: RequestDeadlinePumpContext,
): Promise<RequestDeadlineTimedSchedule | undefined> {
  if (!context.isActive()) return undefined;
  const before = context.readMonotonicMs();
  if (before === undefined) return undefined;
  let returned: unknown;
  try {
    const settlement = await runUntilAborted(context.abort, () =>
      context.options.requests.readNextPendingDeadline({
        fencingToken: context.options.fencingToken,
        workspaceKey: context.options.workspaceKey,
      }),
    );
    if (settlement.kind === "aborted") return undefined;
    if (settlement.kind === "rejected") throw settlement.cause;
    returned = settlement.value;
  } catch (cause: unknown) {
    context.fail(cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_failure");
    return undefined;
  }
  if (!context.isActive()) return undefined;
  const after = context.readMonotonicMs();
  if (after === undefined) return undefined;
  if (after < before) {
    context.fail("port_contract_violation");
    return undefined;
  }
  const schedule = inspectPendingDeadlineSchedule(returned);
  if (schedule) return { schedule, elapsedMs: after - before };
  context.fail("port_contract_violation");
  return undefined;
}

async function expireMaintainAndRead(
  context: RequestDeadlinePumpContext,
  budget: RequestDeadlineInspectionBudget & { batches: number },
): Promise<RequestDeadlineTimedSchedule | undefined> {
  while (context.isActive()) {
    budget.batches += 1;
    if (budget.batches > requestDeadlineMaximumBatchesPerPump) {
      context.fail("port_contract_violation");
      return undefined;
    }
    const decision = await expireBatch(context, budget);
    if (decision === "stopped") return undefined;
    if (decision === "done") break;
  }
  const maintenance = await runRequestDeadlineMaintenance({
    options: context.options,
    isActive: context.isActive,
    abort: context.abort,
  });
  if (maintenance.kind === "stopped") return undefined;
  if (maintenance.kind === "failed") {
    context.fail(maintenance.code);
    return undefined;
  }
  return readSchedule(context);
}

export async function runRequestDeadlinePump(context: RequestDeadlinePumpContext): Promise<void> {
  const budget = { seen: new Set<string>(), expiredRows: 0, batches: 0 };
  try {
    while (context.isActive() && context.consumeDirty()) {
      const schedule = await expireMaintainAndRead(context, budget);
      if (!context.isActive() || !schedule) return;
      if (!context.applySchedule(schedule)) return;
    }
  } catch (cause: unknown) {
    context.fail(cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_failure");
  }
}
