import type {
  StartOperationPersistencePort,
  StartStoreResult,
  StartTransitionInput,
} from "../../application/session-start-ports";
import type { StartOperation } from "../../domain/session-start";
import type { OwnershipRepository } from "./ownership-repository";
import { startOperationFailure } from "./start-operation-failure";
import { StartOperationProvenance } from "./start-operation-provenance";
import type { StartOperationRecords } from "./start-operation-records";
import type { StoreContext } from "./store-types";

export class StartOperationResolutionRepository {
  private readonly provenance: StartOperationProvenance;

  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
    private readonly records: StartOperationRecords,
  ) {
    this.provenance = new StartOperationProvenance(context, records);
  }

  async reconcileUnknownCreation(
    input: Parameters<StartOperationPersistencePort["reconcileUnknownCreation"]>[0],
  ): Promise<StartStoreResult> {
    if (input.workspaceKey !== this.context.workspaceKey)
      return { ok: false, code: "state_conflict" };
    try {
      return this.context.database
        .transaction(() => {
          this.ownership.assertCurrent(input.fencingToken);
          const operation = this.records.select(input.operationId);
          if (operation?.creationState !== "outcome_unknown") {
            return { ok: false as const, code: "state_conflict" as const };
          }
          const payloadAvailable = Boolean(this.records.payload(input.operationId));
          if (input.outcome === "matching") {
            if (!this.reconcileMatchingCreation(input, operation, payloadAvailable)) {
              return { ok: false as const, code: "quota_exceeded" as const };
            }
          } else {
            this.reconcileAbsentCreation(input);
          }
          const reconciled = this.records.select(input.operationId);
          if (!reconciled) throw new Error("Reconciled start operation is absent.");
          return { ok: true as const, operation: reconciled };
        })
        .immediate();
    } catch (cause: unknown) {
      return startOperationFailure(cause);
    }
  }

  async releasePreparedReservation(input: StartTransitionInput): Promise<StartStoreResult> {
    if (input.workspaceKey !== this.context.workspaceKey)
      return { ok: false, code: "state_conflict" };
    try {
      return this.context.database
        .transaction(() => {
          this.ownership.assertCurrent(input.fencingToken);
          const operation = this.records.select(input.operationId);
          if (operation?.creationState !== "prepared") {
            return { ok: false as const, code: "state_conflict" as const };
          }
          this.context.database.run(
            `DELETE FROM managed_sessions WHERE workspace_key = ? AND operation_id = ?
               AND provenance_state = 'reserved'`,
            [input.workspaceKey, input.operationId],
          );
          return { ok: true as const, operation };
        })
        .immediate();
    } catch (cause: unknown) {
      return startOperationFailure(cause);
    }
  }

  async rejectPreparedStart(
    input: Parameters<StartOperationPersistencePort["rejectPreparedStart"]>[0],
  ): Promise<StartStoreResult> {
    if (input.workspaceKey !== this.context.workspaceKey)
      return { ok: false, code: "state_conflict" };
    try {
      return this.context.database
        .transaction(() => {
          this.ownership.assertCurrent(input.fencingToken);
          const operation = this.records.select(input.operationId);
          if (operation?.creationState !== "prepared") {
            return { ok: false as const, code: "state_conflict" as const };
          }
          this.context.database.run("DELETE FROM start_operation_payloads WHERE operation_id = ?", [
            input.operationId,
          ]);
          this.context.database.run(
            `DELETE FROM managed_sessions WHERE workspace_key = ? AND operation_id = ?
               AND provenance_state = 'reserved'`,
            [input.workspaceKey, input.operationId],
          );
          const changed = this.context.database.run(
            `UPDATE start_operations SET creation_state = ?, claimed_fencing_token = NULL,
               updated_at_ms = ? WHERE workspace_key = ? AND id = ? AND creation_state = 'prepared'`,
            [input.state, input.nowMs, input.workspaceKey, input.operationId],
          );
          if (changed.changes !== 1) return { ok: false as const, code: "state_conflict" as const };
          const rejected = this.records.select(input.operationId);
          if (!rejected) throw new Error("Rejected start operation state is absent.");
          return { ok: true as const, operation: rejected };
        })
        .immediate();
    } catch (cause: unknown) {
      return startOperationFailure(cause);
    }
  }

  private reconcileMatchingCreation(
    input: Parameters<StartOperationPersistencePort["reconcileUnknownCreation"]>[0],
    operation: StartOperation,
    payloadAvailable: boolean,
  ): boolean {
    const capacity = this.context.database
      .query<{ count: number; configuredLimit: number }, [string, string]>(
        `SELECT
           (SELECT count(*) FROM managed_sessions AS managed
            WHERE managed.workspace_key = operation.workspace_key
              AND managed.provenance_state NOT IN ('unresolved','deleted')) AS count,
           managed_session_limit AS configuredLimit
         FROM start_operations AS operation WHERE workspace_key = ? AND id = ?`,
      )
      .get(input.workspaceKey, input.operationId);
    if (!capacity || capacity.count >= capacity.configuredLimit) return false;
    const titleState = operation.titleRequested
      ? payloadAvailable
        ? "prepared"
        : "payload_unavailable"
      : "skipped";
    const admissionState = payloadAvailable ? "prepared" : "payload_unavailable";
    this.context.database.run(
      `UPDATE start_operations SET creation_state = 'created', title_state = ?,
         admission_state = ?, claimed_fencing_token = NULL, updated_at_ms = ?
       WHERE workspace_key = ? AND id = ? AND creation_state = 'outcome_unknown'`,
      [titleState, admissionState, input.nowMs, input.workspaceKey, input.operationId],
    );
    this.provenance.confirm(input, "ambiguous");
    return true;
  }

  private reconcileAbsentCreation(
    input: Parameters<StartOperationPersistencePort["reconcileUnknownCreation"]>[0],
  ): void {
    this.context.database.run("DELETE FROM start_operation_payloads WHERE operation_id = ?", [
      input.operationId,
    ]);
    this.context.database.run(
      `DELETE FROM managed_sessions WHERE workspace_key = ? AND operation_id = ?
         AND provenance_state IN ('reserved','unresolved')`,
      [input.workspaceKey, input.operationId],
    );
    this.context.database.run(
      `UPDATE start_operations SET creation_state = 'failed', claimed_fencing_token = NULL,
         updated_at_ms = ? WHERE workspace_key = ? AND id = ?
         AND creation_state = 'outcome_unknown'`,
      [input.nowMs, input.workspaceKey, input.operationId],
    );
  }
}
