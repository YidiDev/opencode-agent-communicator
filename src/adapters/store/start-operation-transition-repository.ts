import type {
  ClaimedStartStep,
  StartOperationPersistencePort,
  StartStep,
  StartStoreResult,
  StartTransitionInput,
} from "../../application/session-start-ports";
import type { OwnershipRepository } from "./ownership-repository";
import { startOperationFailure } from "./start-operation-failure";
import { StartOperationProvenance } from "./start-operation-provenance";
import type { StartOperationRecords } from "./start-operation-records";
import type { StoreContext } from "./store-types";

export class StartOperationTransitionRepository {
  private readonly provenance: StartOperationProvenance;

  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
    private readonly records: StartOperationRecords,
  ) {
    this.provenance = new StartOperationProvenance(context, records);
  }

  async claimStep(
    input: StartTransitionInput & { readonly step: StartStep },
  ): Promise<ClaimedStartStep> {
    if (input.workspaceKey !== this.context.workspaceKey)
      return { ok: false, code: "state_conflict" };
    try {
      return this.context.database
        .transaction(() => {
          this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
          if (input.step === "creation") {
            const capacity = this.context.database
              .query<{ count: number; configuredLimit: number }, [string, string]>(
                `SELECT
                   (SELECT count(*) FROM start_operations AS pending
                    WHERE pending.workspace_key = operation.workspace_key
                      AND pending.creation_state IN ('submitting','outcome_unknown')) AS count,
                   unresolved_provenance_limit AS configuredLimit
                 FROM start_operations AS operation WHERE workspace_key = ? AND id = ?`,
              )
              .get(input.workspaceKey, input.operationId);
            if (!capacity || capacity.count >= capacity.configuredLimit) {
              return {
                ok: false as const,
                code: "unresolved_provenance_quota_exceeded" as const,
              };
            }
          }
          const column = `${input.step}_state`;
          const changed = this.context.database.run(
            `UPDATE start_operations SET ${column} = 'submitting', claimed_fencing_token = ?,
               updated_at_ms = ? WHERE workspace_key = ? AND id = ? AND ${column} = 'prepared'
               AND claimed_fencing_token IS NULL
               AND (? = 'creation' OR creation_state = 'created')`,
            [input.fencingToken, input.nowMs, input.workspaceKey, input.operationId, input.step],
          );
          if (changed.changes !== 1) return { ok: false as const, code: "state_conflict" as const };
          const operation = this.records.select(input.operationId);
          const payload = this.records.payload(input.operationId);
          if (!operation || !payload) throw new Error("Claimed start operation state is absent.");
          return { ok: true as const, operation, arguments: payload };
        })
        .immediate();
    } catch (cause: unknown) {
      const result = startOperationFailure(cause);
      return { ok: false, code: result.code };
    }
  }

  async restorePreparedClaim(
    input: StartTransitionInput & { readonly step: StartStep },
  ): Promise<StartStoreResult> {
    if (input.workspaceKey !== this.context.workspaceKey)
      return { ok: false, code: "state_conflict" };
    try {
      return this.context.database
        .transaction(() => {
          this.ownership.assertCurrent(input.fencingToken);
          const changed = this.context.database.run(
            `UPDATE start_operations SET ${input.step}_state = 'prepared',
               claimed_fencing_token = NULL, updated_at_ms = ?
             WHERE workspace_key = ? AND id = ? AND ${input.step}_state = 'submitting'
               AND claimed_fencing_token = ?`,
            [input.nowMs, input.workspaceKey, input.operationId, input.fencingToken],
          );
          if (changed.changes !== 1) return { ok: false as const, code: "state_conflict" as const };
          const operation = this.records.select(input.operationId);
          if (!operation) throw new Error("Restored start operation state is absent.");
          return { ok: true as const, operation };
        })
        .immediate();
    } catch (cause: unknown) {
      return startOperationFailure(cause);
    }
  }

  async classifyStaleSubmitting(
    input: StartTransitionInput & { readonly step: StartStep },
  ): Promise<StartStoreResult> {
    if (input.workspaceKey !== this.context.workspaceKey)
      return { ok: false, code: "state_conflict" };
    const terminal = input.step === "admission" ? "admission_unknown" : "outcome_unknown";
    try {
      return this.context.database
        .transaction(() => {
          this.ownership.assertCurrent(input.fencingToken);
          const changed = this.context.database.run(
            `UPDATE start_operations SET ${input.step}_state = ?, claimed_fencing_token = NULL,
               updated_at_ms = ? WHERE workspace_key = ? AND id = ?
               AND ${input.step}_state = 'submitting' AND claimed_fencing_token <> ?`,
            [terminal, input.nowMs, input.workspaceKey, input.operationId, input.fencingToken],
          );
          if (changed.changes !== 1) return { ok: false as const, code: "state_conflict" as const };
          if (input.step === "admission") {
            this.context.database.run(
              "DELETE FROM start_operation_payloads WHERE operation_id = ?",
              [input.operationId],
            );
          } else if (input.step === "creation") {
            this.provenance.markUnresolved(input);
          }
          const operation = this.records.select(input.operationId);
          if (!operation) throw new Error("Recovered start operation state is absent.");
          return { ok: true as const, operation };
        })
        .immediate();
    } catch (cause: unknown) {
      return startOperationFailure(cause);
    }
  }

  completeCreation(
    input: Parameters<StartOperationPersistencePort["completeCreation"]>[0],
  ): Promise<StartStoreResult> {
    return this.complete(input, "creation", input.state);
  }

  completeTitle(
    input: Parameters<StartOperationPersistencePort["completeTitle"]>[0],
  ): Promise<StartStoreResult> {
    return this.complete(input, "title", input.state);
  }

  completeAdmission(
    input: Parameters<StartOperationPersistencePort["completeAdmission"]>[0],
  ): Promise<StartStoreResult> {
    return this.complete(input, "admission", input.state);
  }

  private async complete(
    input: StartTransitionInput,
    step: StartStep,
    state: string,
  ): Promise<StartStoreResult> {
    if (input.workspaceKey !== this.context.workspaceKey)
      return { ok: false, code: "state_conflict" };
    try {
      return this.context.database
        .transaction(() => {
          this.ownership.assertCurrent(input.fencingToken);
          const changed = this.context.database.run(
            `UPDATE start_operations SET ${step}_state = ?, claimed_fencing_token = NULL,
             updated_at_ms = ? WHERE workspace_key = ? AND id = ? AND ${step}_state = 'submitting'
             AND claimed_fencing_token = ?`,
            [state, input.nowMs, input.workspaceKey, input.operationId, input.fencingToken],
          );
          if (changed.changes !== 1) return { ok: false as const, code: "state_conflict" as const };
          if (step === "creation" && state === "created") {
            this.context.database.run(
              `UPDATE start_operations SET title_state = CASE WHEN EXISTS (
                 SELECT 1 FROM start_operation_payloads WHERE operation_id = ? AND title IS NOT NULL
               ) THEN 'prepared' ELSE 'skipped' END, admission_state = 'prepared'
               WHERE workspace_key = ? AND id = ?`,
              [input.operationId, input.workspaceKey, input.operationId],
            );
            this.provenance.confirm(input);
          }
          if (step === "creation" && state === "outcome_unknown") {
            this.provenance.markUnresolved(input);
          }
          if (step === "creation" && state === "failed") {
            this.context.database.run(
              `DELETE FROM managed_sessions WHERE workspace_key = ? AND operation_id = ?
                 AND provenance_state = 'reserved' AND ? = 'failed'`,
              [input.workspaceKey, input.operationId, state],
            );
            this.context.database.run(
              "DELETE FROM start_operation_payloads WHERE operation_id = ?",
              [input.operationId],
            );
          }
          if (step === "admission") {
            this.context.database.run(
              "DELETE FROM start_operation_payloads WHERE operation_id = ?",
              [input.operationId],
            );
          }
          const operation = this.records.select(input.operationId);
          if (!operation) throw new Error("Completed start operation state is absent.");
          return { ok: true as const, operation };
        })
        .immediate();
    } catch (cause: unknown) {
      return startOperationFailure(cause);
    }
  }
}
