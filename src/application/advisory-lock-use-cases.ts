import {
  type AdvisoryLock,
  advisoryLockPolicy,
  validateAdvisoryLockDescription,
  validateAdvisoryLockInstructions,
  validateAdvisoryLockTitle,
  validateAdvisoryLockTtlSeconds,
} from "../domain/advisory-locks";
import type { AdvisoryLockIdFactory } from "../domain/generated-ids";
import { validateAdvisoryLockId } from "../domain/generated-ids";
import { OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import type { SessionId } from "../domain/sessions";
import { validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type {
  AdvisoryLockCursor,
  AdvisoryLockPersistencePort,
  AdvisoryLockStoreFailureCode,
} from "./advisory-lock-ports";
import {
  assertCommunicatorReady,
  type CommunicatorReadinessPort,
  stopCommunicatorForOwnershipLoss,
} from "./communicator-readiness-port";
import type { CurrentWorkspaceMembershipPort } from "./delivery-ports";

export const advisoryLockListDefaultLimit = 50;
const maximumCursorCharacters = 256;
const maximumNotificationCount = 100;

export interface AdvisoryLockNotificationSummary {
  readonly eligible: number;
  readonly admitted: number;
  readonly unknown: number;
}

export type AdvisoryLockMutationKind = "published" | "renewed" | "released";

export interface AdvisoryLockPostCommitNotificationPort {
  notifyAdvisoryLockMutation(input: {
    readonly workspaceKey: WorkspaceKey;
    readonly holderSessionId: SessionId;
    readonly kind: AdvisoryLockMutationKind;
    readonly lock: AdvisoryLock;
  }): Promise<AdvisoryLockNotificationSummary>;
}

export interface AdvisoryLockWakePort {
  wakeAdvisoryLockExpiry(): void;
}

export const noOpAdvisoryLockWakePort: AdvisoryLockWakePort = Object.freeze({
  wakeAdvisoryLockExpiry: () => undefined,
});

const zeroNotificationSummary = Object.freeze({ eligible: 0, admitted: 0, unknown: 0 });

export const noOpAdvisoryLockNotificationPort: AdvisoryLockPostCommitNotificationPort =
  Object.freeze({
    notifyAdvisoryLockMutation: async () => zeroNotificationSummary,
  });

export interface AdvisoryLockUseCasePorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly locks: AdvisoryLockPersistencePort;
  readonly wake?: AdvisoryLockWakePort;
  readonly notifications?: AdvisoryLockPostCommitNotificationPort;
  readonly ids?: AdvisoryLockIdFactory;
}

export interface AdvisoryLockUseCaseContext {
  readonly workspaceKey: WorkspaceKey;
  readonly fencingToken: import("../domain/ownership").FencingToken;
  readonly callerSessionId: unknown;
}

export interface AdvisoryLockMutationValue {
  readonly lock: AdvisoryLock;
  readonly notification: AdvisoryLockNotificationSummary;
}

export interface AdvisoryLockListValue {
  readonly locks: readonly AdvisoryLock[];
  readonly nextCursor?: string;
}

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

export function encodeAdvisoryLockCursor(cursor: AdvisoryLockCursor): string {
  if (
    !Number.isSafeInteger(cursor.createdAtMs) ||
    cursor.createdAtMs < 0 ||
    !validateAdvisoryLockId(cursor.lockId).ok
  ) {
    throw new TypeError("Advisory lock cursor is malformed.");
  }
  return Buffer.from(
    JSON.stringify({ v: 1, c: cursor.createdAtMs, l: cursor.lockId }),
    "utf8",
  ).toString("base64url");
}

export function decodeAdvisoryLockCursor(value: unknown): AdvisoryLockCursor | undefined {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumCursorCharacters ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "c,l,v" ||
      record.v !== 1 ||
      !Number.isSafeInteger(record.c) ||
      (record.c as number) < 0
    ) {
      return undefined;
    }
    const lockId = validateAdvisoryLockId(record.l);
    if (!lockId.ok) return undefined;
    const cursor = { createdAtMs: record.c as number, lockId: lockId.value };
    return encodeAdvisoryLockCursor(cursor) === value ? Object.freeze(cursor) : undefined;
  } catch {
    return undefined;
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
