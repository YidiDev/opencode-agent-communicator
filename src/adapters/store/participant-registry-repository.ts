import type {
  ParticipantObservation,
  ParticipantRegistryMutationResult,
} from "../../application/participant-registry-ports";
import { type FencingToken, OwnershipLostFault } from "../../domain/ownership";
import { sanitizeDisplayTitle } from "../../domain/sanitize-display";
import {
  type ActivityStatus,
  type ParticipantRegistryRecord,
  type ParticipantRootKind,
  type ParticipantVisibility,
  participantRegistryPolicy,
  type SessionId,
  validateSessionId,
} from "../../domain/sessions";
import type { WorkspaceKey } from "../../domain/workspaces";
import { classifyDeliveryStorageError } from "./delivery-repository";
import type { OwnershipRepository } from "./ownership-repository";
import { requestPageLimitReached } from "./request-repository-shared";
import type { StoreContext } from "./store-types";
import { StoreIntegrityError } from "./store-types";

interface ParticipantRow {
  readonly sessionId: string;
  readonly rootKind: string;
  readonly parentSessionId: string | null;
  readonly title: string | null;
  readonly archivedState: string;
  readonly activityStatus: string;
  readonly activityObservedAtMs: number | null;
  readonly visibility: string;
  readonly visibilityObservedAtMs: number | null;
  readonly firstObservedAtMs: number;
  readonly lastObservedAtMs: number;
}

const columns = `session_id AS sessionId, root_kind AS rootKind,
  parent_session_id AS parentSessionId, display_title AS title,
  archived_state AS archivedState, activity_status AS activityStatus,
  activity_observed_at_ms AS activityObservedAtMs, visibility_state AS visibility,
  visibility_observed_at_ms AS visibilityObservedAtMs,
  first_observed_at_ms AS firstObservedAtMs, last_observed_at_ms AS lastObservedAtMs`;

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validObservation(value: ParticipantObservation): boolean {
  const title = value.title;
  return (
    validateSessionId(value.sessionId).ok &&
    (value.parentSessionId === null || validateSessionId(value.parentSessionId).ok) &&
    ((value.rootKind === "root" && value.parentSessionId === null) ||
      (value.rootKind === "child" &&
        value.parentSessionId !== null &&
        value.parentSessionId !== value.sessionId)) &&
    (title === undefined ||
      (sanitizeDisplayTitle(title) === title &&
        Buffer.byteLength(title, "utf8") <= participantRegistryPolicy.maximumTitleUtf8Bytes)) &&
    (value.activityStatus === undefined ||
      value.activityStatus === "busy" ||
      value.activityStatus === "retry" ||
      value.activityStatus === "idle" ||
      value.activityStatus === "unknown") &&
    (value.visibility === undefined ||
      value.visibility === "visible" ||
      value.visibility === "not_visible")
  );
}

function hydrate(row: ParticipantRow): ParticipantRegistryRecord {
  const session = validateSessionId(row.sessionId);
  const parent = row.parentSessionId === null ? undefined : validateSessionId(row.parentSessionId);
  if (
    !session.ok ||
    (parent && !parent.ok) ||
    (row.rootKind !== "root" && row.rootKind !== "child") ||
    !["active", "archived", "unknown"].includes(row.archivedState) ||
    !["busy", "retry", "idle", "unknown"].includes(row.activityStatus) ||
    !["visible", "not_visible", "unknown"].includes(row.visibility) ||
    !validTimestamp(row.firstObservedAtMs) ||
    !validTimestamp(row.lastObservedAtMs)
  ) {
    throw new StoreIntegrityError("Stored participant registry metadata is malformed.");
  }
  return {
    id: session.value,
    rootKind: row.rootKind as ParticipantRootKind,
    parentSessionId: parent?.ok ? parent.value : null,
    title: row.title,
    isArchived: row.archivedState === "unknown" ? null : row.archivedState === "archived",
    activityStatus: row.activityStatus as ActivityStatus,
    activityObservedAtMs: row.activityObservedAtMs,
    visibility: row.visibility as ParticipantVisibility,
    visibilityObservedAtMs: row.visibilityObservedAtMs,
    firstObservedAtMs: row.firstObservedAtMs,
    lastObservedAtMs: row.lastObservedAtMs,
  };
}

function mutationFailure(cause: unknown, atPageLimit: boolean): ParticipantRegistryMutationResult {
  if (cause instanceof OwnershipLostFault) return { ok: false, code: "ownership_lost" };
  if (cause instanceof Error && cause.message.includes("participant registry ceiling exceeded")) {
    return { ok: false, code: "quota_exceeded" };
  }
  const code = classifyDeliveryStorageError(cause, () => atPageLimit);
  return { ok: false, code: code === "rate_limited" ? "storage_unavailable" : code };
}

function archivedState(
  observation: ParticipantObservation,
  previous: ParticipantRegistryRecord | undefined,
): "active" | "archived" | "unknown" {
  if (observation.isArchived !== undefined) return observation.isArchived ? "archived" : "active";
  if (previous?.isArchived === true) return "archived";
  if (previous?.isArchived === false) return "active";
  return "unknown";
}

function activityObservedAt(
  observation: ParticipantObservation,
  previous: ParticipantRegistryRecord | undefined,
  observedAtMs: number,
): number | null {
  if (observation.activityStatus === undefined) return previous?.activityObservedAtMs ?? null;
  return observation.activityStatus === "unknown" ? null : observedAtMs;
}

