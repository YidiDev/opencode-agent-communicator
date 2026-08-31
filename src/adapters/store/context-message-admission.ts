import type { ContextAdmissionPersistencePort } from "../../application/context-admission-ports";
import type { DeliveryStoreFailureCode } from "../../application/delivery-ports";
import { checkDeliveryCreateQuotas, recordDeliveryRateEvent } from "./delivery-quotas";
import type { StoreContext } from "./store-types";

type ContextMessageInput = Parameters<ContextAdmissionPersistencePort["createContextMessage"]>[0];

export function checkContextMessageCreateQuotas(
  context: StoreContext,
  input: ContextMessageInput,
  nowMs: number,
): Extract<DeliveryStoreFailureCode, "quota_exceeded" | "rate_limited"> | undefined {
  context.database.run(
    `DELETE FROM context_admissions WHERE id IN (
       SELECT id FROM context_admissions WHERE workspace_key = ? AND kind = 'message'
         AND state IN ('context_admitted','failed','cancelled') AND updated_at_ms < ?
       ORDER BY updated_at_ms, id LIMIT 100
     )`,
    [input.workspaceKey, Math.max(0, nowMs - 86_400_000)],
  );
  return checkDeliveryCreateQuotas(
    context,
    {
      workspaceKey: input.workspaceKey,
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      nowMs,
    },
    input.contentByteLength,
  );
}

export function recordContextMessageRateEvent(
  context: StoreContext,
  input: ContextMessageInput,
  nowMs: number,
): void {
  recordDeliveryRateEvent(context, {
    workspaceKey: input.workspaceKey,
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.targetSessionId,
    nowMs,
  });
}
