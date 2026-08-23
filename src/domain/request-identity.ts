import type { RequestMetadata } from "./request-types";

export type RequestIdentitySnapshot = Readonly<{
  readonly id: RequestMetadata["id"];
  readonly workspaceKey: RequestMetadata["workspaceKey"];
  readonly sourceSessionId: RequestMetadata["sourceSessionId"];
  readonly targetSessionId: RequestMetadata["targetSessionId"];
  readonly nativeMessageId: RequestMetadata["nativeMessageId"];
  readonly kind: RequestMetadata["kind"];
  readonly createdAtMs: number;
  readonly deadlineAtMs: number;
  readonly payloadByteLength: number;
  readonly payloadSha256?: string;
}>;

export function snapshotRequestIdentity(request: RequestMetadata): RequestIdentitySnapshot {
  return Object.freeze({
    id: request.id,
    workspaceKey: request.workspaceKey,
    sourceSessionId: request.sourceSessionId,
    targetSessionId: request.targetSessionId,
    nativeMessageId: request.nativeMessageId,
    kind: request.kind,
    createdAtMs: request.createdAtMs,
    deadlineAtMs: request.deadlineAtMs,
    payloadByteLength: request.payloadByteLength,
    ...(request.resolutionState === "pending" ? { payloadSha256: request.payloadSha256 } : {}),
  });
}

/** Digest erasure is legal only when the compared transition has terminalized the request. */
export function hasRequestIdentity(
  before: RequestIdentitySnapshot,
  after: RequestMetadata,
): boolean {
  const core =
    before.id === after.id &&
    before.workspaceKey === after.workspaceKey &&
    before.sourceSessionId === after.sourceSessionId &&
    before.targetSessionId === after.targetSessionId &&
    before.nativeMessageId === after.nativeMessageId &&
    before.kind === after.kind &&
    before.createdAtMs === after.createdAtMs &&
    before.deadlineAtMs === after.deadlineAtMs &&
    before.payloadByteLength === after.payloadByteLength;
  if (!core || before.payloadSha256 === undefined) return core;
  return after.resolutionState === "pending"
    ? after.payloadSha256 === before.payloadSha256
    : !Object.hasOwn(after, "payloadSha256");
}
