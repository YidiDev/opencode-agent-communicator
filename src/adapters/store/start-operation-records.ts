import type { StartOperation, ValidatedStartArguments } from "../../domain/session-start";
import {
  hydrateStartOperation,
  type StartOperationRow,
  startOperationColumns,
} from "./start-operation-rows";
import type { StoreContext } from "./store-types";

interface PayloadRow {
  readonly initialMessage: string;
  readonly title: string | null;
  readonly agent: string | null;
  readonly model: string | null;
}

export class StartOperationRecords {
  constructor(private readonly context: StoreContext) {}

  select(operationId: string): StartOperation | undefined {
    const row = this.context.database
      .query<StartOperationRow, [string, string]>(
        `SELECT ${startOperationColumns} FROM start_operations WHERE workspace_key = ? AND id = ?`,
      )
      .get(this.context.workspaceKey, operationId);
    return row ? hydrateStartOperation(row) : undefined;
  }

  payload(operationId: string): ValidatedStartArguments | undefined {
    const row = this.context.database
      .query<PayloadRow, [string]>(
        `SELECT initial_message AS initialMessage, title, agent, model
         FROM start_operation_payloads WHERE operation_id = ?`,
      )
      .get(operationId);
    if (!row) return undefined;
    return {
      idempotencyKey: this.select(operationId)?.idempotencyKey ?? "",
      initialMessage: row.initialMessage,
      ...(row.title === null ? {} : { title: row.title }),
      ...(row.agent === null ? {} : { agent: row.agent }),
      ...(row.model === null ? {} : { model: row.model }),
    };
  }
}
