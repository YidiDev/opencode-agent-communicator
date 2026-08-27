import type {
  ClaimedStartStep,
  StartOperationPersistencePort,
  StartStep,
  StartStoreResult,
  StartTransitionInput,
} from "../../application/session-start-ports";
import { OwnershipLostFault } from "../../domain/ownership";
import type { StartOperation } from "../../domain/session-start";
import { classifyDeliveryStorageError } from "./delivery-repository";
import type { OwnershipRepository } from "./ownership-repository";
import { StartOperationMaintenanceRepository } from "./start-operation-maintenance-repository";
import { StartOperationPreparationRepository } from "./start-operation-preparation-repository";
import { StartOperationRecords } from "./start-operation-records";
import type { StoreContext } from "./store-types";

function failure(cause: unknown): Extract<StartStoreResult, { readonly ok: false }> {
  if (cause instanceof OwnershipLostFault) return { ok: false, code: "ownership_lost" };
  return { ok: false, code: classifyDeliveryStorageError(cause, () => false) };
}

export class StartOperationRepository implements StartOperationPersistencePort {
  private readonly records: StartOperationRecords;
  private readonly maintenance: StartOperationMaintenanceRepository;
  private readonly preparation: StartOperationPreparationRepository;

  constructor(
    private readonly context: StoreContext,
    private readonly ownership: OwnershipRepository,
  ) {
    this.records = new StartOperationRecords(context);
    this.maintenance = new StartOperationMaintenanceRepository(context, ownership);
    this.preparation = new StartOperationPreparationRepository(
      context,
      ownership,
      this.records,
      this.maintenance,
    );
  }

  async createOrResume(
    input: Parameters<StartOperationPersistencePort["createOrResume"]>[0],
  ): Promise<StartStoreResult> {
    return this.preparation.createOrResume(input);
  }

  async isManagedSession(input: Parameters<StartOperationPersistencePort["isManagedSession"]>[0]) {
    this.ownership.assertOrdinaryWorkAllowed(input.fencingToken);
    if (input.workspaceKey !== this.context.workspaceKey) return false;
    return Boolean(
      this.context.database
        .query<{ found: number }, [string, string]>(
          "SELECT 1 AS found FROM managed_sessions WHERE workspace_key = ? AND session_id = ?",
        )
        .get(input.workspaceKey, input.sessionId),
    );
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
          const expected = "prepared";
          const changed = this.context.database.run(
            `UPDATE start_operations SET ${column} = 'submitting', claimed_fencing_token = ?,
               updated_at_ms = ?
            WHERE workspace_key = ? AND id = ? AND ${column} = ?
              AND claimed_fencing_token IS NULL
              AND (? = 'creation' OR creation_state = 'created')`,
            [
              input.fencingToken,
              input.nowMs,
              input.workspaceKey,
              input.operationId,
              expected,
              input.step,
            ],
          );
          if (changed.changes !== 1) return { ok: false as const, code: "state_conflict" as const };
          const operation = this.records.select(input.operationId);
          const payload = this.records.payload(input.operationId);
          if (!operation || !payload) throw new Error("Claimed start operation state is absent.");
          return { ok: true as const, operation, arguments: payload };
        })
        .immediate();
    } catch (cause: unknown) {
      const result = failure(cause);
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
      return failure(cause);
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
               updated_at_ms = ?
             WHERE workspace_key = ? AND id = ? AND ${input.step}_state = 'submitting'
               AND claimed_fencing_token <> ?`,
            [terminal, input.nowMs, input.workspaceKey, input.operationId, input.fencingToken],
          );
          if (changed.changes !== 1) return { ok: false as const, code: "state_conflict" as const };
          if (input.step === "creation" || input.step === "admission") {
            if (input.step === "admission") {
              this.context.database.run(
                "DELETE FROM start_operation_payloads WHERE operation_id = ?",
                [input.operationId],
              );
            } else {
              this.markProvenanceUnresolved(input);
            }
          }
          const operation = this.records.select(input.operationId);
          if (!operation) throw new Error("Recovered start operation state is absent.");
          return { ok: true as const, operation };
        })
        .immediate();
    } catch (cause: unknown) {
      return failure(cause);
    }
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
      return failure(cause);
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
    this.confirmProvenance(input, "ambiguous");
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
      return failure(cause);
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
      return failure(cause);
    }
  }

  async completeCreation(
    input: Parameters<StartOperationPersistencePort["completeCreation"]>[0],
  ): Promise<StartStoreResult> {
    return this.complete(input, "creation", input.state);
  }

  async completeTitle(
    input: Parameters<StartOperationPersistencePort["completeTitle"]>[0],
  ): Promise<StartStoreResult> {
    return this.complete(input, "title", input.state);
  }

  async completeAdmission(
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
              updated_at_ms = ?
            WHERE workspace_key = ? AND id = ? AND ${step}_state = 'submitting'
              AND claimed_fencing_token = ?`,
            [state, input.nowMs, input.workspaceKey, input.operationId, input.fencingToken],
          );
          if (changed.changes !== 1) return { ok: false as const, code: "state_conflict" as const };
          if (step === "creation" && state === "created") {
            this.context.database.run(
              `UPDATE start_operations SET
               title_state = CASE WHEN EXISTS (
                 SELECT 1 FROM start_operation_payloads
                 WHERE operation_id = ? AND title IS NOT NULL
               ) THEN 'prepared' ELSE 'skipped' END,
               admission_state = 'prepared' WHERE workspace_key = ? AND id = ?`,
              [input.operationId, input.workspaceKey, input.operationId],
            );
            this.confirmProvenance(input);
          }
          if (step === "creation" && state === "outcome_unknown") {
            this.markProvenanceUnresolved(input);
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
      return failure(cause);
    }
  }

  private markProvenanceUnresolved(input: StartTransitionInput): void {
    const changed = this.context.database.run(
      `UPDATE managed_sessions SET provenance_state = 'unresolved'
       WHERE workspace_key = ? AND operation_id = ? AND provenance_state = 'reserved'`,
      [input.workspaceKey, input.operationId],
    );
    if (changed.changes !== 1) throw new Error("Managed-session reservation is absent.");
  }

  private confirmProvenance(
    input: StartTransitionInput,
    expected: "reserved" | "ambiguous" = "reserved",
  ): void {
    const operation = this.records.select(input.operationId);
    if (!operation) throw new Error("Created start operation is absent.");
    const changed = this.context.database.run(
      `UPDATE managed_sessions SET provenance_state = 'created'
       WHERE session_id = ? AND workspace_key = ? AND source_session_id = ? AND operation_id = ?
          AND (? = 'ambiguous' AND provenance_state IN ('reserved','unresolved') OR
               ? = 'reserved' AND provenance_state = 'reserved')`,
      [
        operation.sessionId,
        input.workspaceKey,
        operation.sourceSessionId,
        operation.id,
        expected,
        expected,
      ],
    );
    if (changed.changes !== 1) throw new Error("Managed-session reservation is absent.");
  }

  async listRecoverable(
    input: Parameters<StartOperationPersistencePort["listRecoverable"]>[0],
  ): Promise<readonly StartOperation[]> {
    return this.maintenance.listRecoverable(input);
  }

  async collectRetention(
    input: Parameters<StartOperationPersistencePort["collectRetention"]>[0],
  ): ReturnType<StartOperationPersistencePort["collectRetention"]> {
    try {
      return this.maintenance.collectRetention(input);
    } catch (cause: unknown) {
      return failure(cause) as Extract<
        Awaited<ReturnType<StartOperationPersistencePort["collectRetention"]>>,
        { readonly ok: false }
      >;
    }
  }
}
