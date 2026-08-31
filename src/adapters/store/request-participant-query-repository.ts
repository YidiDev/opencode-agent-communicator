import type { RequestListBoundary } from "../../application/request-list-cursor";
import type {
  ParticipantRequestGet,
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
import {
  drainDueParticipantRequests,
  drainDueParticipantResults,
} from "./request-participant-expiry";
import {
  getSourceTerminalParticipant,
  projectParticipant,
  type RoleRow,
} from "./request-participant-projection";
import { authorizeParticipant, queryParticipantList } from "./request-participant-storage";
import { validatePendingPrivateContent } from "./request-persistence-validation";
import type { RequestRepository } from "./request-repository";
import {
  assertPendingWaitEdge,
  assertTerminalPrivateState,
  requestStoreNowMs,
} from "./request-repository-shared";
import type { RequestResultRetentionRepository } from "./request-result-retention-repository";
import { hydrateRequest, requestMetadataColumns } from "./request-rows";
import { type StoreContext, StoreIntegrityError } from "./store-types";

const roles: readonly RequestListRole[] = ["inbox", "outbox", "all"];

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
          terminalized.push(
            ...drainDueParticipantRequests(
              this.context,
              this.requests,
              caller.value,
              nowMs,
              "target",
            ),
          );
        if (input.role !== "inbox") {
          terminalized.push(
            ...drainDueParticipantRequests(
              this.context,
              this.requests,
              caller.value,
              nowMs,
              "source",
            ),
          );
          terminalized.push(
            ...drainDueParticipantResults(this.context, this.results, caller.value, nowMs),
          );
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
    const inbox =
      input.role === "outbox"
        ? []
        : this.queryList(
            "requests_participant_inbox",
            "target_session_id",
            `resolution_state = 'pending' AND (
              delivery_transport = 'native' OR EXISTS (
                SELECT 1 FROM context_admissions
                WHERE id = requests.id AND state = 'context_admitted'
              )
            )`,
            "target",
            caller,
            input.boundary,
            requested,
          );
    const outbox =
      input.role === "inbox"
        ? []
        : this.queryList(
            "requests_participant_outbox",
            "source_session_id",
            "(resolution_state = 'pending' OR resolution_state NOT IN ('answered','reached') OR result_state != 'acknowledged')",
            "source",
            caller,
            input.boundary,
            requested,
          );
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
        const authorizedRole = authorizeParticipant(
          this.context,
          workspace.value,
          requestId.value,
          caller.value,
        );
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
        metadata: projectParticipant(request, "target"),
      };
    }
    return getSourceTerminalParticipant(this.context, request);
  }

  private getPendingOwned(
    request: Extract<RequestMetadata, { readonly resolutionState: "pending" }>,
    participantRole: "source" | "target",
  ): ParticipantRequestGet {
    if (participantRole === "source") {
      return {
        outcome: "metadata",
        view: "source_pending",
        metadata: projectParticipant(request, "source"),
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
        metadata: projectParticipant(request, "target"),
        payload: content.payload,
      };
    }
    if (requestKindIs(request, "wait") && content.payload.kind === "wait") {
      return {
        outcome: "pending_payload",
        metadata: projectParticipant(request, "target"),
        payload: content.payload,
      };
    }
    throw new StoreIntegrityError("Stored pending request kind correlation was invalid.");
  }

  private queryList(
    index: string,
    participantColumn: "source_session_id" | "target_session_id",
    predicate: string,
    role: "source" | "target",
    caller: string,
    boundary: RequestListBoundary | undefined,
    limit: number,
  ) {
    return queryParticipantList(this.context, {
      index,
      participantColumn,
      predicate,
      role,
      caller,
      boundary,
      limit,
    });
  }
}
