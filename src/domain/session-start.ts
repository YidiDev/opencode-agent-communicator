import {
  type NativeMessageId,
  type StartOperationId,
  validateNativeMessageId,
  validateStartOperationId,
} from "./generated-ids";
import type { Sha256Digest, Sha256DigestPort } from "./message-payload";
import type { SessionId } from "./sessions";
import { validateSessionId } from "./sessions";
import type { WorkspaceKey } from "./workspaces";
import { validateWorkspaceKey } from "./workspaces";

export type StartCreationState =
  | "prepared"
  | "submitting"
  | "created"
  | "failed"
  | "policy_denied"
  | "approval_rejected"
  | "outcome_unknown";
export type StartTitleState =
  | "not_started"
  | "prepared"
  | "submitting"
  | "updated"
  | "failed"
  | "outcome_unknown"
  | "payload_unavailable"
  | "skipped";
export type StartAdmissionState =
  | "not_started"
  | "prepared"
  | "submitting"
  | "admitted"
  | "admission_unknown"
  | "payload_unavailable"
  | "failed";

export interface StartOperation {
  readonly id: StartOperationId;
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly idempotencyKey: string;
  readonly argumentsSha256: Sha256Digest;
  readonly sessionId: SessionId;
  readonly nativeMessageId: NativeMessageId;
  /** Non-message identity retained so an erased private payload cannot cause unsafe adoption. */
  readonly requestedAgent?: string;
  readonly requestedModel?: string;
  readonly titleRequested?: boolean;
  readonly creationState: StartCreationState;
  readonly titleState: StartTitleState;
  readonly admissionState: StartAdmissionState;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ValidatedStartArguments {
  readonly idempotencyKey: string;
  readonly initialMessage: string;
  readonly title?: string;
  readonly agent?: string;
  readonly model?: string;
}

export const sessionStartValidationPolicy = Object.freeze({
  idempotencyKeyCharacters: 128,
  initialMessageBytes: 32 * 1024,
  titleBytes: 512,
  overrideCharacters: 128,
  idempotencyKeyPattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  overridePattern: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/,
});

type Validation<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly message: string };

function boundedUtf8(value: unknown, label: string, maximum: number): Validation<string> {
  if (typeof value !== "string") return { ok: false, message: `${label} must be a string.` };
  const bytes = new TextEncoder().encode(value).length;
  if (bytes < 1 || bytes > maximum) {
    return { ok: false, message: `${label} must be between 1 and ${maximum} UTF-8 bytes.` };
  }
  return { ok: true, value };
}

export function validateStartIdempotencyKey(value: unknown): Validation<string> {
  return typeof value === "string" && sessionStartValidationPolicy.idempotencyKeyPattern.test(value)
    ? { ok: true, value }
    : { ok: false, message: "idempotency_key is malformed." };
}

export function validateStartInitialMessage(value: unknown): Validation<string> {
  return boundedUtf8(value, "initial_message", sessionStartValidationPolicy.initialMessageBytes);
}

export function validateStartTitle(value: unknown): Validation<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return boundedUtf8(value, "title", sessionStartValidationPolicy.titleBytes);
}

function validateOverride(
  value: unknown,
  label: "agent" | "model",
): Validation<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return typeof value === "string" && sessionStartValidationPolicy.overridePattern.test(value)
    ? { ok: true, value }
    : { ok: false, message: `${label} is malformed.` };
}

export const validateStartAgent = (value: unknown): Validation<string | undefined> =>
  validateOverride(value, "agent");
export const validateStartModel = (value: unknown): Validation<string | undefined> =>
  validateOverride(value, "model");

export function canonicalStartArguments(arguments_: ValidatedStartArguments): Uint8Array {
  const canonical = JSON.stringify({
    domain: "opencode-session-communicator/session_start/arguments/v1",
    idempotency_key: arguments_.idempotencyKey,
    initial_message: arguments_.initialMessage,
    title: arguments_.title ?? null,
    agent: arguments_.agent ?? null,
    model: arguments_.model ?? null,
  });
  return new TextEncoder().encode(canonical);
}

export async function digestStartArguments(
  digest: Sha256DigestPort,
  arguments_: ValidatedStartArguments,
): Promise<Sha256Digest> {
  const bytes = await digest.sha256(canonicalStartArguments(arguments_));
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new Error("The SHA-256 port violated its 32-byte output contract.");
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("") as Sha256Digest;
}

export function isCoherentStartOperation(value: unknown): value is StartOperation {
  if (!isRecord(value)) return false;
  const candidate = value;
  return (
    validateStartOperationId(candidate.id).ok &&
    validateNativeMessageId(candidate.nativeMessageId).ok &&
    validateWorkspaceKey(candidate.workspaceKey).ok &&
    validateSessionId(candidate.sourceSessionId).ok &&
    validateSessionId(candidate.sessionId).ok &&
    typeof candidate.idempotencyKey === "string" &&
    typeof candidate.argumentsSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.argumentsSha256) &&
    typeof candidate.creationState === "string" &&
    [
      "prepared",
      "submitting",
      "created",
      "failed",
      "policy_denied",
      "approval_rejected",
      "outcome_unknown",
    ].includes(candidate.creationState) &&
    typeof candidate.titleState === "string" &&
    [
      "not_started",
      "prepared",
      "submitting",
      "updated",
      "failed",
      "outcome_unknown",
      "payload_unavailable",
      "skipped",
    ].includes(candidate.titleState) &&
    typeof candidate.admissionState === "string" &&
    [
      "not_started",
      "prepared",
      "submitting",
      "admitted",
      "admission_unknown",
      "payload_unavailable",
      "failed",
    ].includes(candidate.admissionState) &&
    (candidate.requestedAgent === undefined || validateStartAgent(candidate.requestedAgent).ok) &&
    (candidate.requestedModel === undefined || validateStartModel(candidate.requestedModel).ok) &&
    (candidate.titleRequested === undefined || typeof candidate.titleRequested === "boolean") &&
    Number.isSafeInteger(candidate.createdAtMs) &&
    Number.isSafeInteger(candidate.updatedAtMs)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
