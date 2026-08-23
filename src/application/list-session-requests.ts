import type { FencingToken } from "../domain/ownership";
import { OwnershipLostFault } from "../domain/ownership";
import { type DomainResult, domainFailure } from "../domain/results";
import { validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { CurrentWorkspaceMembershipPort } from "./delivery-ports";
import { encodeRequestListCursor, parseRequestListCursor } from "./request-list-cursor";
import type { ParticipantRequestMetadata, RequestParticipantQueryPort } from "./request-ports";

const defaultLimit = 50;
const maximumLimit = 100;
const validRoles = ["inbox", "outbox", "all"] as const;

export interface SessionRequestListResult {
  readonly items: readonly ParticipantRequestMetadata[];
  readonly nextCursor?: string;
}

export async function listSessionRequests(
  ports: {
    readonly membership: CurrentWorkspaceMembershipPort;
    readonly requests: RequestParticipantQueryPort;
  },
  context: {
    readonly workspaceKey: WorkspaceKey;
    readonly callerSessionId: unknown;
    readonly fencingToken: FencingToken;
  },
  query: { readonly role?: unknown; readonly cursor?: unknown; readonly limit?: unknown } = {},
): Promise<DomainResult<SessionRequestListResult>> {
  const caller = validateSessionId(context.callerSessionId);
  if (!caller.ok) return domainFailure("invalid_arguments", caller.message, false);
  const role = query.role ?? "all";
  if (!validRoles.includes(role as (typeof validRoles)[number])) {
    return domainFailure("invalid_arguments", "role must be inbox, outbox, or all.", false);
  }
  const typedRole = role as (typeof validRoles)[number];
  const limit = query.limit ?? defaultLimit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > maximumLimit) {
    return domainFailure(
      "invalid_arguments",
      `limit must be an integer from 1 to ${maximumLimit}.`,
      false,
    );
  }
  const parsedCursor =
    query.cursor === undefined ? undefined : parseRequestListCursor(query.cursor, typedRole);
  if (parsedCursor && !parsedCursor.ok) {
    return domainFailure("invalid_arguments", parsedCursor.message, false);
  }
  try {
    const membership = await ports.membership.readCurrentRoots(
      context.workspaceKey,
      caller.value,
      caller.value,
    );
    if (!membership.sourceVisible) {
      return domainFailure(
        "caller_not_visible",
        "Caller is not a current visible root session.",
        false,
      );
    }
  } catch (cause: unknown) {
    if (cause instanceof OwnershipLostFault) {
      return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
    }
    return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
  }
  try {
    const page = await ports.requests.listForParticipant({
      fencingToken: context.fencingToken,
      workspaceKey: context.workspaceKey,
      callerSessionId: caller.value,
      role: typedRole,
      ...(parsedCursor?.ok ? { boundary: parsedCursor.boundary } : {}),
      limit: limit as number,
    });
    const last = page.items.at(-1);
    return {
      ok: true,
      value: {
        items: page.items,
        ...(page.hasMore && last
          ? {
              nextCursor: encodeRequestListCursor(typedRole, {
                createdAtMs: last.createdAtMs,
                requestId: last.requestId,
              }),
            }
          : {}),
      },
    };
  } catch (cause: unknown) {
    if (cause instanceof OwnershipLostFault) {
      return domainFailure("ownership_lost", "Coordinator ownership was lost.", false);
    }
    return domainFailure("storage_unavailable", "Request storage is unavailable.", true);
  }
}
