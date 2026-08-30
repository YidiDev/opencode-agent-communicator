import type { CompleteSubmissionInput } from "../../application/delivery-ports";
import type { DeliveryMetadata } from "../../domain/deliveries";
import { OwnershipLostFault } from "../../domain/ownership";
import type { StoreContext } from "./store-types";
import { StoreIntegrityError } from "./store-types";

export function assertStaleDeliveryClassification(
  context: StoreContext,
  input: CompleteSubmissionInput,
): void {
  if (input.state !== "admission_unknown") {
    throw new OwnershipLostFault("Startup recovery permits only stale submission classification.");
  }
  const row = context.database
    .query<{ readonly claimedToken: number | null }, [string, string]>(
      `SELECT claimed_fencing_token AS claimedToken FROM deliveries
       WHERE workspace_key = ? AND id = ?`,
    )
    .get(input.workspaceKey, input.deliveryId);
  if (!row || row.claimedToken === null || row.claimedToken === input.fencingToken) {
    throw new OwnershipLostFault("Only a stale-token submission may cross the startup barrier.");
  }
}

export function isLegalDeliveryCompletion(
  from: DeliveryMetadata["state"],
  to: CompleteSubmissionInput["state"],
): boolean {
  if (from === "submitting")
    return ["failed", "admission_unknown", "admitted", "promoted"].includes(to);
  if (from === "admission_unknown") return ["failed", "admitted", "promoted"].includes(to);
  return from === "admitted" && to === "promoted";
}

export function writeDeliveryCompletion(
  context: StoreContext,
  input: CompleteSubmissionInput,
  expectedState: DeliveryMetadata["state"],
): void {
  let changes: number;
  if (!("evidenceObservedAtMs" in input)) {
    if (input.state === "failed") {
      changes = context.database.run(
        `UPDATE deliveries SET state = 'failed', updated_at_ms = ?, failed_at_ms = ?,
           admission_unknown_at_ms = NULL
         WHERE workspace_key = ? AND id = ? AND state = ?`,
        [input.nowMs, input.nowMs, input.workspaceKey, input.deliveryId, expectedState],
      ).changes;
    } else {
      changes = context.database.run(
        `UPDATE deliveries SET state = 'admission_unknown', updated_at_ms = ?,
           admission_unknown_at_ms = ? WHERE workspace_key = ? AND id = ? AND state = ?`,
        [input.nowMs, input.nowMs, input.workspaceKey, input.deliveryId, expectedState],
      ).changes;
    }
    if (changes !== 1) throw new StoreIntegrityError("The delivery completion CAS failed.");
    return;
  }
  const transitionAtMs = Math.max(input.nowMs, input.evidenceObservedAtMs);
  if (input.state === "admitted") {
    changes = context.database.run(
      `UPDATE deliveries SET state = 'admitted', updated_at_ms = ?, admitted_at_ms = ?,
         admission_evidence_kind = ?, admitted_seq = ?, evidence_observed_at_ms = ?,
         admission_unknown_at_ms = NULL
       WHERE workspace_key = ? AND id = ? AND state = ?`,
      [
        transitionAtMs,
        transitionAtMs,
        input.evidenceKind ?? "v2_queue",
        input.evidenceKind === "public_message" ? null : input.admittedSeq,
        input.evidenceObservedAtMs,
        input.workspaceKey,
        input.deliveryId,
        expectedState,
      ],
    ).changes;
    if (changes !== 1) throw new StoreIntegrityError("The delivery completion CAS failed.");
    return;
  }
  changes = context.database.run(
    `UPDATE deliveries SET state = 'promoted', updated_at_ms = ?,
       admitted_at_ms = CASE WHEN state = 'admitted' THEN admitted_at_ms ELSE ? END,
       promoted_at_ms = ?,
       admitted_seq = CASE WHEN state = 'admitted' THEN admitted_seq ELSE ? END,
       admission_evidence_kind = 'v2_queue', promoted_seq = ?, evidence_observed_at_ms = ?,
       admission_unknown_at_ms = NULL
     WHERE workspace_key = ? AND id = ? AND state = ?`,
    [
      transitionAtMs,
      transitionAtMs,
      transitionAtMs,
      input.admittedSeq,
      input.promotedSeq,
      input.evidenceObservedAtMs,
      input.workspaceKey,
      input.deliveryId,
      expectedState,
    ],
  ).changes;
  if (changes !== 1) throw new StoreIntegrityError("The delivery completion CAS failed.");
}
