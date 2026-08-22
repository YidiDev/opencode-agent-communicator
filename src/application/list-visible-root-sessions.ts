import { type DomainResult, domainFailure } from "../domain/results";
import { sanitizeDisplayTitle } from "../domain/sanitize-display";
import type {
  ActivityStatus,
  SessionId,
  SessionStatusFilter,
  VisibleRootSessionPort,
} from "../domain/sessions";

const defaultSessionLimit = 50;
const maximumSessionLimit = 100;

export interface SessionListQuery {
  readonly status?: SessionStatusFilter;
  readonly includeArchived?: boolean;
  readonly limit?: number;
}

export interface VisibleRootSession {
  readonly id: SessionId;
  readonly title: string;
  readonly status: ActivityStatus;
  readonly isActive: boolean;
  readonly isArchived: boolean;
  readonly updatedAtMs: number;
  readonly statusObservedAtMs: number;
}

function matchesStatus(status: ActivityStatus, filter: SessionStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return status === "busy" || status === "retry";
  return status === "idle";
}

function compareNewest(left: VisibleRootSession, right: VisibleRootSession): number {
  return right.updatedAtMs - left.updatedAtMs || left.id.localeCompare(right.id);
}

function invalidLimit(): DomainResult<readonly VisibleRootSession[]> {
  return domainFailure(
    "invalid_arguments",
    `limit must be an integer from 1 to ${maximumSessionLimit}.`,
    false,
  );
}

export async function listVisibleRootSessions(
  port: VisibleRootSessionPort,
  query: SessionListQuery = {},
): Promise<DomainResult<readonly VisibleRootSession[]>> {
  const limit = query.limit ?? defaultSessionLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumSessionLimit) return invalidLimit();
  const includeArchived = query.includeArchived ?? false;
  const status = query.status ?? "all";
  try {
    const sessions = await port.readVisibleRoots(includeArchived);
    const visible = sessions
      .filter((session) => includeArchived || !session.isArchived)
      .map((session) => ({
        id: session.id,
        title: sanitizeDisplayTitle(session.title),
        status: session.status,
        isActive: session.status === "busy" || session.status === "retry",
        isArchived: session.isArchived,
        updatedAtMs: session.updatedAtMs,
        statusObservedAtMs: session.observedAtMs,
      }))
      .filter((session) => matchesStatus(session.status, status))
      .sort(compareNewest)
      .slice(0, limit);
    return { ok: true, value: visible };
  } catch (_cause: unknown) {
    return domainFailure(
      "native_unavailable",
      "Visible session state is temporarily unavailable.",
      true,
    );
  }
}
