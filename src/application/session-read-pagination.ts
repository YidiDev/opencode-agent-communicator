import type { Sha256Digest, Sha256DigestPort } from "../domain/message-payload";
import { digestMessageContent } from "../domain/message-payload";
import { type DomainResult, domainFailure } from "../domain/results";
import {
  type ProjectionSafeMessage,
  type RenderedLinePosition,
  type RenderedProjectionLine,
  sessionReadLimits,
} from "../domain/session-read";
import {
  encodeSessionReadCursor,
  type SessionReadCursorBoundary,
} from "../domain/session-read-cursor";
import { projectSessionMessage } from "../domain/session-read-projection";
import type { SessionId } from "../domain/sessions";
import type { WorkspaceKey } from "../domain/workspaces";
import type { SessionReadPresence } from "./delivery-ports";
import { snapshotNativeMessagePage } from "./session-read-boundaries";

export {
  sessionReadVisibilityFailure,
  snapshotNativeFixedMessage,
  snapshotSessionReadPresence,
} from "./session-read-boundaries";

import type { SessionReadMode, SessionReadPorts } from "./session-read-ports";
import type { SessionReadWorkBudget } from "./session-read-work";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const emptySessionReadPosition: RenderedLinePosition = Object.freeze({
  messageId: "$empty",
  itemKey: "$empty",
  utf8ByteOffset: 0,
});

function sameItem(line: RenderedProjectionLine, boundary: RenderedLinePosition): boolean {
  return line.start.messageId === boundary.messageId && line.start.itemKey === boundary.itemKey;
}

function prefixText(line: RenderedProjectionLine, offset: number): string | undefined {
  const bytes = encoder.encode(line.text);
  const relative = offset - line.start.utf8ByteOffset;
  if (relative < 0 || relative > line.end.utf8ByteOffset - line.start.utf8ByteOffset)
    return undefined;
  if (relative >= bytes.length) return line.text;
  try {
    return decoder.decode(bytes.slice(0, relative));
  } catch {
    return undefined;
  }
}

function suffixText(line: RenderedProjectionLine, offset: number): string | undefined {
  const bytes = encoder.encode(line.text);
  const relative = offset - line.start.utf8ByteOffset;
  if (relative < 0 || relative > line.end.utf8ByteOffset - line.start.utf8ByteOffset)
    return undefined;
  if (relative >= bytes.length) return "";
  try {
    return decoder.decode(bytes.slice(relative));
  } catch {
    return undefined;
  }
}

export interface SplitProjection {
  readonly before: readonly RenderedProjectionLine[];
  readonly after: readonly RenderedProjectionLine[];
  readonly canonicalPrefix: Uint8Array;
}

/** Locates a cursor in one freshly projected anchor and splits an append-only text line safely. */
export function splitAnchorProjection(
  message: ProjectionSafeMessage,
  boundary: SessionReadCursorBoundary,
): SplitProjection | undefined {
  const projected = projectSessionMessage(message);
  if (!projected.ok || message.messageId !== boundary.messageId) return undefined;
  return splitProjectedAnchor(message, projected.lines, boundary);
}

export function splitProjectedAnchor(
  message: ProjectionSafeMessage,
  lines: readonly RenderedProjectionLine[],
  boundary: SessionReadCursorBoundary,
): SplitProjection | undefined {
  if (message.messageId !== boundary.messageId) return undefined;
  const matching = lines.filter((line) => sameItem(line, boundary));
  if (matching.length === 0) return undefined;
  const maximum = Math.max(...matching.map((line) => line.end.utf8ByteOffset));
  if (boundary.utf8ByteOffset > maximum) return undefined;

  let splitIndex = -1;
  let prefix = "";
  let suffix = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || !sameItem(line, boundary)) continue;
    if (
      boundary.utf8ByteOffset >= line.start.utf8ByteOffset &&
      boundary.utf8ByteOffset <= line.end.utf8ByteOffset
    ) {
      const candidatePrefix = prefixText(line, boundary.utf8ByteOffset);
      const candidateSuffix = suffixText(line, boundary.utf8ByteOffset);
      if (candidatePrefix === undefined || candidateSuffix === undefined) return undefined;
      splitIndex = index;
      prefix = candidatePrefix;
      suffix = candidateSuffix;
      // A shared wrapped-line boundary means “after the preceding line”, never
      // the empty prefix of the following wrapped line.
      break;
    }
  }
  if (splitIndex < 0) return undefined;
  const line = lines[splitIndex];
  if (!line) return undefined;
  const before = [...lines.slice(0, splitIndex)];
  if (prefix.length > 0 || boundary.utf8ByteOffset === line.end.utf8ByteOffset) {
    before.push({ ...line, text: prefix, end: { ...boundary } });
  }
  const after: RenderedProjectionLine[] = [];
  if (suffix.length > 0) after.push({ ...line, text: suffix, start: { ...boundary } });
  after.push(...lines.slice(splitIndex + 1));
  const canonicalBefore = [
    ...lines.slice(0, splitIndex),
    { ...line, text: prefix, end: { ...boundary } },
  ];
  const canonical = JSON.stringify(
    canonicalBefore.map((entry) => [
      entry.start.messageId,
      entry.start.itemKey,
      entry.start.utf8ByteOffset,
      entry.end.utf8ByteOffset,
      entry.text,
    ]),
  );
  return { before, after, canonicalPrefix: encoder.encode(`session-read-prefix-v1\0${canonical}`) };
}

