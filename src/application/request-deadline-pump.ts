import type { FencingToken } from "../domain/ownership";
import { OwnershipLostFault } from "../domain/ownership";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import type {
  AdvisoryLockExpirySchedule,
  AdvisoryLockPersistencePort,
} from "./advisory-lock-ports";
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
import { snapshotDataRecord } from "./strict-port-boundaries";

export const requestDeadlineMaximumBatchesPerPump = 22;
export const advisoryLockCleanupLimitPerPump = 1_024;

export type RequestDeadlineTimedSchedule = Readonly<{
  schedule: NextPendingRequestDeadline;
  elapsedMs: number;
  lockSchedule?: AdvisoryLockExpirySchedule;
  lockElapsedMs?: number;
}>;

export interface RequestDeadlinePumpOptions extends RequestDeadlineMaintenanceOptions {
  readonly requests: RequestDeadlinePersistencePort;
  readonly locks?: AdvisoryLockPersistencePort;
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

function expirySchedule(value: unknown): AdvisoryLockExpirySchedule | undefined {
  const row = snapshotDataRecord(value, 3);
  if (!row) return undefined;
  const keys = Object.keys(row);
  if (
    keys.length < 2 ||
    keys.length > 3 ||
    !keys.includes("storeObservedAtMs") ||
    !keys.includes("maximumSleepMs") ||
    !keys.every((key) => ["storeObservedAtMs", "maximumSleepMs", "nextExpiryAtMs"].includes(key)) ||
    !Number.isSafeInteger(row.storeObservedAtMs) ||
    (row.storeObservedAtMs as number) < 0 ||
    !Number.isSafeInteger(row.maximumSleepMs) ||
    (row.maximumSleepMs as number) < 1 ||
    (Object.hasOwn(row, "nextExpiryAtMs") &&
      (!Number.isSafeInteger(row.nextExpiryAtMs) || (row.nextExpiryAtMs as number) < 0))
  ) {
    return undefined;
  }
  return Object.freeze({
    storeObservedAtMs: row.storeObservedAtMs as number,
    maximumSleepMs: row.maximumSleepMs as number,
    ...(Object.hasOwn(row, "nextExpiryAtMs")
      ? { nextExpiryAtMs: row.nextExpiryAtMs as number }
      : {}),
  });
}

async function maintainExpiredLocks(context: RequestDeadlinePumpContext): Promise<boolean> {
  const locks = context.options.locks;
  if (!locks) return true;
  let returned: unknown;
  try {
    const settlement = await runUntilAborted(context.abort, () =>
      locks.cleanupExpired({
        fencingToken: context.options.fencingToken,
        workspaceKey: context.options.workspaceKey,
        limit: advisoryLockCleanupLimitPerPump,
      }),
    );
    if (settlement.kind === "aborted") return false;
    if (settlement.kind === "rejected") throw settlement.cause;
    returned = settlement.value;
  } catch (cause: unknown) {
    context.fail(cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_failure");
    return false;
  }
  if (!context.isActive()) return false;
  const cleanup = snapshotDataRecord(returned, 1);
  if (
    !cleanup ||
    Object.keys(cleanup).length !== 1 ||
    !Number.isSafeInteger(cleanup.deleted) ||
    (cleanup.deleted as number) < 0 ||
    (cleanup.deleted as number) > advisoryLockCleanupLimitPerPump
  ) {
    context.fail("port_contract_violation");
    return false;
  }
  return true;
}

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
  const requestAfter = context.readMonotonicMs();
  if (requestAfter === undefined) return undefined;
  if (requestAfter < before) {
    context.fail("port_contract_violation");
    return undefined;
  }
  const schedule = inspectPendingDeadlineSchedule(returned);
  if (!schedule) {
    context.fail("port_contract_violation");
    return undefined;
  }
  if (!context.options.locks) return { schedule, elapsedMs: requestAfter - before };
  const lock = await readLockSchedule(context, requestAfter);
  if (!lock) return undefined;
  return {
    schedule,
    elapsedMs: lock.after - before,
    lockSchedule: lock.schedule,
    lockElapsedMs: lock.after - requestAfter,
  };
}

async function readLockSchedule(
  context: RequestDeadlinePumpContext,
  before: number,
): Promise<{ readonly schedule: AdvisoryLockExpirySchedule; readonly after: number } | undefined> {
  let lockReturned: unknown;
  try {
    const settlement = await runUntilAborted(context.abort, () =>
      (context.options.locks as AdvisoryLockPersistencePort).readNextExpiry({
        fencingToken: context.options.fencingToken,
        workspaceKey: context.options.workspaceKey,
      }),
    );
    if (settlement.kind === "aborted") return undefined;
    if (settlement.kind === "rejected") throw settlement.cause;
    lockReturned = settlement.value;
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
  const lockSchedule = expirySchedule(lockReturned);
  if (!lockSchedule) {
    context.fail("port_contract_violation");
    return undefined;
  }
  return { schedule: lockSchedule, after };
}

async function expireMaintainAndRead(
  context: RequestDeadlinePumpContext,
  budget: RequestDeadlineInspectionBudget & { batches: number },
): Promise<RequestDeadlineTimedSchedule | undefined> {
  if (context.options.locks && !(await maintainExpiredLocks(context))) return undefined;
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
