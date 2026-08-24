import type { RequestListBoundary } from "../../application/request-list-cursor";
import type {
  ParticipantRequestGet,
  ParticipantRequestMetadata,
  ParticipantRequestPage,
  ParticipantRequestRepositoryGet,
  ParticipantRequestRepositoryPage,
} from "../../application/request-ports";
import { validateRequestId } from "../../domain/generated-ids";
import type { FencingToken } from "../../domain/ownership";
import type { RequestListRole, RequestMetadata } from "../../domain/request-types";
import { validateSessionId } from "../../domain/sessions";
import { validateWorkspaceKey } from "../../domain/workspaces";
import type { OwnershipRepository } from "./ownership-repository";
import { validatePendingPrivateContent } from "./request-persistence-validation";
import type { RequestRepository } from "./request-repository";
import {
  assertPendingWaitEdge,
  assertTerminalPrivateState,
  requestStoreNowMs,
} from "./request-repository-shared";
import type { RequestResultRetentionRepository } from "./request-result-retention-repository";
import { validateStoredResultState } from "./request-result-validation";
import { hydrateRequest, type RequestRow, requestMetadataColumns } from "./request-rows";
import { type StoreContext, StoreIntegrityError, sqliteStoreHardCeilings } from "./store-types";

type RoleRow = RequestRow & { readonly participantRole: unknown };
const roles: readonly RequestListRole[] = ["inbox", "outbox", "all"];