export async function emptyBoundaryDigest(digest: Sha256DigestPort): Promise<Sha256Digest> {
  return digestMessageContent(digest, encoder.encode("session-read-empty-v1"));
}

export async function boundaryDigest(
  digest: Sha256DigestPort,
  message: ProjectionSafeMessage,
  position: RenderedLinePosition,
  projectedLines?: readonly RenderedProjectionLine[],
): Promise<Sha256Digest | undefined> {
  const boundary = { ...position, prefixSha256: "0".repeat(64) as Sha256Digest };
  const split = projectedLines
    ? splitProjectedAnchor(message, projectedLines, boundary)
    : splitAnchorProjection(message, boundary);
  return split ? digestMessageContent(digest, split.canonicalPrefix) : undefined;
}

export async function encodeSessionReadBoundary(
  digest: Sha256DigestPort,
  workspaceDigest: Sha256Digest,
  target: SessionId,
  messages: ReadonlyMap<string, ProjectionSafeMessage>,
  position: RenderedLinePosition,
  linesByMessage?: ReadonlyMap<string, readonly RenderedProjectionLine[]>,
): Promise<string | undefined> {
  const prefixSha256 =
    position.messageId === emptySessionReadPosition.messageId
      ? await emptyBoundaryDigest(digest)
      : await boundaryDigest(
          digest,
          messages.get(position.messageId) as ProjectionSafeMessage,
          position,
          linesByMessage?.get(position.messageId),
        );
  return prefixSha256
    ? encodeSessionReadCursor(workspaceDigest, target, { ...position, prefixSha256 })
    : undefined;
}

export function hasPackingLookahead(
  lines: readonly RenderedProjectionLine[],
  requestedLines: number,
  fromEnd: boolean,
): boolean {
  if (
    lines.length > sessionReadLimits.maxLines + 1 &&
    requestedLines === sessionReadLimits.maxLines
  )
    return true;
  let bytes = 0;
  let count = 0;
  const ordered = fromEnd ? [...lines].reverse() : lines;
  for (const line of ordered) {
    const lineBytes = encoder.encode(line.text).length + (count === 0 ? 0 : 1);
    if (count >= requestedLines || bytes + lineBytes > sessionReadLimits.maxContentBytes)
      return true;
    count += 1;
    bytes += lineBytes;
  }
  return false;
}

export type SessionReadSettlement<Value> =
  | { readonly kind: "value"; readonly value: Value }
  | { readonly kind: "expired" }
  | { readonly kind: "rejected" };

export interface SessionReadCallScope {
  readonly signal: AbortSignal;
  run<Value>(operation: () => Promise<Value>): Promise<SessionReadSettlement<Value>>;
}

function unavailable(message: string): DomainResult<never> {
  return domainFailure("native_unavailable", message, true);
}

export interface SessionReadTraversalPlan {
  readonly workspace: WorkspaceKey;
  readonly target: SessionId;
  readonly mode: SessionReadMode;
  readonly limit: number;
}

