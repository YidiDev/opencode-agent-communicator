import { isCoherentContextAdmission } from "../domain/context-admissions";
import { isCoherentRequestMetadata } from "../domain/request-metadata";
import type { RequestMetadata } from "../domain/request-types";
import {
  deliveryRecordsPerWorkspaceHardCeiling,
  participantDeletionCandidatesHardCeiling,
  pendingRequestsPerWorkspaceHardCeiling,
} from "../domain/safety-ceilings";
import { type SessionId, validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { runUntilAborted } from "./abortable-operation";
import type { CommunicatorStartupRecoveryLifecycle } from "./communicator-startup-lifecycle";
import type { ParticipantContextPersistencePort } from "./context-admission-ports";
import {
  type ContextAdmissionNotificationPort,
  notifyContextAdmissionSafely,
} from "./context-admission-runtime";
import type {
  NativeParticipantPresencePort,
  ParticipantDeletionPersistencePort,
} from "./participant-deletion-ports";
import type { ParticipantOperationPort } from "./participant-operation-gate";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

export interface ParticipantDeletionReconciliationOptions {
  readonly requests: ParticipantDeletionPersistencePort;
  readonly presence: NativeParticipantPresencePort;
  readonly notifications: CommittedRequestNotificationPort;
  readonly contexts?: ParticipantContextPersistencePort;
  readonly contextNotifications?: ContextAdmissionNotificationPort;
  readonly operations?: ParticipantOperationPort;
  readonly lifecycle: Pick<CommunicatorStartupRecoveryLifecycle, "fencingToken">;
  readonly workspaceKey: WorkspaceKey;
}

export interface ParticipantDeletionReconciliationSummary {
  readonly candidates: number;
  readonly absent: number;
  readonly unknown: number;
  readonly terminalized: number;
}

export class ParticipantDeletionReconciliationFault extends Error {
  constructor(
    readonly code: "ownership_lost" | "storage_failure" | "port_contract_violation",
    cause?: unknown,
  ) {
    super(`Participant deletion reconciliation failed: ${code}.`, { cause });
  }
}

async function failDeletedParticipantContext(
  options: Omit<ParticipantDeletionReconciliationOptions, "presence">,
  deletedSessionId: SessionId,
  terminalParticipantSessionIds: readonly SessionId[] = [deletedSessionId],
): Promise<void> {
  if (!options.contexts || !options.contextNotifications) return;
  const seen = new Set<string>();
  for (let settled = 0; settled < deliveryRecordsPerWorkspaceHardCeiling; settled += 100) {
    const admissions = await options.contexts.settlePendingContextForParticipant({
      fencingToken: options.lifecycle.fencingToken,
      workspaceKey: options.workspaceKey,
      participantSessionId: deletedSessionId,
      terminalParticipantSessionIds,
      limit: 100,
    });
    const admissionValues = snapshotDenseArray(admissions, 100);
    if (!admissionValues)
      throw new ParticipantDeletionReconciliationFault("port_contract_violation");
    const terminal = new Set(terminalParticipantSessionIds);
    for (const admission of admissionValues) {
      if (!isCoherentContextAdmission(admission))
        throw new ParticipantDeletionReconciliationFault("port_contract_violation");
      const expected = terminal.has(admission.targetSessionId) ? "failed" : "cancelled";
      if (
        admission.workspaceKey !== options.workspaceKey ||
        (admission.targetSessionId !== deletedSessionId &&
          admission.sourceSessionId !== deletedSessionId) ||
        admission.state !== expected ||
        seen.has(admission.id)
      ) {
        throw new ParticipantDeletionReconciliationFault("port_contract_violation");
      }
      seen.add(admission.id);
      notifyContextAdmissionSafely(options.contextNotifications, {
        id: admission.id,
        kind: admission.kind,
        state: admission.state,
      });
    }
    if (admissionValues.length < 100) return;
  }
}

async function settleAbsentParticipantContexts(
  options: ParticipantDeletionReconciliationOptions,
  absentSessionIds: readonly SessionId[],
  abort: AbortSignal,
): Promise<void> {
  const terminalIds = Object.freeze([...absentSessionIds]);
  for (const sessionId of absentSessionIds) {
    if (abort.aborted) return;
    const settle = () => failDeletedParticipantContext(options, sessionId, terminalIds);
    if (options.operations) {
      await options.operations.run([sessionId], abort, settle);
    } else {
      await settle();
    }
  }
}

function committedRequests(
  raw: unknown,
  workspaceKey: WorkspaceKey,
  absentSessionIds: ReadonlySet<SessionId>,
): readonly RequestMetadata[] {
  const result = snapshotDataRecord(raw, 2);
  if (!result || typeof result.ok !== "boolean" || Object.keys(result).length !== 2)
    throw new ParticipantDeletionReconciliationFault("port_contract_violation");
  if (!result.ok) {
    throw new ParticipantDeletionReconciliationFault(
      result.code === "ownership_lost" ? "ownership_lost" : "storage_failure",
    );
  }
  const values = snapshotDenseArray(result.terminalized, pendingRequestsPerWorkspaceHardCeiling);
  if (!values) throw new ParticipantDeletionReconciliationFault("port_contract_violation");
  const ids = new Set<string>();
  const requests: RequestMetadata[] = [];
  for (const value of values) {
    if (!isCoherentRequestMetadata(value))
      throw new ParticipantDeletionReconciliationFault("port_contract_violation");
    const expected = absentSessionIds.has(value.targetSessionId)
      ? "target_deleted"
      : absentSessionIds.has(value.sourceSessionId)
        ? "source_deleted"
        : undefined;
    if (
      value.workspaceKey !== workspaceKey ||
      expected === undefined ||
      value.resolutionState !== expected ||
      ids.has(value.id)
    )
      throw new ParticipantDeletionReconciliationFault("port_contract_violation");
    ids.add(value.id);
    requests.push(value);
  }
  return Object.freeze(requests);
}

export async function applyParticipantDeletion(
  options: Omit<ParticipantDeletionReconciliationOptions, "presence">,
  deletedSessionId: SessionId,
): Promise<number> {
  let raw: unknown;
  try {
    raw = await options.requests.deleteParticipantRequests({
      fencingToken: options.lifecycle.fencingToken,
      workspaceKey: options.workspaceKey,
      deletedSessionId,
    });
  } catch (cause: unknown) {
    throw new ParticipantDeletionReconciliationFault("storage_failure", cause);
  }
  const committed = committedRequests(raw, options.workspaceKey, new Set([deletedSessionId]));
  for (const request of committed)
    notifyTerminalSafely(
      options.notifications,
      createTerminalNotificationEvent(
        request as RequestMetadata & {
          readonly resolutionState: Exclude<RequestMetadata["resolutionState"], "pending">;
        },
      ),
    );
  if (options.contextNotifications) {
    for (const request of committed) {
      if ((request.deliveryMode ?? "steer") === "context") {
        notifyContextAdmissionSafely(options.contextNotifications, {
          id: request.id,
          kind: "request",
          state: "cancelled",
        });
      }
    }
  }
  await failDeletedParticipantContext(options, deletedSessionId);
  return committed.length;
}

/**
 * Treats a deletion hook as a wake-up hint only. Durable deletion is gated by a fresh strict,
 * direct-ID native observation and can proceed only for the exact `absent` classification.
 */
export async function applyParticipantDeletionHint(
  options: ParticipantDeletionReconciliationOptions,
  hintedSessionId: SessionId,
  abort: AbortSignal,
): Promise<boolean> {
  const settlement = await runUntilAborted(abort, () =>
    options.presence.readParticipantPresence(hintedSessionId, abort),
  );
  if (settlement.kind === "aborted" || settlement.kind === "rejected" || abort.aborted)
    return false;
  if (settlement.value === "present" || settlement.value === "unknown") return false;
  if (settlement.value !== "absent") {
    throw new ParticipantDeletionReconciliationFault("port_contract_violation");
  }
  if (abort.aborted) return false;
  await applyParticipantDeletion(options, hintedSessionId);
  return true;
}

function candidateIds(raw: unknown): readonly SessionId[] {
  const result = snapshotDataRecord(raw, 2);
  if (!result || typeof result.ok !== "boolean" || Object.keys(result).length !== 2)
    throw new ParticipantDeletionReconciliationFault("port_contract_violation");
  if (!result.ok) {
    throw new ParticipantDeletionReconciliationFault(
      result.code === "ownership_lost" ? "ownership_lost" : "storage_failure",
    );
  }
  const values = snapshotDenseArray(result.sessionIds, participantDeletionCandidatesHardCeiling);
  if (!values) throw new ParticipantDeletionReconciliationFault("port_contract_violation");
  const seen = new Set<string>();
  return Object.freeze(
    values.map((value) => {
      const id = validateSessionId(value);
      if (!id.ok || seen.has(id.value))
        throw new ParticipantDeletionReconciliationFault("port_contract_violation");
      seen.add(id.value);
      return id.value;
    }),
  );
}

export async function reconcileParticipantDeletions(
  options: ParticipantDeletionReconciliationOptions,
  abort: AbortSignal,
): Promise<ParticipantDeletionReconciliationSummary> {
  let raw: unknown;
  try {
    raw = await options.requests.listParticipantDeletionCandidates({
      fencingToken: options.lifecycle.fencingToken,
      workspaceKey: options.workspaceKey,
    });
  } catch {
    throw new ParticipantDeletionReconciliationFault("storage_failure");
  }
  const candidates = candidateIds(raw);
  const absentSessionIds: SessionId[] = [];
  let unknown = 0;
  for (const sessionId of candidates) {
    if (abort.aborted) break;
    const settlement = await runUntilAborted(abort, () =>
      options.presence.readParticipantPresence(sessionId, abort),
    );
    if (settlement.kind === "aborted") break;
    const presence = settlement.kind === "rejected" ? "unknown" : settlement.value;
    if (presence === "present") continue;
    if (presence === "unknown") {
      unknown += 1;
      continue;
    }
    if (presence !== "absent")
      throw new ParticipantDeletionReconciliationFault("port_contract_violation");
    absentSessionIds.push(sessionId);
  }
  if (abort.aborted) {
    return Object.freeze({
      candidates: candidates.length,
      absent: absentSessionIds.length,
      unknown,
      terminalized: 0,
    });
  }
  let deletion: unknown;
  try {
    deletion = await options.requests.deleteAbsentParticipantRequests({
      fencingToken: options.lifecycle.fencingToken,
      workspaceKey: options.workspaceKey,
      absentSessionIds: Object.freeze([...absentSessionIds]),
    });
  } catch (cause: unknown) {
    throw new ParticipantDeletionReconciliationFault("storage_failure", cause);
  }
  const committed = committedRequests(deletion, options.workspaceKey, new Set(absentSessionIds));
  for (const request of committed)
    notifyTerminalSafely(
      options.notifications,
      createTerminalNotificationEvent(
        request as RequestMetadata & {
          readonly resolutionState: Exclude<RequestMetadata["resolutionState"], "pending">;
        },
      ),
    );
  await settleAbsentParticipantContexts(options, absentSessionIds, abort);
  return Object.freeze({
    candidates: candidates.length,
    absent: absentSessionIds.length,
    unknown,
    terminalized: committed.length,
  });
}
