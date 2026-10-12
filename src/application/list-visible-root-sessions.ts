import { type DomainResult, domainFailure } from "../domain/results";
import { sanitizeDisplayTitle } from "../domain/sanitize-display";
import type {
  ActivityStatus,
  SessionId,
  SessionStatusFilter,
  VisibleRootSessionPort,
} from "../domain/sessions";
import { validateSessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import { boundedExternalCall } from "./bounded-external-call";
import { deadlineLinkedSignal } from "./claimed-message-admission";
import {
  assertCommunicatorReady,
  type CommunicatorReadinessPort,
} from "./communicator-readiness-port";
import type { CurrentWorkspaceMembershipPort } from "./delivery-ports";
import type {
  ParticipantRegistryListingPort,
  ParticipantRootRevalidationPort,
} from "./participant-registry-ports";

const defaultSessionLimit = 50;
const maximumSessionLimit = 100;

export interface SessionListQuery {
  readonly status?: SessionStatusFilter;
  readonly includeArchived?: boolean;
  readonly limit?: number;
}

export interface SessionListContext {
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: unknown;
  readonly abort?: AbortSignal;
  readonly deadlineMs?: number;
}

// biome-ignore format: the explicit union documents every bounded settlement.
async function invoke<Value>(
  context: SessionListContext,
  operation: (signal?: AbortSignal) => Promise<Value>,
): Promise<{ readonly kind: "value"; readonly value: Value } | { readonly kind: "expired" } | { readonly kind: "rejected"; readonly cause: unknown }> {
  if (context.abort && context.deadlineMs !== undefined) {
    const effect = deadlineLinkedSignal(context.abort, context.deadlineMs);
    return boundedExternalCall(
      () => operation(effect.signal),
      effect.signal,
      context.deadlineMs,
    ).finally(effect.dispose);
  }
  try {
    return { kind: "value", value: await operation(undefined) };
  } catch (cause: unknown) {
    return { kind: "rejected", cause };
  }
}

export interface SessionListPorts {
  readonly readiness: CommunicatorReadinessPort;
  readonly membership: CurrentWorkspaceMembershipPort;
  readonly sessions?: VisibleRootSessionPort & {
    readVisibleRoots(
      includeArchived: boolean,
      abort?: AbortSignal,
    ): ReturnType<VisibleRootSessionPort["readVisibleRoots"]>;
  };
  /** OpenCode 2 composition supplies both ports; partial registry wiring fails closed. */
  readonly registry?: ParticipantRegistryListingPort;
  readonly revalidation?: ParticipantRootRevalidationPort;
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

// biome-ignore format: keep each native port beside its exact failure mapping.
export async function listVisibleRootSessions(
  ports: SessionListPorts,
  context: SessionListContext,
  query: SessionListQuery = {},
): Promise<DomainResult<readonly VisibleRootSession[]>> {
  assertCommunicatorReady(ports.readiness);
  const source = validateSessionId(context.sourceSessionId);
  if (!source.ok) return domainFailure("invalid_arguments", source.message, false);
  const limit = query.limit ?? defaultSessionLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumSessionLimit) return invalidLimit();
  const includeArchived = query.includeArchived ?? false;
  const status = query.status ?? "all";
  {
    const membershipCall = await invoke(context, (signal) => ports.membership.readCurrentRoots(
      context.workspaceKey,
      source.value,
      source.value,
      signal,
    ));
    if (membershipCall.kind === "expired") {
      return domainFailure("deadline_expired", "Session list invocation deadline expired.", false);
    }
    if (membershipCall.kind === "rejected") {
      return domainFailure("native_unavailable", "Current session membership is unavailable.", true);
    }
    const membership = membershipCall.value;
    if (!membership.sourceVisible) {
      return domainFailure(
        "caller_not_visible",
        "Caller is not a current visible root session.",
        false,
      );
    }
  }
  {
    const registryMode = ports.registry !== undefined || ports.revalidation !== undefined;
    if (registryMode && (!ports.registry || !ports.revalidation)) {
      return domainFailure(
        "native_unavailable",
        "Visible session state is temporarily unavailable.",
        true,
      );
    }
    const sessionCall = await invoke(context, async (signal) => {
      if (!ports.registry || !ports.revalidation) {
        if (!ports.sessions) throw new Error("visible-root listing port is unavailable");
        return ports.sessions.readVisibleRoots(includeArchived, signal);
      }
      const candidates = await ports.registry.listRootCandidates(
        context.workspaceKey,
        maximumSessionLimit,
      );
      if (candidates.length > maximumSessionLimit) {
        throw new Error("participant registry returned an unbounded candidate set");
      }
      const observations = await Promise.all(
        candidates.map((candidate) =>
          ports.revalidation?.revalidateRoot(context.workspaceKey, candidate.id, signal),
        ),
      );
      return observations.filter((item) => item !== undefined);
    });
    if (sessionCall.kind === "expired") {
      return domainFailure("deadline_expired", "Session list invocation deadline expired.", false);
    }
    if (sessionCall.kind === "rejected") {
      return domainFailure(
        "native_unavailable",
        "Visible session state is temporarily unavailable.",
        true,
      );
    }
    const sessions = sessionCall.value;
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
  }
}
