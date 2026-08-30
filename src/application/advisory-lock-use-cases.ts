import {
  type AdvisoryLock,
  advisoryLockPolicy,
  validateAdvisoryLockDescription,
  validateAdvisoryLockInstructions,
  validateAdvisoryLockTitle,
  validateAdvisoryLockTtlSeconds,
} from "../domain/advisory-locks";
import { validateAdvisoryLockId } from "../domain/generated-ids";
import { OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import { validateSessionId } from "../domain/sessions";
import type {
  AdvisoryLockListValue,
  AdvisoryLockMutationKind,
  AdvisoryLockMutationValue,
  AdvisoryLockNotificationSummary,
  AdvisoryLockPostCommitNotificationPort,
  AdvisoryLockUseCaseContext,
  AdvisoryLockUseCasePorts,
  AdvisoryLockWakePort,
} from "./advisory-lock-contracts";
import { decodeAdvisoryLockCursor, encodeAdvisoryLockCursor } from "./advisory-lock-cursor";
import type { AdvisoryLockStoreFailureCode } from "./advisory-lock-ports";
import {
  assertCommunicatorReady,
  stopCommunicatorForOwnershipLoss,
} from "./communicator-readiness-port";

export type {
  AdvisoryLockListValue,
  AdvisoryLockMutationKind,
  AdvisoryLockMutationValue,
  AdvisoryLockNotificationSummary,
  AdvisoryLockPostCommitNotificationPort,
  AdvisoryLockUseCaseContext,
  AdvisoryLockUseCasePorts,
  AdvisoryLockWakePort,
} from "./advisory-lock-contracts";
export { decodeAdvisoryLockCursor, encodeAdvisoryLockCursor } from "./advisory-lock-cursor";

export const advisoryLockListDefaultLimit = 50;
const maximumNotificationCount = 100;

export const noOpAdvisoryLockWakePort: AdvisoryLockWakePort = Object.freeze({
  wakeAdvisoryLockExpiry: () => undefined,
});

const zeroNotificationSummary = Object.freeze({ eligible: 0, admitted: 0, unknown: 0 });

export const noOpAdvisoryLockNotificationPort: AdvisoryLockPostCommitNotificationPort =
  Object.freeze({
    notifyAdvisoryLockMutation: async () => zeroNotificationSummary,
  });

function hasNonemptyUtf8(value: string): boolean {
  return new TextEncoder().encode(value).length > 0;
}

function invalid(message: string): DomainResult<never> {
  return domainFailure("invalid_arguments", message, false);
}

async function visibleCaller(
  ports: AdvisoryLockUseCasePorts,
  context: AdvisoryLockUseCaseContext,
): Promise<DomainResult<SessionId>> {
  assertCommunicatorReady(ports.readiness, context.fencingToken);
  const caller = validateSessionId(context.callerSessionId);
  if (!caller.ok) return invalid(caller.message);
  try {
    const membership = await ports.membership.readCurrentRoots(
      context.workspaceKey,
      caller.value,
      caller.value,
    );
    return membership.sourceVisible
      ? { ok: true, value: caller.value }
      : domainFailure("caller_not_visible", "Caller is not a current visible root session.", false);
  } catch {
    return domainFailure("caller_not_visible", "Caller visibility could not be verified.", true);
  }
}

function storeFailure(
  ports: AdvisoryLockUseCasePorts,
  code: AdvisoryLockStoreFailureCode,
): DomainResult<never> {
  if (code === "ownership_lost") {
    stopCommunicatorForOwnershipLoss(ports.readiness);
    return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
  }
  if (code === "quota_exceeded") {
    return domainFailure("quota_exceeded", "The active advisory lock quota was reached.", false);
  }
  if (code === "not_found_or_unauthorized") {
    return domainFailure(
      "not_found_or_unauthorized",
      "The advisory lock was not found or is not held by the caller.",
      false,
    );
  }
  return domainFailure("storage_unavailable", "Advisory lock storage is unavailable.", true);
}

function storageException(ports: AdvisoryLockUseCasePorts, cause: unknown): DomainResult<never> {
  if (cause instanceof OwnershipLostFault) {
    return storeFailure(ports, "ownership_lost");
  }
  return storeFailure(ports, "storage_unavailable");
}

function coherentSummary(value: AdvisoryLockNotificationSummary): boolean {
  const counts = [value.eligible, value.admitted, value.unknown];
  return (
    counts.every(
      (count) => Number.isSafeInteger(count) && count >= 0 && count <= maximumNotificationCount,
    ) && value.admitted + value.unknown <= value.eligible
  );
}

async function afterCommit(
  ports: AdvisoryLockUseCasePorts,
  context: AdvisoryLockUseCaseContext,
  holderSessionId: SessionId,
  kind: AdvisoryLockMutationKind,
  lock: AdvisoryLock,
): Promise<AdvisoryLockNotificationSummary> {
  try {
    (ports.wake ?? noOpAdvisoryLockWakePort).wakeAdvisoryLockExpiry();
  } catch {}
  try {
    const summary = await (
      ports.notifications ?? noOpAdvisoryLockNotificationPort
    ).notifyAdvisoryLockMutation({
      workspaceKey: context.workspaceKey,
      holderSessionId,
      kind,
      lock,
    });
    return coherentSummary(summary) ? Object.freeze({ ...summary }) : zeroNotificationSummary;
  } catch {
    return zeroNotificationSummary;
  }
}

export async function publishAdvisoryLock(
  ports: AdvisoryLockUseCasePorts,
  context: AdvisoryLockUseCaseContext,
  command: {
    readonly ttlSeconds: unknown;
    readonly title: unknown;
    readonly description: unknown;
    readonly instructions: unknown;
  },
): Promise<DomainResult<AdvisoryLockMutationValue>> {
  const caller = await visibleCaller(ports, context);
  if (!caller.ok) return caller;
  const ttl = validateAdvisoryLockTtlSeconds(command.ttlSeconds);
  const title = validateAdvisoryLockTitle(command.title);
  const description = validateAdvisoryLockDescription(command.description);
  const instructions = validateAdvisoryLockInstructions(command.instructions);
  if (!ttl.ok || !title.ok || !description.ok || !instructions.ok) {
    return invalid("Advisory lock fields failed strict validation.");
  }
  if (!hasNonemptyUtf8(description.value) || !hasNonemptyUtf8(instructions.value)) {
    return invalid("description and instructions must each contain at least one UTF-8 byte.");
  }
  if (!ports.ids)
    return domainFailure("storage_unavailable", "Lock ID generation is unavailable.", true);
  try {
    const result = await ports.locks.publish({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      lockId: ports.ids.advisoryLockId(),
      holderSessionId: caller.value,
      title: title.value,
      description: description.value,
      instructions: instructions.value,
      ttlSeconds: ttl.value,
    });
    if (!result.ok) return storeFailure(ports, result.code);
    return {
      ok: true,
      value: {
        lock: result.lock,
        notification: await afterCommit(ports, context, caller.value, "published", result.lock),
      },
    };
  } catch (cause: unknown) {
    return storageException(ports, cause);
  }
}

export async function renewAdvisoryLock(
  ports: AdvisoryLockUseCasePorts,
  context: AdvisoryLockUseCaseContext,
  command: { readonly lockId: unknown; readonly ttlSeconds: unknown },
): Promise<DomainResult<AdvisoryLockMutationValue>> {
  const caller = await visibleCaller(ports, context);
  if (!caller.ok) return caller;
  const lockId = validateAdvisoryLockId(command.lockId);
  const ttl = validateAdvisoryLockTtlSeconds(command.ttlSeconds);
  if (!lockId.ok || !ttl.ok) return invalid("Advisory lock renewal arguments are malformed.");
  try {
    const result = await ports.locks.renew({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      lockId: lockId.value,
      holderSessionId: caller.value,
      ttlSeconds: ttl.value,
    });
    if (!result.ok) return storeFailure(ports, result.code);
    return {
      ok: true,
      value: {
        lock: result.lock,
        notification: await afterCommit(ports, context, caller.value, "renewed", result.lock),
      },
    };
  } catch (cause: unknown) {
    return storageException(ports, cause);
  }
}

export async function releaseAdvisoryLock(
  ports: AdvisoryLockUseCasePorts,
  context: AdvisoryLockUseCaseContext,
  command: { readonly lockId: unknown },
): Promise<DomainResult<AdvisoryLockMutationValue>> {
  const caller = await visibleCaller(ports, context);
  if (!caller.ok) return caller;
  const lockId = validateAdvisoryLockId(command.lockId);
  if (!lockId.ok) return invalid(lockId.message);
  try {
    const result = await ports.locks.release({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      lockId: lockId.value,
      holderSessionId: caller.value,
    });
    if (!result.ok) return storeFailure(ports, result.code);
    return {
      ok: true,
      value: {
        lock: result.lock,
        notification: await afterCommit(ports, context, caller.value, "released", result.lock),
      },
    };
  } catch (cause: unknown) {
    return storageException(ports, cause);
  }
}

export async function listAdvisoryLocks(
  ports: AdvisoryLockUseCasePorts,
  context: AdvisoryLockUseCaseContext,
  query: { readonly cursor?: unknown; readonly limit?: unknown },
): Promise<DomainResult<AdvisoryLockListValue>> {
  const caller = await visibleCaller(ports, context);
  if (!caller.ok) return caller;
  const limit = query.limit ?? advisoryLockListDefaultLimit;
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > advisoryLockPolicy.maximumListLimit
  ) {
    return invalid("limit must be an integer from 1 through 100.");
  }
  const cursor = query.cursor === undefined ? undefined : decodeAdvisoryLockCursor(query.cursor);
  if (query.cursor !== undefined && !cursor) return invalid("cursor is malformed.");
  try {
    const result = await ports.locks.list({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      limit: limit as number,
      ...(cursor ? { cursor } : {}),
    });
    return {
      ok: true,
      value: {
        locks: result.locks,
        ...(result.nextCursor ? { nextCursor: encodeAdvisoryLockCursor(result.nextCursor) } : {}),
      },
    };
  } catch (cause: unknown) {
    return storageException(ports, cause);
  }
}
