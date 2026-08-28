import type { StartTransitionInput } from "../../application/session-start-ports";
import type { StartOperationRecords } from "./start-operation-records";
import type { StoreContext } from "./store-types";

export class StartOperationProvenance {
  constructor(
    private readonly context: StoreContext,
    private readonly records: StartOperationRecords,
  ) {}

  markUnresolved(input: StartTransitionInput): void {
    const changed = this.context.database.run(
      `UPDATE managed_sessions SET provenance_state = 'unresolved'
       WHERE workspace_key = ? AND operation_id = ? AND provenance_state = 'reserved'`,
      [input.workspaceKey, input.operationId],
    );
    if (changed.changes !== 1) throw new Error("Managed-session reservation is absent.");
  }

  confirm(input: StartTransitionInput, expected: "reserved" | "ambiguous" = "reserved"): void {
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
}