export class ParticipantRegistryRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  record(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly observedAtMs: number;
    readonly observations: readonly ParticipantObservation[];
  }): ParticipantRegistryMutationResult {
    const unique = new Set(input.observations.map((item) => item.sessionId));
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !validTimestamp(input.observedAtMs) ||
      input.observations.length > participantRegistryPolicy.maximumObservationBatch ||
      unique.size !== input.observations.length ||
      !input.observations.every(validObservation)
    ) {
      return { ok: false, code: "state_conflict" };
    }
    const atPageLimit = requestPageLimitReached(this.context);
    try {
      const transaction = this.context.database.transaction(() => this.recordValidated(input));
      return transaction.immediate();
    } catch (cause: unknown) {
      return mutationFailure(cause, atPageLimit);
    }
  }

  private recordValidated(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly observedAtMs: number;
    readonly observations: readonly ParticipantObservation[];
  }): { readonly ok: true; readonly recorded: number } {
    this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
    this.context.database.run(
      "INSERT OR IGNORE INTO workspaces(workspace_key, created_at_ms) VALUES (?, ?)",
      [input.workspaceKey, input.observedAtMs],
    );
    let recorded = 0;
    for (const observation of input.observations) {
      if (this.recordOne(input.workspaceKey, input.observedAtMs, observation)) recorded += 1;
    }
    return { ok: true, recorded };
  }

  private recordOne(
    workspaceKey: WorkspaceKey,
    observedAtMs: number,
    observation: ParticipantObservation,
  ): boolean {
    const previous = this.select(workspaceKey, observation.sessionId);
    if (previous && observedAtMs < previous.lastObservedAtMs) return false;
    const activity = observation.activityStatus ?? previous?.activityStatus ?? "unknown";
    const visibility = observation.visibility ?? previous?.visibility ?? "unknown";
    this.context.database.run(
      `INSERT INTO communicator_participants(
               workspace_key, session_id, root_kind, parent_session_id, display_title,
               archived_state, activity_status, activity_observed_at_ms, visibility_state,
               visibility_observed_at_ms, first_observed_at_ms, last_observed_at_ms,
               observation_source
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'host')
             ON CONFLICT(workspace_key, session_id) DO UPDATE SET
               root_kind = excluded.root_kind, parent_session_id = excluded.parent_session_id,
               display_title = excluded.display_title, archived_state = excluded.archived_state,
               activity_status = excluded.activity_status,
               activity_observed_at_ms = excluded.activity_observed_at_ms,
               visibility_state = excluded.visibility_state,
               visibility_observed_at_ms = excluded.visibility_observed_at_ms,
               last_observed_at_ms = excluded.last_observed_at_ms, observation_source = 'host'`,
      [
        workspaceKey,
        observation.sessionId,
        observation.rootKind,
        observation.parentSessionId,
        observation.title ?? previous?.title ?? null,
        archivedState(observation, previous),
        activity,
        activityObservedAt(observation, previous, observedAtMs),
        visibility,
        observation.visibility === undefined
          ? (previous?.visibilityObservedAtMs ?? null)
          : observedAtMs,
        previous?.firstObservedAtMs ?? observedAtMs,
        observedAtMs,
      ],
    );
    return true;
  }

  listRoots(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly limit: number;
  }): readonly ParticipantRegistryRecord[] {
    this.validateRead(input.workspaceKey, input.limit);
    const transaction = this.context.database.transaction(() => {
      this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
      return this.context.database
        .query<ParticipantRow, [string, number]>(
          `SELECT ${columns} FROM communicator_participants
           WHERE workspace_key = ? AND root_kind = 'root'
           ORDER BY last_observed_at_ms DESC, session_id LIMIT ?`,
        )
        .all(input.workspaceKey, input.limit)
        .map(hydrate);
    });
    return transaction.immediate();
  }

  getRoot(input: {
    readonly fencingToken: FencingToken;
    readonly workspaceKey: WorkspaceKey;
    readonly sessionId: SessionId;
  }): ParticipantRegistryRecord | undefined {
    this.validateRead(input.workspaceKey, 1);
    if (!validateSessionId(input.sessionId).ok) {
      throw new StoreIntegrityError("Participant registry query identity is malformed.");
    }
    const transaction = this.context.database.transaction(() => {
      this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
      const row = this.context.database
        .query<ParticipantRow, [string, string]>(
          `SELECT ${columns} FROM communicator_participants
           WHERE workspace_key = ? AND session_id = ? AND root_kind = 'root'`,
        )
        .get(input.workspaceKey, input.sessionId);
      return row ? hydrate(row) : undefined;
    });
    return transaction.immediate();
  }

  private select(
    workspaceKey: WorkspaceKey,
    sessionId: SessionId,
  ): ParticipantRegistryRecord | undefined {
    const row = this.context.database
      .query<ParticipantRow, [string, string]>(
        `SELECT ${columns} FROM communicator_participants WHERE workspace_key = ? AND session_id = ?`,
      )
      .get(workspaceKey, sessionId);
    return row ? hydrate(row) : undefined;
  }

  private validateRead(workspaceKey: WorkspaceKey, limit: number): void {
    if (
      workspaceKey !== this.context.workspaceKey ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > participantRegistryPolicy.maximumListLimit
    ) {
      throw new StoreIntegrityError("Participant registry query is outside its bounded contract.");
    }
  }
}