export interface SessionReadTraversal {
  readonly messages: readonly ProjectionSafeMessage[];
  readonly reachedOldest: boolean;
  readonly anchorIndex: number;
  readonly linesByMessage: ReadonlyMap<string, readonly RenderedProjectionLine[]>;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one bounded cursor walk keeps call, message, lookahead, and anchor proof budgets adjacent.
export async function traverseSessionRead(
  scope: SessionReadCallScope,
  native: SessionReadPorts["native"],
  read: SessionReadTraversalPlan,
  anchor: ProjectionSafeMessage | undefined,
  anchorBefore: readonly RenderedProjectionLine[],
  work: SessionReadWorkBudget,
  effectGuard: () => Promise<DomainResult<SessionReadPresence>>,
): Promise<DomainResult<SessionReadTraversal>> {
  let cursor: string | null = null;
  let reachedOldest = false;
  let anchorSeen = anchor === undefined;
  const descending: ProjectionSafeMessage[] = [];
  const rawIds = new Set<string>();
  const nativeCursors = new Set<string>();
  const linesFor = (
    messages: readonly ProjectionSafeMessage[],
  ): readonly RenderedProjectionLine[] =>
    messages.flatMap((message) => [...(work.linesByMessage.get(message.messageId) ?? [])]);
  while (true) {
    if (!work.canExamineAnotherMessage())
      return unavailable("Transcript traversal could not be proven within bounds.");
    if (!work.chargeNativeCall())
      return unavailable("Transcript traversal could not be proven within bounds.");
    const maximumResponseBytes = Math.min(
      sessionReadLimits.maxNativeResponseBytes,
      work.remainingRawResponseBytes(),
    );
    if (maximumResponseBytes < 1)
      return unavailable("Transcript traversal could not be proven within bounds.");
    const guarded = await effectGuard();
    if (!guarded.ok) return guarded;
    const settled = await scope.run(() =>
      cursor === null
        ? native.readMessagePage({
            workspaceKey: read.workspace,
            sessionId: read.target,
            order: "desc",
            maximumResponseBytes,
            abort: scope.signal,
          })
        : native.readMessagePage({
            workspaceKey: read.workspace,
            sessionId: read.target,
            cursor,
            maximumResponseBytes,
            abort: scope.signal,
          }),
    );
    if (settled.kind === "expired")
      return domainFailure("deadline_expired", "Session read deadline expired.", false);
    if (settled.kind === "rejected") return unavailable("Transcript read is unavailable.");
    const page = snapshotNativeMessagePage(
      settled.value,
      sessionReadLimits.maxProjectedTextBytesExamined,
      maximumResponseBytes,
    );
    if (
      !page ||
      !work.chargeRaw({
        messages: page.examinedMessageCount,
        projectedTextBytes: page.projectedTextByteCount,
        rawResponseBytes: page.rawResponseByteCount,
        parts: page.examinedPartCount,
      })
    )
      return unavailable("Transcript pagination is malformed.");
    for (const messageId of page.examinedMessageIds) {
      if (rawIds.has(messageId)) return unavailable("Transcript pagination is ambiguous.");
      rawIds.add(messageId);
    }
    for (const message of page.messages) {
      if (scope.signal.aborted)
        return domainFailure("deadline_expired", "Session read deadline expired.", false);
      if (anchor && message.messageId === anchor.messageId) anchorSeen = true;
      const projected = work.project(message);
      if (!projected.ok) return unavailable("Transcript projection is unavailable.");
      descending.push(message);
    }
    reachedOldest = page.nextCursor === null;
    const chronological = [...descending].reverse();
    const lines = linesFor(chronological);
    if (read.mode === "tail" && hasPackingLookahead(lines, read.limit, true)) break;
    if (anchorSeen && anchor) {
      const index = chronological.findIndex((message) => message.messageId === anchor.messageId);
      const before = index < 0 ? [] : [...linesFor(chronological.slice(0, index)), ...anchorBefore];
      if (read.mode === "before" && hasPackingLookahead(before, read.limit, true)) break;
      if (read.mode === "after" && before.length > 0) break;
    }
    if (reachedOldest) break;
    const next = page.nextCursor;
    if (!next || nativeCursors.has(next)) return unavailable("Transcript pagination is ambiguous.");
    nativeCursors.add(next);
    cursor = next;
  }
  const messages = [...descending].reverse();
  const anchorIndex = anchor
    ? messages.findIndex((message) => message.messageId === anchor.messageId)
    : -1;
  const before =
    anchorIndex < 0 ? [] : [...linesFor(messages.slice(0, anchorIndex)), ...anchorBefore];
  const enough =
    (read.mode === "tail" && hasPackingLookahead(linesFor(messages), read.limit, true)) ||
    (read.mode === "before" && anchorIndex >= 0 && hasPackingLookahead(before, read.limit, true)) ||
    (read.mode === "after" && anchorIndex >= 0 && before.length > 0);
  if (!reachedOldest && !enough)
    return unavailable("Transcript traversal could not be proven within bounds.");
  if (anchor && anchorIndex < 0) {
    return reachedOldest
      ? domainFailure("cursor_stale", "Session read cursor anchor is stale.", false)
      : unavailable("Transcript traversal could not be proven within bounds.");
  }
  return {
    ok: true,
    value: { messages, reachedOldest, anchorIndex, linesByMessage: work.linesByMessage },
  };
}
