import type { FencingToken } from "../domain/ownership";
import { OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import { validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { boundedExternalCall } from "./bounded-external-call";
import {
  assertCommunicatorReady,
  type CommunicatorReadinessPort,
} from "./communicator-readiness-port";
import type { CurrentWorkspaceMembershipPort } from "./delivery-ports";
import { inspectParticipantRequestMetadata } from "./participant-request-boundaries";
import { encodeRequestListCursor, parseRequestListCursor } from "./request-list-cursor";
import type { CommittedRequestNotificationPort } from "./request-notification-port";
import type { ParticipantRequestMetadata, RequestParticipantQueryPort } from "./request-ports";
import { inspectRequestMetadata } from "./request-recovery-boundaries";
import {
  createTerminalNotificationEvent,
  notifyTerminalSafely,
} from "./request-terminal-notification";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-port-boundaries";

const defaultLimit = 50;
const maximumLimit = 100;
const validRoles = ["inbox", "outbox", "all"] as const;

export interface SessionRequestListResult {
  readonly items: readonly ParticipantRequestMetadata[];
  readonly nextCursor?: string;
}

export interface SessionRequestListPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly requests: RequestParticipantQueryPort;
  readonly notifications: CommittedRequestNotificationPort;
}

// biome-ignore-all format: keep strict page validation inside its bounded query branch.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validation, visibility, pagination, and committed transition hints remain one query boundary.
export async function listSessionRequests(
  ports: SessionRequestListPorts,
  context: {
    readonly workspaceKey: WorkspaceKey;
    readonly callerSessionId: unknown;
    readonly fencingToken: FencingToken;
    readonly abort?: AbortSignal;
    readonly deadlineMs?: number;
  },
  query: unknown = undefined,
): Promise<DomainResult<SessionRequestListResult>> {
  assertCommunicatorReady(ports.readiness, context.fencingToken);
  const caller = validateSessionId(context.callerSessionId);
  if (!caller.ok) return domainFailure("invalid_arguments", caller.message, false);
  const queryData = query === undefined ? {} : snapshotDataRecord(query, 3);
  if (
    !queryData ||
    Object.keys(queryData).some((key) => !["role", "cursor", "limit"].includes(key))
  ) {
    return domainFailure(
      "invalid_arguments",
      "Query must contain only role, cursor, and limit.",
      false,
    );
  }
  const role = queryData.role === undefined ? "all" : queryData.role;
  if (!validRoles.includes(role as (typeof validRoles)[number])) {
    return domainFailure("invalid_arguments", "role must be inbox, outbox, or all.", false);
  }
  const typedRole = role as (typeof validRoles)[number];
  const limit = queryData.limit === undefined ? defaultLimit : queryData.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > maximumLimit) {
    return domainFailure(
      "invalid_arguments",
      `limit must be an integer from 1 to ${maximumLimit}.`,
      false,
    );
  }
  const parsedCursor =
    queryData.cursor === undefined
      ? undefined
      : parseRequestListCursor(queryData.cursor, typedRole);
  if (parsedCursor && !parsedCursor.ok) {
    return domainFailure("invalid_arguments", parsedCursor.message, false);
  }
  const invoke = async <Value>(operation: () => Promise<Value>) => {
    if (context.abort && context.deadlineMs !== undefined) {
      return boundedExternalCall(operation, context.abort, context.deadlineMs);
    }
    try {
      return { kind: "value" as const, value: await operation() };
    } catch (cause: unknown) {
      return { kind: "rejected" as const, cause };
    }
  };
  {
    const membershipCall = await invoke(() => ports.membership.readCurrentRoots(
      context.workspaceKey,
      caller.value,
      caller.value,
    ));
    if (membershipCall.kind === "expired") {
      return domainFailure("deadline_expired", "Request list invocation deadline expired.", false);
    }
    if (membershipCall.kind === "rejected") {
      if (membershipCall.cause instanceof OwnershipLostFault) {
        return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
      }
      return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
    }
    const rawMembership = membershipCall.value;
    try {
    const membership = snapshotDataRecord(rawMembership, 3);
    if (
      !membership ||
      Object.keys(membership).length !== 3 ||
      !Object.hasOwn(membership, "sourceTitle") ||
      !Object.hasOwn(membership, "sourceVisible") ||
      !Object.hasOwn(membership, "targetVisible") ||
      (membership.sourceTitle !== undefined && typeof membership.sourceTitle !== "string") ||
      typeof membership.sourceVisible !== "boolean" ||
      typeof membership.targetVisible !== "boolean"
    ) {
      throw new Error("Current membership was malformed.");
    }
    if (!membership.sourceVisible) {
      return domainFailure(
        "caller_not_visible",
        "Caller is not a current visible root session.",
        false,
      );
    }
    } catch {
      return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
    }
  }
  {
    const pageCall = await invoke(() => ports.requests.listForParticipant({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      callerSessionId: caller.value,
      role: typedRole,
      ...(parsedCursor?.ok ? { boundary: parsedCursor.boundary } : {}),
      limit: limit as number,
    }));
    if (pageCall.kind === "expired") {
      return domainFailure("deadline_expired", "Request list invocation deadline expired.", false);
    }
    if (pageCall.kind === "rejected") {
      if (pageCall.cause instanceof OwnershipLostFault) {
        return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
      }
      return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
    }
    const rawPage = pageCall.value;
    try {
    const repositoryResult = snapshotDataRecord(rawPage, 3);
    if (!repositoryResult || Object.keys(repositoryResult).length !== 3)
      throw new Error("The participant list terminalizations were malformed.");
    const terminalized = snapshotDenseArray(repositoryResult.terminalized, 1_024);
    if (!terminalized) throw new Error("The participant list terminalizations were malformed.");
    for (const raw of terminalized) {
      const request = inspectRequestMetadata(raw);
      if (
        !request ||
        request.resolutionState === "pending" ||
        request.workspaceKey !== context.workspaceKey ||
        (request.sourceSessionId !== caller.value && request.targetSessionId !== caller.value)
      )
        throw new Error("The participant list terminalization was incoherent.");
      notifyTerminalSafely(ports.notifications, createTerminalNotificationEvent(request));
    }
    const rawItems = snapshotDenseArray(repositoryResult.items, maximumLimit);
    if (!rawItems || typeof repositoryResult.hasMore !== "boolean")
      throw new Error("The participant request page was malformed.");
    const seen = new Set<string>();
    let previous: ParticipantRequestMetadata | undefined;
    const items = rawItems.map((item) => {
      const inspected = inspectParticipantRequestMetadata(item);
      if (!inspected) throw new Error("A participant request list item was incoherent.");
      const inbox =
        inspected.participantRole === "target" &&
        inspected.targetSessionId === caller.value &&
        inspected.resolutionState === "pending";
      const outbox =
        inspected.participantRole === "source" &&
        inspected.sourceSessionId === caller.value &&
        (inspected.resolutionState === "pending" ||
          !["answered", "reached"].includes(inspected.resolutionState) ||
          inspected.resultState !== "acknowledged");
      if (
        (typedRole === "inbox" && !inbox) ||
        (typedRole === "outbox" && !outbox) ||
        (typedRole === "all" && !inbox && !outbox) ||
        seen.has(inspected.requestId) ||
        (previous !== undefined &&
          (inspected.createdAtMs > previous.createdAtMs ||
            (inspected.createdAtMs === previous.createdAtMs &&
              inspected.requestId >= previous.requestId)))
      )
        throw new Error("A participant request list item was foreign or unordered.");
      seen.add(inspected.requestId);
      previous = inspected;
      return inspected;
    });
    const last = items.at(-1);
    return {
      ok: true,
      value: {
        items,
        ...(repositoryResult.hasMore && last
          ? {
              nextCursor: encodeRequestListCursor(typedRole, {
                createdAtMs: last.createdAtMs,
                requestId: last.requestId,
              }),
            }
          : {}),
      },
    };
    } catch {
      return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
    }
  }
}