/** Canonical request IDs are ASCII, so code-unit ordering exactly matches SQLite BINARY bytes. */
function compareRequestIdBinaryDescending(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function requestKindIs<Kind extends RequestMetadata["kind"]>(
  request: RequestMetadata,
  kind: Kind,
): request is RequestMetadata & { readonly kind: Kind } {
  return request.kind === kind;
}

function constructApprovedProjection<
  Metadata extends RequestMetadata,
  Role extends "source" | "target",
>(request: Metadata, participantRole: Role): ParticipantRequestMetadata<Role, Metadata> {
  const projection = {
    requestId: request.id,
    participantRole,
    kind: request.kind,
    sourceSessionId: request.sourceSessionId,
    targetSessionId: request.targetSessionId,
    resolutionState: request.resolutionState,
    deliveryState: request.deliveryState,
    resultState: request.resultState,
    createdAtMs: request.createdAtMs,
    updatedAtMs: request.updatedAtMs,
    deadlineAtMs: request.deadlineAtMs,
    ...(request.resolvedAtMs === undefined ? {} : { resolvedAtMs: request.resolvedAtMs }),
    ...(request.submittedAtMs === undefined ? {} : { submittedAtMs: request.submittedAtMs }),
    ...(request.deliveryUnknownAtMs === undefined
      ? {}
      : { deliveryUnknownAtMs: request.deliveryUnknownAtMs }),
    ...(request.admittedAtMs === undefined ? {} : { admittedAtMs: request.admittedAtMs }),
    ...(request.promotedAtMs === undefined ? {} : { promotedAtMs: request.promotedAtMs }),
    ...(request.deliveryFailedAtMs === undefined
      ? {}
      : { deliveryFailedAtMs: request.deliveryFailedAtMs }),
    ...(request.resultAvailableAtMs === undefined
      ? {}
      : { resultAvailableAtMs: request.resultAvailableAtMs }),
    ...(request.resultExpiresAtMs === undefined
      ? {}
      : { resultExpiresAtMs: request.resultExpiresAtMs }),
    ...(request.resultExpiredAtMs === undefined
      ? {}
      : { resultExpiredAtMs: request.resultExpiredAtMs }),
    ...(request.acknowledgedAtMs === undefined
      ? {}
      : { acknowledgedAtMs: request.acknowledgedAtMs }),
  };
  return projection as ParticipantRequestMetadata<Role, Metadata>;
}

function project<Metadata extends RequestMetadata, Role extends "source" | "target">(
  request: Metadata,
  participantRole: Role,
): ParticipantRequestMetadata<Role, Metadata> {
  switch (request.resolutionState) {
    case "pending":
    case "answered":
    case "reached":
    case "deadline_expired":
    case "cancelled":
    case "delivery_failed":
    case "target_stopped":
    case "source_stopped":
    case "target_deleted":
    case "source_deleted":
      return constructApprovedProjection(request, participantRole);
    default: {
      const exhaustive: never = request;
      throw new StoreIntegrityError(`Unsupported request state: ${String(exhaustive)}`);
    }
  }
}

function hydrateRole(row: RoleRow): ParticipantRequestMetadata {
  if (row.participantRole !== "source" && row.participantRole !== "target") {
    throw new StoreIntegrityError("Stored request participant role was invalid.");
  }
  return project(hydrateRequest(row), row.participantRole);
}

function validBoundary(value: RequestListBoundary | undefined): boolean {
  if (value === undefined) return true;
  return (
    Number.isSafeInteger(value.createdAtMs) &&
    value.createdAtMs >= 0 &&
    validateRequestId(value.requestId).ok
  );
}

export class RequestParticipantQueryRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
    private readonly requests: RequestRepository,
    private readonly results: RequestResultRetentionRepository,
  ) {}

  list(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: string;
    readonly callerSessionId: string;
    readonly role: RequestListRole;
    readonly boundary?: RequestListBoundary;
    readonly limit: number;
  }): ParticipantRequestRepositoryPage {
    const workspace = validateWorkspaceKey(input.workspaceKey);
    const caller = validateSessionId(input.callerSessionId);
    if (
      !workspace.ok ||
      !caller.ok ||
      !roles.includes(input.role) ||
      !validBoundary(input.boundary) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new StoreIntegrityError("The participant request list query was invalid.");
    }
    return this.context.database
      .transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        if (workspace.value !== this.context.workspaceKey)
          return { items: [], hasMore: false, terminalized: [] };
        const nowMs = requestStoreNowMs(this.context);
        const terminalized: RequestMetadata[] = [];
        if (input.role !== "outbox")
          terminalized.push(...this.drainDueTargetRequests(caller.value, nowMs));
        if (input.role !== "inbox") {
          terminalized.push(...this.drainDueSourceRequests(caller.value, nowMs));
          terminalized.push(...this.drainDueSourceResults(caller.value, nowMs));
        }
        return { ...this.listOwned(input, caller.value), terminalized };
      })
      .immediate();
  }

  private listOwned(
    input: Parameters<RequestParticipantQueryRepository["list"]>[0],
    caller: string,
  ): ParticipantRequestPage {
    const requested = input.limit + 1;
    const inbox = input.role === "outbox" ? [] : this.queryInbox(caller, input.boundary, requested);
    const outbox =
      input.role === "inbox" ? [] : this.queryOutbox(caller, input.boundary, requested);
    const rows = [...inbox, ...outbox].sort(
      (left, right) =>
        right.createdAtMs - left.createdAtMs ||
        compareRequestIdBinaryDescending(left.requestId, right.requestId),
    );
    return { items: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
  }

  get(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: string;
    readonly requestId: string;
    readonly callerSessionId: string;
  }): ParticipantRequestRepositoryGet | undefined {
    const workspace = validateWorkspaceKey(input.workspaceKey);
    const caller = validateSessionId(input.callerSessionId);
    const requestId = validateRequestId(input.requestId);
    if (!workspace.ok || !caller.ok || !requestId.ok) {
      throw new StoreIntegrityError("The participant request get query was invalid.");
    }
    return this.context.database
      .transaction(() => {
        this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
        if (workspace.value !== this.context.workspaceKey) return undefined;
        const authorizedRole = this.authorizeExact(workspace.value, requestId.value, caller.value);
        if (!authorizedRole) return undefined;
        const nowMs = requestStoreNowMs(this.context);
        const terminalized = [
          this.requests.expireExactDueOwned(workspace.value, requestId.value, nowMs),
          this.results.expireExactAvailableOwned(workspace.value, requestId.value, nowMs),
        ].filter((item): item is RequestMetadata => item !== undefined);
        const found = this.getOwned(workspace.value, requestId.value, caller.value, authorizedRole);
        return found ? { ...found, terminalized } : undefined;
      })
      .immediate();
  }

  private getOwned(
    workspace: string,
    requestId: string,
    caller: string,
    authorizedRole: "source" | "target",
  ): ParticipantRequestGet | undefined {
    const row = this.context.database
      .query<RoleRow, [string, string, string, string]>(
        `SELECT ${requestMetadataColumns},
         CASE WHEN source_session_id = ?3 THEN 'source' ELSE 'target' END AS participantRole
       FROM requests WHERE workspace_key = ?1 AND id = ?2
         AND (source_session_id = ?3 OR target_session_id = ?4)`,
      )
      .get(workspace, requestId, caller, caller);
    if (!row) return undefined;
    const request = hydrateRequest(row);
    const participantRole = row.participantRole;
    if (participantRole !== "source" && participantRole !== "target") {
      throw new StoreIntegrityError("Stored request participant role was invalid.");
    }
    if (participantRole !== authorizedRole) {
      throw new StoreIntegrityError("Stored request participant authorization changed.");
    }
    if (request.resolutionState === "pending") {
      return this.getPendingOwned(request, participantRole);
    }
    assertTerminalPrivateState(this.context, request.id);
    if (participantRole === "target") {
      return {
        outcome: "metadata",
        view: "target_terminal",
        metadata: project(request, "target"),
      };
    }
    return this.getSourceTerminalOwned(request);
  }

  private getPendingOwned(
    request: Extract<RequestMetadata, { readonly resolutionState: "pending" }>,
    participantRole: "source" | "target",
  ): ParticipantRequestGet {
    if (participantRole === "source") {
      return {
        outcome: "metadata",
        view: "source_pending",
        metadata: project(request, "source"),
      };
    }
    const child = this.context.database
      .query<
        {
          readonly payloadJson: unknown;
          readonly envelopeJson: unknown;
          readonly retainedBytes: unknown;
        },
        [string]
      >(
        `SELECT p.payload_json AS payloadJson, p.envelope_json AS envelopeJson,
                r.retained_content_byte_length AS retainedBytes
         FROM requests r JOIN request_payloads p ON p.request_id = r.id WHERE r.id = ?`,
      )
      .get(request.id);
    assertPendingWaitEdge(this.context, request);
    const content =
      child &&
      validatePendingPrivateContent(
        request,
        child.payloadJson,
        child.envelopeJson,
        child.retainedBytes,
      );
    if (!content) throw new StoreIntegrityError("Stored pending request content was invalid.");
    if (requestKindIs(request, "ask") && content.payload.kind === "ask") {
      return {
        outcome: "pending_payload",
        metadata: project(request, "target"),
        payload: content.payload,
      };
    }
    if (requestKindIs(request, "wait") && content.payload.kind === "wait") {
      return {
        outcome: "pending_payload",
        metadata: project(request, "target"),
        payload: content.payload,
      };
    }
    throw new StoreIntegrityError("Stored pending request kind correlation was invalid.");
  }

  private getSourceTerminalOwned(
    request: Exclude<RequestMetadata, { readonly resolutionState: "pending" }>,
  ): ParticipantRequestGet {
    if (request.resolutionState === "answered" || request.resolutionState === "reached") {
      if (request.resultState !== "available") {
        validateStoredResultState(this.context, request);
        return {
          outcome: "result_expired",
          metadata: project(request, "source"),
        };
      }
      const stored = validateStoredResultState(this.context, request);
      if (!stored) throw new StoreIntegrityError("Stored request result was missing.");
      if (
        request.resolutionState === "answered" &&
        request.kind === "ask" &&
        stored.result.kind === "ask"
      ) {
        return {
          outcome: "available_result",
          metadata: project(request, "source"),
          result: stored.result,
        };
      }
      if (
        request.resolutionState === "reached" &&
        request.kind === "wait" &&
        stored.result.kind === "wait"
      ) {
        return {
          outcome: "available_result",
          metadata: project(request, "source"),
          result: stored.result,
        };
      }
      throw new StoreIntegrityError("Stored request result correlation was invalid.");
    }
    return {
      outcome: "metadata",
      view: "source_unsuccessful_terminal",
      metadata: project(request, "source"),
    };
  }

  private authorizeExact(
    workspace: string,
    requestId: string,
    caller: string,
  ): "source" | "target" | undefined {
    const row = this.context.database
      .query<{ readonly participantRole: unknown }, [string, string, string, string]>(
        `SELECT CASE WHEN source_session_id = ?3 THEN 'source' ELSE 'target' END AS participantRole
         FROM requests WHERE workspace_key = ?1 AND id = ?2
           AND (source_session_id = ?3 OR target_session_id = ?4)`,
      )
      .get(workspace, requestId, caller, caller);
    if (!row) return undefined;
    if (row.participantRole !== "source" && row.participantRole !== "target") {
      throw new StoreIntegrityError("Stored request participant authorization was invalid.");
    }
    return row.participantRole;
  }

  private queryInbox(caller: string, boundary: RequestListBoundary | undefined, limit: number) {
    return this.queryList(
      "requests_participant_inbox",
      "target_session_id",
      "resolution_state = 'pending'",
      "target",
      caller,
      boundary,
      limit,
    );
  }

  private queryOutbox(caller: string, boundary: RequestListBoundary | undefined, limit: number) {
    return this.queryList(
      "requests_participant_outbox",
      "source_session_id",
      "(resolution_state = 'pending' OR resolution_state NOT IN ('answered','reached') OR result_state != 'acknowledged')",
      "source",
      caller,
      boundary,
      limit,
    );
  }

  private queryList(
    index: string,
    participantColumn: "source_session_id" | "target_session_id",
    predicate: string,
    role: "source" | "target",
    caller: string,
    boundary: RequestListBoundary | undefined,
    limit: number,
  ): ParticipantRequestMetadata[] {
    const boundarySql = boundary ? "AND (created_at_ms, id) < (?3, ?4)" : "";
    const sql = `SELECT ${requestMetadataColumns}, '${role}' AS participantRole
      FROM requests INDEXED BY ${index}
      WHERE workspace_key = ?1 AND ${participantColumn} = ?2 AND ${predicate} ${boundarySql}
      ORDER BY created_at_ms DESC, id DESC LIMIT ?${boundary ? 5 : 3}`;
    const rows = boundary
      ? this.context.database
          .query<RoleRow, [string, string, number, string, number]>(sql)
          .all(this.context.workspaceKey, caller, boundary.createdAtMs, boundary.requestId, limit)
      : this.context.database
          .query<RoleRow, [string, string, number]>(sql)
          .all(this.context.workspaceKey, caller, limit);
    return rows.map(hydrateRole);
  }

  private drainDueSourceRequests(caller: string, nowMs: number): RequestMetadata[] {
    const terminalized: RequestMetadata[] = [];
    const maximumBatches = Math.ceil(sqliteStoreHardCeilings.pendingRequestsPerSource / 100) + 1;
    for (let batch = 0; batch < maximumBatches; batch++) {
      const batchItems = this.requests.expireDueForSourceOwned(
        this.context.workspaceKey,
        caller,
        nowMs,
        100,
      );
      terminalized.push(...batchItems);
      if (batchItems.length < 100) return terminalized;
    }
    throw new StoreIntegrityError("Source request expiry exceeded its hard bound.");
  }

  private drainDueTargetRequests(caller: string, nowMs: number): RequestMetadata[] {
    const terminalized: RequestMetadata[] = [];
    const maximumBatches = Math.ceil(sqliteStoreHardCeilings.pendingRequestsPerTarget / 100) + 1;
    for (let batch = 0; batch < maximumBatches; batch++) {
      const batchItems = this.requests.expireDueForTargetOwned(
        this.context.workspaceKey,
        caller,
        nowMs,
        100,
      );
      terminalized.push(...batchItems);
      if (batchItems.length < 100) return terminalized;
    }
    throw new StoreIntegrityError("Target request expiry exceeded its hard bound.");
  }

  private drainDueSourceResults(caller: string, nowMs: number): RequestMetadata[] {
    const terminalized: RequestMetadata[] = [];
    const maximumBatches = Math.ceil(sqliteStoreHardCeilings.availableResultsPerSource / 100) + 1;
    for (let batch = 0; batch < maximumBatches; batch++) {
      const batchItems = this.results.expireAvailableForSourceOwned(
        this.context.workspaceKey,
        caller,
        nowMs,
        100,
      );
      terminalized.push(...batchItems);
      if (batchItems.length < 100) return terminalized;
    }
    throw new StoreIntegrityError("Source result expiry exceeded its hard bound.");
  }
}
