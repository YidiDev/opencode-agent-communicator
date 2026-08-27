import type {
  PrepareStartOperationInput,
  StartOperationPersistencePort,
} from "../../application/session-start-ports";
import {
  startRateEventsPerWorkspaceHardCeiling,
  startRecoveryScanHardCeiling,
} from "../../domain/safety-ceilings";
import type { StartOperation } from "../../domain/session-start";
import type { OwnershipRepository } from "./ownership-repository";
import {
  hydrateStartOperation,
  type StartOperationRow,
  startOperationColumns,
} from "./start-operation-rows";
import type { StoreContext } from "./store-types";

export class StartOperationMaintenanceRepository {
  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {}

  collectExpiredRateEvents(input: PrepareStartOperationInput): void {
    const since = Math.max(0, input.nowMs - input.limits.rateWindowMs);
    this.context.database.run(
      `DELETE FROM start_rate_events WHERE sequence IN (
         SELECT sequence FROM start_rate_events
         WHERE workspace_key = ? AND occurred_at_ms < ? ORDER BY sequence LIMIT 1000
       )`,
      [input.workspaceKey, since],
    );
  }

  collectExpiredTerminalOperations(input: PrepareStartOperationInput): void {
    const cutoff = Math.max(0, input.nowMs - input.limits.terminalRetentionMs);
    this.context.database.run(
      `DELETE FROM start_operations WHERE id IN (
         SELECT o.id FROM start_operations AS o
         WHERE o.workspace_key = ? AND o.updated_at_ms < ?
           AND o.creation_state IN ('failed','policy_denied','approval_rejected')
           AND NOT EXISTS (SELECT 1 FROM managed_sessions AS m WHERE m.operation_id = o.id)
         ORDER BY o.updated_at_ms, o.id LIMIT 1000
       )`,
      [input.workspaceKey, cutoff],
    );
  }

  async listRecoverable(
    input: Parameters<StartOperationPersistencePort["listRecoverable"]>[0],
  ): Promise<readonly StartOperation[]> {
    this.ownership.assertCurrent(input.fencingToken);
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > startRecoveryScanHardCeiling
    ) {
      throw new TypeError("Start recovery query is outside its hard boundary.");
    }
    return this.context.database
      .query<StartOperationRow, [string, number, number]>(
        `SELECT ${startOperationColumns} FROM start_operations
         WHERE workspace_key = ? AND (
             creation_state IN ('prepared','submitting','outcome_unknown') OR
            title_state IN ('prepared','submitting') OR
            admission_state IN ('prepared','submitting')) AND (
             creation_state IN ('prepared','outcome_unknown') OR
            (creation_state = 'created' AND title_state = 'prepared') OR
            (creation_state = 'created' AND admission_state = 'prepared') OR
            ((creation_state = 'submitting' OR title_state = 'submitting' OR
              admission_state = 'submitting') AND claimed_fencing_token <> ?))
         ORDER BY created_at_ms, id LIMIT ?`,
      )
      .all(input.workspaceKey, input.excludeClaimedByToken, input.limit)
      .map(hydrateStartOperation);
  }

  collectRetention(
    input: Parameters<StartOperationPersistencePort["collectRetention"]>[0],
  ): Awaited<ReturnType<StartOperationPersistencePort["collectRetention"]>> {
    if (
      input.workspaceKey !== this.context.workspaceKey ||
      !Number.isSafeInteger(input.nowMs) ||
      !Number.isSafeInteger(input.terminalRetentionMs) ||
      !Number.isSafeInteger(input.rateRetentionMs) ||
      !Number.isSafeInteger(input.limit) ||
      input.nowMs < 0 ||
      input.terminalRetentionMs < 1 ||
      input.rateRetentionMs < 1 ||
      input.limit < 1 ||
      input.limit > startRateEventsPerWorkspaceHardCeiling
    ) {
      return { ok: false, code: "state_conflict" };
    }
    return this.context.database
      .transaction(() => {
        this.ownership.assertCurrent(input.fencingToken);
        const operationCutoff = Math.max(0, input.nowMs - input.terminalRetentionMs);
        const rateCutoff = Math.max(0, input.nowMs - input.rateRetentionMs);
        const operations = this.context.database.run(
          `DELETE FROM start_operations WHERE id IN (
               SELECT o.id FROM start_operations AS o
               WHERE o.workspace_key = ? AND o.updated_at_ms < ?
                 AND o.creation_state IN ('failed','policy_denied','approval_rejected')
                 AND NOT EXISTS (SELECT 1 FROM managed_sessions AS m WHERE m.operation_id = o.id)
               ORDER BY o.updated_at_ms, o.id LIMIT ?
             )`,
          [input.workspaceKey, operationCutoff, input.limit],
        ).changes;
        const rates = this.context.database.run(
          `DELETE FROM start_rate_events WHERE sequence IN (
               SELECT sequence FROM start_rate_events WHERE workspace_key = ?
                 AND occurred_at_ms < ? ORDER BY sequence LIMIT ?
             )`,
          [input.workspaceKey, rateCutoff, input.limit],
        ).changes;
        return {
          ok: true as const,
          deletedOperations: operations,
          deletedRateEvents: rates,
        };
      })
      .immediate();
  }
}
