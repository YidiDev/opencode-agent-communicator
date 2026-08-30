import { digestMessageContent, type Sha256DigestPort } from "../domain/message-payload";
import { type DomainResult, domainFailure } from "../domain/results";
import type { ProjectionSafeMessage, RenderedProjectionLine } from "../domain/session-read";
import type { SessionReadCursorBoundary } from "../domain/session-read-cursor";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { SessionReadPresence } from "./delivery-ports";
import {
  type SessionReadCallScope,
  type SplitProjection,
  snapshotNativeFixedMessage,
  splitProjectedAnchor,
} from "./session-read-pagination";
import type { NativeSessionReadPort } from "./session-read-ports";
import type { SessionReadWorkBudget } from "./session-read-work";

export interface ValidatedSessionReadAnchor {
  readonly message: ProjectionSafeMessage;
  readonly split: SplitProjection;
  readonly projectedTextByteCount: number;
  readonly lines: readonly RenderedProjectionLine[];
}

/** Reads one presence-guarded fixed anchor and validates its canonical prefix. */
export async function readValidatedSessionReadAnchor(input: {
  readonly scope: SessionReadCallScope;
  readonly native: NativeSessionReadPort;
  readonly digest: Sha256DigestPort;
  readonly workspace: WorkspaceKey;
  readonly target: SessionId;
  readonly boundary: SessionReadCursorBoundary;
  readonly effectGuard: () => Promise<DomainResult<SessionReadPresence>>;
  readonly work: SessionReadWorkBudget;
  readonly replaceProjection?: boolean;
}): Promise<DomainResult<ValidatedSessionReadAnchor>> {
  const guarded = await input.effectGuard();
  if (!guarded.ok) return guarded;
  if (!input.work.chargeNativeCall()) {
    return domainFailure("native_unavailable", "Transcript read exceeds its work budget.", true);
  }
  const fixedCall = await input.scope.run(() =>
    input.native.readMessage({
      workspaceKey: input.workspace,
      sessionId: input.target,
      messageId: input.boundary.messageId,
      abort: input.scope.signal,
    }),
  );
  if (fixedCall.kind === "expired") {
    return domainFailure("deadline_expired", "Session read deadline expired.", false);
  }
  if (fixedCall.kind === "rejected") {
    return domainFailure("native_unavailable", "Transcript read is unavailable.", true);
  }
  const fixed = snapshotNativeFixedMessage(fixedCall.value, input.boundary.messageId);
  if (!fixed) return domainFailure("native_unavailable", "Transcript read is malformed.", true);
  if (fixed.kind === "not_found") {
    return domainFailure("cursor_stale", "Session read cursor anchor is stale.", false);
  }
  if (
    !input.work.chargeRaw({
      messages: 1,
      projectedTextBytes: fixed.projectedTextByteCount,
      parts: fixed.examinedPartCount,
    })
  ) {
    return domainFailure("native_unavailable", "Transcript read exceeds its work budget.", true);
  }
  const projected = input.work.project(fixed.message, input.replaceProjection);
  if (!projected.ok) {
    return domainFailure("native_unavailable", "Transcript projection is unavailable.", true);
  }
  const split = splitProjectedAnchor(fixed.message, projected.lines, input.boundary);
  if (!split) return domainFailure("cursor_stale", "Session read cursor anchor is stale.", false);
  const prefix = await input.scope.run(() =>
    digestMessageContent(input.digest, split.canonicalPrefix),
  );
  if (prefix.kind === "expired") {
    return domainFailure("deadline_expired", "Session read deadline expired.", false);
  }
  if (prefix.kind === "rejected") {
    return domainFailure("native_unavailable", "Session read digest is unavailable.", true);
  }
  if (prefix.value !== input.boundary.prefixSha256) {
    return domainFailure("cursor_stale", "Session read cursor anchor changed.", false);
  }
  return {
    ok: true,
    value: {
      message: fixed.message,
      split,
      projectedTextByteCount: fixed.projectedTextByteCount,
      lines: projected.lines,
    },
  };
}
