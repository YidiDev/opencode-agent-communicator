import { validateNativeMessageId, validateStartOperationId } from "../../domain/generated-ids";
import type { Sha256Digest } from "../../domain/message-payload";
import {
  type StartOperation,
  validateStartAgent,
  validateStartModel,
} from "../../domain/session-start";
import { validateSessionId } from "../../domain/sessions";
import { validateWorkspaceKey } from "../../domain/workspaces";
import { StoreIntegrityError } from "./store-types";

export interface StartOperationRow {
  readonly id: unknown;
  readonly workspaceKey: unknown;
  readonly sourceSessionId: unknown;
  readonly idempotencyKey: unknown;
  readonly argumentsSha256: unknown;
  readonly sessionId: unknown;
  readonly nativeMessageId: unknown;
  readonly requestedAgent?: unknown;
  readonly requestedModel?: unknown;
  readonly titleRequested?: unknown;
  readonly terminalReason?: unknown;
  readonly creationState: unknown;
  readonly titleState: unknown;
  readonly admissionState: unknown;
  readonly createdAtMs: unknown;
  readonly updatedAtMs: unknown;
}

export const startOperationColumns = `id, workspace_key AS workspaceKey,
  source_session_id AS sourceSessionId, idempotency_key AS idempotencyKey,
  arguments_sha256 AS argumentsSha256, session_id AS sessionId,
  native_message_id AS nativeMessageId, requested_agent AS requestedAgent,
  requested_model AS requestedModel, title_requested AS titleRequested,
  terminal_reason AS terminalReason,
  CASE WHEN terminal_reason = 'request_terminal' THEN 'request_terminal'
    ELSE creation_state END AS creationState,
  title_state AS titleState, admission_state AS admissionState,
  created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs`;

const creationStates = new Set([
  "prepared",
  "submitting",
  "created",
  "failed",
  "policy_denied",
  "approval_rejected",
  "outcome_unknown",
  "request_terminal",
]);
const titleStates = new Set([
  "not_started",
  "prepared",
  "submitting",
  "updated",
  "failed",
  "outcome_unknown",
  "payload_unavailable",
  "skipped",
]);
const admissionStates = new Set([
  "not_started",
  "prepared",
  "submitting",
  "admitted",
  "admission_unknown",
  "payload_unavailable",
  "failed",
]);

export function hydrateStartOperation(row: StartOperationRow): StartOperation {
  const id = validateStartOperationId(row.id);
  const workspace = validateWorkspaceKey(row.workspaceKey);
  const source = validateSessionId(row.sourceSessionId);
  const session = validateSessionId(row.sessionId);
  const message = validateNativeMessageId(row.nativeMessageId);
  if (
    !id.ok ||
    !workspace.ok ||
    !source.ok ||
    !session.ok ||
    !message.ok ||
    (row.requestedAgent !== undefined &&
      row.requestedAgent !== null &&
      typeof row.requestedAgent !== "string") ||
    (row.requestedModel !== undefined &&
      row.requestedModel !== null &&
      typeof row.requestedModel !== "string") ||
    (typeof row.requestedAgent === "string" && !validateStartAgent(row.requestedAgent).ok) ||
    (typeof row.requestedModel === "string" && !validateStartModel(row.requestedModel).ok) ||
    (row.titleRequested !== undefined && row.titleRequested !== 0 && row.titleRequested !== 1) ||
    (row.terminalReason !== null &&
      row.terminalReason !== undefined &&
      row.terminalReason !== "request_terminal") ||
    (row.terminalReason === "request_terminal" && row.creationState !== "request_terminal") ||
    typeof row.idempotencyKey !== "string" ||
    typeof row.argumentsSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.argumentsSha256) ||
    typeof row.creationState !== "string" ||
    !creationStates.has(row.creationState) ||
    typeof row.titleState !== "string" ||
    !titleStates.has(row.titleState) ||
    typeof row.admissionState !== "string" ||
    !admissionStates.has(row.admissionState) ||
    !Number.isSafeInteger(row.createdAtMs) ||
    !Number.isSafeInteger(row.updatedAtMs)
  ) {
    throw new StoreIntegrityError("Persisted start operation metadata is malformed.");
  }
  return {
    id: id.value,
    workspaceKey: workspace.value,
    sourceSessionId: source.value,
    idempotencyKey: row.idempotencyKey,
    argumentsSha256: row.argumentsSha256 as Sha256Digest,
    sessionId: session.value,
    nativeMessageId: message.value,
    ...(row.requestedAgent == null ? {} : { requestedAgent: row.requestedAgent as string }),
    ...(row.requestedModel == null ? {} : { requestedModel: row.requestedModel as string }),
    ...(row.titleRequested === undefined ? {} : { titleRequested: row.titleRequested === 1 }),
    creationState: row.creationState as StartOperation["creationState"],
    titleState: row.titleState as StartOperation["titleState"],
    admissionState: row.admissionState as StartOperation["admissionState"],
    createdAtMs: row.createdAtMs as number,
    updatedAtMs: row.updatedAtMs as number,
  };
}
