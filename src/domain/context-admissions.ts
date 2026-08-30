import type { DeliveryId, RequestId } from "./generated-ids";
import { validateDeliveryId, validateRequestId } from "./generated-ids";
import type { FencingToken } from "./ownership";
import { type SessionId, validateSessionId } from "./sessions";
import { validateWorkspaceKey, type WorkspaceKey } from "./workspaces";

export const contextAdmissionKinds = ["message", "request"] as const;
export type ContextAdmissionKind = (typeof contextAdmissionKinds)[number];

export const contextEnvelopeMaximumBytes = 65_536;

export const contextAdmissionStates = [
  "prepared",
  "awaiting_context",
  "context_admitted",
  "failed",
  "cancelled",
] as const;
export type ContextAdmissionState = (typeof contextAdmissionStates)[number];
export type ContextAdmissionId = DeliveryId | RequestId;

export interface ContextAdmissionMetadata {
  readonly id: ContextAdmissionId;
  readonly kind: ContextAdmissionKind;
  readonly workspaceKey: WorkspaceKey;
  readonly sourceSessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly state: ContextAdmissionState;
  readonly contentByteLength: number;
  readonly contentSha256: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly awaitingContextAtMs?: number;
  readonly contextAdmittedAtMs?: number;
  readonly failedAtMs?: number;
  readonly cancelledAtMs?: number;
  readonly claimedFencingToken?: FencingToken;
}

const transitions: Readonly<Record<ContextAdmissionState, readonly ContextAdmissionState[]>> = {
  prepared: ["awaiting_context", "failed", "cancelled"],
  awaiting_context: ["context_admitted", "failed", "cancelled"],
  context_admitted: [],
  failed: [],
  cancelled: [],
};

export function canTransitionContextAdmission(
  from: ContextAdmissionState,
  to: ContextAdmissionState,
): boolean {
  return transitions[from].includes(to);
}

function safeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function coherentIdentity(item: Record<string, unknown>): boolean {
  if (!contextAdmissionKinds.includes(item.kind as ContextAdmissionKind)) return false;
  if (!contextAdmissionStates.includes(item.state as ContextAdmissionState)) return false;
  const idValid =
    item.kind === "message" ? validateDeliveryId(item.id).ok : validateRequestId(item.id).ok;
  return !(
    !idValid ||
    !validateWorkspaceKey(item.workspaceKey).ok ||
    !validateSessionId(item.sourceSessionId).ok ||
    !validateSessionId(item.targetSessionId).ok ||
    item.sourceSessionId === item.targetSessionId ||
    !Number.isSafeInteger(item.contentByteLength) ||
    (item.contentByteLength as number) < 1 ||
    (item.contentByteLength as number) > contextEnvelopeMaximumBytes ||
    typeof item.contentSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(item.contentSha256) ||
    !safeTime(item.createdAtMs) ||
    !safeTime(item.updatedAtMs) ||
    item.updatedAtMs < item.createdAtMs
  );
}

function coherentStateTimes(item: Record<string, unknown>): boolean {
  const createdAtMs = item.createdAtMs as number;
  const updatedAtMs = item.updatedAtMs as number;
  const at = (field: string): boolean =>
    safeTime(item[field]) && item[field] >= createdAtMs && item[field] <= updatedAtMs;
  const hasAwaiting = Object.hasOwn(item, "awaitingContextAtMs");
  if (item.state === "prepared" && hasAwaiting) return false;
  if ((item.state === "awaiting_context" || item.state === "context_admitted") && !hasAwaiting)
    return false;
  if (hasAwaiting && !at("awaitingContextAtMs")) return false;
  if ((item.state === "context_admitted") !== Object.hasOwn(item, "contextAdmittedAtMs"))
    return false;
  if (item.state === "context_admitted" && !at("contextAdmittedAtMs")) return false;
  if (!coherentTerminalTimes(item, at)) return false;
  const terminalAt = (item.failedAtMs ?? item.cancelledAtMs) as number | undefined;
  if (
    hasAwaiting &&
    terminalAt !== undefined &&
    terminalAt < (item.awaitingContextAtMs as number)
  ) {
    return false;
  }
  return (
    (item.state === "context_admitted") === Object.hasOwn(item, "claimedFencingToken") &&
    (!Object.hasOwn(item, "claimedFencingToken") ||
      (Number.isSafeInteger(item.claimedFencingToken) && (item.claimedFencingToken as number) >= 1))
  );
}

function coherentTerminalTimes(
  item: Record<string, unknown>,
  at: (field: string) => boolean,
): boolean {
  if ((item.state === "failed") !== Object.hasOwn(item, "failedAtMs")) return false;
  if (item.state === "failed" && !at("failedAtMs")) return false;
  if ((item.state === "cancelled") !== Object.hasOwn(item, "cancelledAtMs")) return false;
  return item.state !== "cancelled" || at("cancelledAtMs");
}

export function isCoherentContextAdmission(value: unknown): value is ContextAdmissionMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return coherentIdentity(item) && coherentStateTimes(item);
}
