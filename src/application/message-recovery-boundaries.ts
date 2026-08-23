import { type DeliveryMetadata, isCoherentDeliveryMetadata } from "../domain/deliveries";
import { validateDeliveryId, validateNativeMessageId } from "../domain/generated-ids";
import { type FencingToken, validateFencingToken } from "../domain/ownership";
import { validateSessionId } from "../domain/sessions";
import { validateWorkspaceKey } from "../domain/workspaces";
import type {
  CurrentRootMembership,
  DeliveryStoreFailureCode,
  StartupRecoveryBarrier,
} from "./delivery-ports";
import { snapshotDataRecord } from "./strict-port-boundaries";

const baseKeys = [
  "id",
  "workspaceKey",
  "sourceSessionId",
  "targetSessionId",
  "nativeMessageId",
  "state",
  "contentByteLength",
  "contentSha256",
  "createdAtMs",
  "updatedAtMs",
] as const;

const stateKeys: Readonly<Record<DeliveryMetadata["state"], readonly string[]>> = {
  prepared: [],
  submitting: ["submittedAtMs"],
  admission_unknown: ["submittedAtMs", "admissionUnknownAtMs"],
  admitted: ["submittedAtMs", "admittedAtMs", "admissionEvidence"],
  promoted: ["submittedAtMs", "admittedAtMs", "promotedAtMs", "admissionEvidence"],
  failed: ["submittedAtMs", "failedAtMs"],
  cancelled: ["cancelledAtMs"],
};

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

export function inspectDeliveryMetadata(value: unknown): DeliveryMetadata | undefined {
  const record = snapshotDataRecord(value, 17);
  if (!record || typeof record.state !== "string" || !(record.state in stateKeys)) return undefined;
  const expected = [...baseKeys, ...stateKeys[record.state as DeliveryMetadata["state"]]];
  if (!exactKeys(record, expected)) return undefined;
  if (record.admissionEvidence !== undefined) {
    const evidence = snapshotDataRecord(record.admissionEvidence, 5);
    const evidenceKeys = evidence?.state === "promoted" ? 5 : 4;
    if (!evidence || Object.keys(evidence).length !== evidenceKeys) return undefined;
    record.admissionEvidence = evidence;
  }
  if (
    !validateDeliveryId(record.id).ok ||
    !validateWorkspaceKey(record.workspaceKey).ok ||
    !validateSessionId(record.sourceSessionId).ok ||
    !validateSessionId(record.targetSessionId).ok ||
    !validateNativeMessageId(record.nativeMessageId).ok ||
    typeof record.contentSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.contentSha256) ||
    !isCoherentDeliveryMetadata(record as unknown as DeliveryMetadata)
  ) {
    return undefined;
  }
  return Object.freeze(record) as unknown as DeliveryMetadata;
}

export function inspectMembership(value: unknown): CurrentRootMembership | undefined {
  const record = snapshotDataRecord(value, 3);
  if (
    !record ||
    !exactKeys(record, ["sourceTitle", "sourceVisible", "targetVisible"]) ||
    (record.sourceTitle !== undefined && typeof record.sourceTitle !== "string") ||
    typeof record.sourceVisible !== "boolean" ||
    typeof record.targetVisible !== "boolean"
  ) {
    return undefined;
  }
  return Object.freeze(record) as unknown as CurrentRootMembership;
}

export function inspectStartupBarrier(
  value: unknown,
  expectedToken: FencingToken,
): StartupRecoveryBarrier | undefined {
  const barrier = snapshotDataRecord(value, 2);
  return barrier &&
    exactKeys(barrier, ["established", "fencingToken"]) &&
    barrier.established === true &&
    validateFencingToken(barrier.fencingToken).ok &&
    barrier.fencingToken === expectedToken
    ? (value as StartupRecoveryBarrier)
    : undefined;
}

const storeCodes: readonly DeliveryStoreFailureCode[] = [
  "quota_exceeded",
  "rate_limited",
  "ownership_lost",
  "state_conflict",
  "storage_unavailable",
];

export function inspectDeliveryMutation(
  value: unknown,
):
  | Readonly<{ readonly ok: true; readonly delivery: DeliveryMetadata; readonly envelope?: string }>
  | Readonly<{ readonly ok: false; readonly code: DeliveryStoreFailureCode }>
  | undefined {
  const result = snapshotDataRecord(value, 3);
  if (!result) return undefined;
  if (result.ok === false) {
    return exactKeys(result, ["ok", "code"]) && storeCodes.includes(result.code as never)
      ? ({ ok: false, code: result.code } as never)
      : undefined;
  }
  const keys = Object.keys(result);
  const delivery = inspectDeliveryMetadata(result.delivery);
  if (
    result.ok !== true ||
    !delivery ||
    (keys.length !== 2 && keys.length !== 3) ||
    (keys.length === 3 && (keys[2] !== "envelope" || typeof result.envelope !== "string"))
  ) {
    return undefined;
  }
  return Object.freeze({
    ok: true,
    delivery,
    ...(typeof result.envelope === "string" ? { envelope: result.envelope } : {}),
  });
}
