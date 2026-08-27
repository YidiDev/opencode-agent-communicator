import type {
  PrepareStartOperationInput,
  StartStoreResult,
} from "../../application/session-start-ports";
import { OwnershipLostFault } from "../../domain/ownership";
import { classifyDeliveryStorageError } from "./delivery-repository";
import type { OwnershipRepository } from "./ownership-repository";
import type { StartOperationMaintenanceRepository } from "./start-operation-maintenance-repository";
import type { StartOperationRecords } from "./start-operation-records";
import {
  hydrateStartOperation,
  type StartOperationRow,
  startOperationColumns,
} from "./start-operation-rows";
import type { StoreContext } from "./store-types";

function failure(cause: unknown): Extract<StartStoreResult, { readonly ok: false }> {
  if (cause instanceof OwnershipLostFault) return { ok: false, code: "ownership_lost" };
  return { ok: false, code: classifyDeliveryStorageError(cause, () => false) };
}

export class StartOperationPreparationRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
    private readonly records: StartOperationRecords,
    private readonly maintenance: StartOperationMaintenanceRepository,
  ) {}

  async createOrResume(input: PrepareStartOperationInput): Promise<StartStoreResult> {
    if (input.workspaceKey !== this.context.workspaceKey)
      return { ok: false, code: "state_conflict" };
    try {
      return this.context.database
        .transaction(() => {
          this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
          const existing = this.context.database
            .query<
              StartOperationRow & { readonly managedSessionLimit: number },
              [string, string, string]
            >(
              `SELECT ${startOperationColumns}, managed_session_limit AS managedSessionLimit
               FROM start_operations
             WHERE workspace_key = ? AND source_session_id = ? AND idempotency_key = ?`,
            )
            .get(input.workspaceKey, input.sourceSessionId, input.arguments.idempotencyKey);
          if (existing) {
            const operation = hydrateStartOperation(existing);
            if (operation.argumentsSha256 !== input.argumentsSha256) {
              return { ok: false as const, code: "idempotency_conflict" as const };
            }
            const reservation = this.context.database
              .query<{ found: number }, [string]>(
                "SELECT 1 AS found FROM managed_sessions WHERE operation_id = ?",
              )
              .get(operation.id);
            if (!reservation && operation.creationState === "prepared") {
              this.maintenance.collectExpiredRateEvents(input);
              const quota = this.checkAdmissionLimits(input, false, existing.managedSessionLimit);
              if (quota) return { ok: false as const, code: quota };
              this.insertReservation(input, operation.id, operation.sessionId);
              this.insertRateEvent(input);
            }
            return { ok: true as const, operation };
          }
          this.maintenance.collectExpiredRateEvents(input);
          this.maintenance.collectExpiredTerminalOperations(input);
          const quota = this.checkAdmissionLimits(input);
          if (quota) return { ok: false as const, code: quota };
          this.context.database.run(
            "INSERT OR IGNORE INTO workspaces(workspace_key, created_at_ms) VALUES (?, ?)",
            [input.workspaceKey, input.nowMs],
          );
          this.insert(input);
          const operation = this.records.select(input.operationId);
          if (!operation) throw new Error("Start operation insertion was not observable.");
          return { ok: true as const, operation };
        })
        .immediate();
    } catch (cause: unknown) {
      return failure(cause);
    }
  }

  private checkAdmissionLimits(
    input: PrepareStartOperationInput,
    includeNewRecord = true,
    managedSessionLimit = input.limits.managedSessionsPerWorkspace,
  ): "quota_exceeded" | "unresolved_provenance_quota_exceeded" | "rate_limited" | undefined {
    const database = this.context.database;
    const unresolved = database
      .query<{ count: number }, [string]>(
        `SELECT count(*) AS count FROM managed_sessions
         WHERE workspace_key = ? AND provenance_state = 'unresolved'`,
      )
      .get(input.workspaceKey)?.count;
    if (unresolved === undefined || unresolved >= input.limits.unresolvedProvenancePerWorkspace) {
      return "unresolved_provenance_quota_exceeded";
    }
    if (includeNewRecord) {
      const operations = database
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM start_operations WHERE workspace_key = ?",
        )
        .get(input.workspaceKey)?.count;
      if (operations === undefined || operations >= input.limits.operationsPerWorkspace) {
        return "quota_exceeded";
      }
      const retainedPayloadBytes = database
        .query<{ bytes: number }, [string]>(
          `SELECT COALESCE(sum(length(CAST(p.initial_message AS BLOB)) +
           COALESCE(length(CAST(p.title AS BLOB)), 0) +
           COALESCE(length(CAST(p.agent AS BLOB)), 0) +
           COALESCE(length(CAST(p.model AS BLOB)), 0)), 0) AS bytes
         FROM start_operation_payloads AS p
         JOIN start_operations AS o ON o.id = p.operation_id WHERE o.workspace_key = ?`,
        )
        .get(input.workspaceKey)?.bytes;
      const payloadBytes = new TextEncoder().encode(
        `${input.arguments.initialMessage}${input.arguments.title ?? ""}${input.arguments.agent ?? ""}${input.arguments.model ?? ""}`,
      ).length;
      if (
        retainedPayloadBytes === undefined ||
        retainedPayloadBytes + payloadBytes > input.limits.payloadBytesPerWorkspace
      ) {
        return "quota_exceeded";
      }
    }
    const managed = database
      .query<{ count: number }, [string]>(
        `SELECT count(*) AS count FROM managed_sessions
         WHERE workspace_key = ? AND provenance_state NOT IN ('unresolved','deleted')`,
      )
      .get(input.workspaceKey)?.count;
    if (managed === undefined || managed >= managedSessionLimit) {
      return "quota_exceeded";
    }
    const since = Math.max(0, input.nowMs - input.limits.rateWindowMs);
    const source = database
      .query<{ count: number }, [string, string, number]>(
        `SELECT count(*) AS count FROM start_rate_events
         WHERE workspace_key = ? AND source_session_id = ? AND occurred_at_ms >= ?`,
      )
      .get(input.workspaceKey, input.sourceSessionId, since)?.count;
    const workspace = database
      .query<{ count: number }, [string, number]>(
        "SELECT count(*) AS count FROM start_rate_events WHERE workspace_key = ? AND occurred_at_ms >= ?",
      )
      .get(input.workspaceKey, since)?.count;
    return source === undefined ||
      workspace === undefined ||
      source >= input.limits.startsPerSourceWindow ||
      workspace >= input.limits.startsPerWorkspaceWindow
      ? "rate_limited"
      : undefined;
  }

  private insert(input: PrepareStartOperationInput): void {
    this.context.database.run(
      `INSERT INTO start_operations(id, workspace_key, source_session_id, idempotency_key,
         arguments_sha256, session_id, native_message_id, requested_agent, requested_model,
         title_requested, unresolved_provenance_limit, creation_state, title_state, admission_state,
         created_at_ms, updated_at_ms, managed_session_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 'not_started', 'not_started', ?, ?, ?)`,
      [
        input.operationId,
        input.workspaceKey,
        input.sourceSessionId,
        input.arguments.idempotencyKey,
        input.argumentsSha256,
        input.sessionId,
        input.nativeMessageId,
        input.arguments.agent ?? null,
        input.arguments.model ?? null,
        input.arguments.title === undefined ? 0 : 1,
        input.limits.unresolvedProvenancePerWorkspace,
        input.nowMs,
        input.nowMs,
        input.limits.managedSessionsPerWorkspace,
      ],
    );
    this.insertReservation(input, input.operationId, input.sessionId);
    this.context.database.run(
      `INSERT INTO start_operation_payloads(operation_id, initial_message, title, agent, model)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.operationId,
        input.arguments.initialMessage,
        input.arguments.title ?? null,
        input.arguments.agent ?? null,
        input.arguments.model ?? null,
      ],
    );
    this.insertRateEvent(input);
  }

  private insertReservation(
    input: PrepareStartOperationInput,
    operationId: string,
    sessionId: string,
  ): void {
    this.context.database.run(
      `INSERT INTO managed_sessions(session_id, workspace_key, source_session_id, operation_id,
         provenance_state, created_at_ms) VALUES (?, ?, ?, ?, 'reserved', ?)`,
      [sessionId, input.workspaceKey, input.sourceSessionId, operationId, input.nowMs],
    );
  }

  private insertRateEvent(input: PrepareStartOperationInput): void {
    this.context.database.run(
      `INSERT INTO start_rate_events(workspace_key, source_session_id, occurred_at_ms)
       VALUES (?, ?, ?)`,
      [input.workspaceKey, input.sourceSessionId, input.nowMs],
    );
  }
}
