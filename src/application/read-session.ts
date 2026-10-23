import { digestMessageContent, type Sha256Digest } from "../domain/message-payload";
import { type DomainResult, domainFailure } from "../domain/results";
import {
  type ProjectionSafeMessage,
  type RenderedProjectionLine,
  type SessionReadDirection,
  type SessionReadValue,
  sessionReadLimits,
  sessionReadProjectionVersion,
} from "../domain/session-read";
import {
  decodeSessionReadCursor,
  type SessionReadCursorBoundary,
} from "../domain/session-read-cursor";
import { packProjectionLines } from "../domain/session-read-projection";
import { type SessionId, validateSessionId } from "../domain/sessions";
import { validateWorkspaceKey, type WorkspaceKey } from "../domain/workspaces";
import { assertCommunicatorReady } from "./communicator-readiness-port";
import type { SessionReadPresence } from "./delivery-ports";
import { readValidatedSessionReadAnchor } from "./session-read-anchor";
import {
  emptyBoundaryDigest,
  emptySessionReadPosition,
  encodeSessionReadBoundary,
  type SessionReadTraversal,
  type SplitProjection,
  traverseSessionRead,
} from "./session-read-pagination";
import type {
  SessionReadApprovalBinding,
  SessionReadMode,
  SessionReadPorts,
  SessionReadTimerHandle,
} from "./session-read-ports";
import { observeSessionReadPresence } from "./session-read-presence";
import { SessionReadWorkBudget } from "./session-read-work";
import { snapshotDataRecord } from "./strict-port-boundaries";

const encoder = new TextEncoder();
const CURSOR_KEYS = new Set(["sessionId", "cursor", "direction", "limit"]);

function appendCachedLines(
  output: RenderedProjectionLine[],
  messages: readonly ProjectionSafeMessage[],
  cache: ReadonlyMap<string, readonly RenderedProjectionLine[]>,
): boolean {
  for (const message of messages) {
    const lines = cache.get(message.messageId);
    if (!lines) return false;
    output.push(...lines);
  }
  return true;
}

export interface SessionReadArguments {
  readonly sessionId: unknown;
  readonly cursor?: unknown;
  readonly direction?: unknown;
  readonly limit?: unknown;
}

export interface SessionReadContext {
  readonly workspaceKey: unknown;
  readonly sourceSessionId: unknown;
  readonly abort: AbortSignal;
  readonly deadlineMs: number;
}

interface ParsedRead {
  readonly target: SessionId;
  readonly cursor?: string;
  readonly direction?: SessionReadDirection;
  readonly mode: SessionReadMode;
  readonly limit: number;
  readonly workspace: WorkspaceKey;
  readonly source: SessionId;
}

type Settled<Value> =
  | { readonly kind: "value"; readonly value: Value }
  | { readonly kind: "expired" }
  | { readonly kind: "rejected" };

class ReadDeadlineScope {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly expired: Promise<{ readonly kind: "expired" }>;
  private timer: SessionReadTimerHandle | undefined;
  private readonly onCallerAbort = (): void => this.controller.abort();

  constructor(caller: AbortSignal, delayMs: number, arm: SessionReadPorts["timer"]["arm"]) {
    this.signal = this.controller.signal;
    this.expired = new Promise((resolve) => {
      this.controller.signal.addEventListener("abort", () => resolve({ kind: "expired" }), {
        once: true,
      });
    });
    caller.addEventListener("abort", this.onCallerAbort, { once: true });
    if (caller.aborted) this.controller.abort();
    try {
      const armed = snapshotDataRecord(
        arm(delayMs, () => this.controller.abort()),
        1,
      );
      if (!armed || Object.keys(armed).length !== 1 || typeof armed.cancel !== "function") {
        throw new TypeError("Session read timer returned a malformed handle.");
      }
      this.timer = { cancel: armed.cancel as () => void };
    } catch (cause: unknown) {
      caller.removeEventListener("abort", this.onCallerAbort);
      throw cause;
    }
  }

  async run<Value>(operation: () => Promise<Value>): Promise<Settled<Value>> {
    if (this.signal.aborted) return { kind: "expired" };
    const observed = Promise.resolve()
      .then(operation)
      .then(
        (value): Settled<Value> => ({ kind: "value", value }),
        (): Settled<Value> => ({ kind: "rejected" }),
      );
    return Promise.race([observed, this.expired]);
  }

  close(caller: AbortSignal): void {
    caller.removeEventListener("abort", this.onCallerAbort);
    try {
      this.timer?.cancel();
    } catch {
      this.timer = undefined;
    }
    this.timer = undefined;
  }
}

function failure(code: Parameters<typeof domainFailure>[0], message: string, retryable = false) {
  return domainFailure(code, message, retryable);
}

function parseRead(
  context: SessionReadContext,
  args: SessionReadArguments,
): DomainResult<ParsedRead> {
  const workspace = validateWorkspaceKey(context.workspaceKey);
  const source = validateSessionId(context.sourceSessionId);
  const record = snapshotDataRecord(args, 4);
  if (
    !workspace.ok ||
    !source.ok ||
    !record ||
    Object.keys(record).some((key) => !CURSOR_KEYS.has(key))
  ) {
    return failure("invalid_arguments", "Session read arguments are malformed.");
  }
  if (!Object.hasOwn(record, "sessionId")) {
    return failure("invalid_arguments", "sessionId is required.");
  }
  const target = validateSessionId(record.sessionId);
  if (!target.ok) return failure("invalid_arguments", target.message);
  const hasCursor = Object.hasOwn(record, "cursor");
  const hasDirection = Object.hasOwn(record, "direction");
  if (hasCursor && (typeof record.cursor !== "string" || record.cursor.length === 0)) {
    return failure("invalid_arguments", "cursor must be a nonempty session read cursor.");
  }
  if (hasDirection && record.direction !== "before" && record.direction !== "after") {
    return failure("invalid_arguments", "direction must be before or after.");
  }
  if (!hasCursor && hasDirection) {
    return failure("invalid_arguments", "direction requires cursor.");
  }
  const limit = Object.hasOwn(record, "limit") ? record.limit : sessionReadLimits.defaultLines;
  if (
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > sessionReadLimits.maxLines
  ) {
    return failure(
      "invalid_arguments",
      `limit must be an integer from 1 to ${sessionReadLimits.maxLines}.`,
    );
  }
  return {
    ok: true,
    value: {
      workspace: workspace.value,
      source: source.value,
      target: target.value,
      ...(hasCursor ? { cursor: record.cursor as string } : {}),
      ...(hasCursor
        ? { direction: (record.direction as SessionReadDirection | undefined) ?? "after" }
        : {}),
      mode: hasCursor
        ? ((record.direction as SessionReadDirection | undefined) ?? "after")
        : "tail",
      limit: limit as number,
    },
  };
}

async function digest(
  scope: ReadDeadlineScope,
  ports: SessionReadPorts,
  value: string,
): Promise<Settled<Sha256Digest>> {
  return scope.run(() => digestMessageContent(ports.digest, encoder.encode(value)));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: projection partitioning, whole-line packing, and both cryptographic boundaries are one result assembly proof.
async function assembleReadResult(
  ports: SessionReadPorts,
  scope: ReadDeadlineScope,
  read: ParsedRead,
  workspaceHash: Sha256Digest,
  cursorBoundary: SessionReadCursorBoundary | undefined,
  isEmptyBoundary: boolean,
  anchor: ProjectionSafeMessage | undefined,
  anchorSplit: SplitProjection | undefined,
  traversed: SessionReadTraversal,
  effectGuard: () => Promise<DomainResult<SessionReadPresence>>,
): Promise<DomainResult<SessionReadValue>> {
  const messages = traversed.messages;
  const messageMap = new Map(messages.map((message) => [message.messageId, message]));
  const allLines: RenderedProjectionLine[] = [];
  if (!appendCachedLines(allLines, messages, traversed.linesByMessage))
    return failure("native_unavailable", "Transcript projection is unavailable.", true);
  let before: readonly RenderedProjectionLine[] = [];
  let after: readonly RenderedProjectionLine[] = [];
  if (!cursorBoundary) before = allLines;
  else if (isEmptyBoundary) after = allLines;
  else {
    if (!anchor || !anchorSplit)
      return failure("cursor_stale", "Session read cursor anchor is stale.");
    const prior: RenderedProjectionLine[] = [];
    const later: RenderedProjectionLine[] = [];
    if (
      !appendCachedLines(
        prior,
        messages.slice(0, traversed.anchorIndex),
        traversed.linesByMessage,
      ) ||
      !appendCachedLines(later, messages.slice(traversed.anchorIndex + 1), traversed.linesByMessage)
    )
      return failure("native_unavailable", "Transcript projection is unavailable.", true);
    before = [...prior, ...anchorSplit.before];
    after = [...anchorSplit.after, ...later];
  }
  const candidate = read.mode === "after" ? after : before;
  const packed = packProjectionLines(candidate, read.limit, read.mode !== "after");
  const hasMoreBefore =
    read.mode === "tail" || read.mode === "before" ? packed.hasMore : before.length > 0;
  const hasMoreAfter = read.mode === "after" ? packed.hasMore : after.length > 0;
  let startCursor: string;
  let endCursor: string;
  if (packed.lines.length === 0) {
    if (read.cursor) startCursor = endCursor = read.cursor;
    else {
      const encoded = await scope.run(() =>
        encodeSessionReadBoundary(
          ports.digest,
          workspaceHash,
          read.target,
          messageMap,
          emptySessionReadPosition,
          traversed.linesByMessage,
        ),
      );
      if (encoded.kind === "expired")
        return failure("deadline_expired", "Session read deadline expired.");
      if (encoded.kind === "rejected" || !encoded.value)
        return failure("native_unavailable", "Session read cursor could not be created.", true);
      startCursor = endCursor = encoded.value;
    }
  } else {
    const firstLine = packed.lines[0];
    const lastLine = packed.lines.at(-1);
    if (!firstLine || !lastLine)
      return failure("native_unavailable", "Session read cursor could not be created.", true);
    const encoded = await scope.run(() =>
      Promise.all([
        encodeSessionReadBoundary(
          ports.digest,
          workspaceHash,
          read.target,
          messageMap,
          firstLine.start,
          traversed.linesByMessage,
        ),
        encodeSessionReadBoundary(
          ports.digest,
          workspaceHash,
          read.target,
          messageMap,
          lastLine.end,
          traversed.linesByMessage,
        ),
      ]),
    );
    if (encoded.kind === "expired")
      return failure("deadline_expired", "Session read deadline expired.");
    if (encoded.kind === "rejected" || !encoded.value[0] || !encoded.value[1])
      return failure("native_unavailable", "Session read cursor could not be created.", true);
    [startCursor, endCursor] = encoded.value as [string, string];
  }
  const finalPresence = await effectGuard();
  if (!finalPresence.ok) return finalPresence;
  return {
    ok: true,
    value: {
      sessionId: read.target,
      ...(traversed.earlierContextUnavailable ? { earlierContextUnavailable: true } : {}),
      content: packed.content,
      startCursor,
      endCursor,
      hasMoreBefore,
      hasMoreAfter,
      observedAtMs: finalPresence.value.observedAtMs,
      isLive:
        finalPresence.value.targetStatus === "busy" || finalPresence.value.targetStatus === "retry",
    },
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the ordered approval, visibility race, fixed-anchor validation, and bounded native traversal remain explicit in one orchestration boundary.
export async function readSession(
  ports: SessionReadPorts,
  context: SessionReadContext,
  args: SessionReadArguments,
): Promise<DomainResult<SessionReadValue>> {
  assertCommunicatorReady(ports.readiness);
  const parsed = parseRead(context, args);
  if (!parsed.ok) return parsed;
  if (!(context.abort instanceof AbortSignal) || !Number.isSafeInteger(context.deadlineMs)) {
    return failure("invalid_arguments", "Session read invocation control is malformed.");
  }
  let now: number;
  try {
    now = ports.clock.nowMs();
  } catch {
    return failure("native_unavailable", "Session read clock is unavailable.", true);
  }
  if (!Number.isSafeInteger(now) || context.deadlineMs <= now || context.abort.aborted) {
    return failure("deadline_expired", "Session read deadline expired.");
  }
  let scope: ReadDeadlineScope;
  try {
    scope = new ReadDeadlineScope(
      context.abort,
      context.deadlineMs - now,
      ports.timer.arm.bind(ports.timer),
    );
  } catch {
    return failure("native_unavailable", "Session read timer is unavailable.", true);
  }
  try {
    const read = parsed.value;
    const workspaceHash = await digest(
      scope,
      ports,
      `session-read-workspace-v1\0${read.workspace}`,
    );
    if (workspaceHash.kind === "expired")
      return failure("deadline_expired", "Session read deadline expired.");
    if (workspaceHash.kind === "rejected")
      return failure("native_unavailable", "Session read digest is unavailable.", true);
    let cursorBoundary: SessionReadCursorBoundary | undefined;
    if (read.cursor) {
      const decoded = decodeSessionReadCursor(read.cursor, workspaceHash.value, read.target);
      if (!decoded.ok) return failure("invalid_arguments", decoded.message);
      cursorBoundary = decoded.boundary;
    }
    const isEmptyBoundary =
      cursorBoundary?.messageId === emptySessionReadPosition.messageId &&
      cursorBoundary.itemKey === emptySessionReadPosition.itemKey &&
      cursorBoundary.utf8ByteOffset === 0;

    const effectGuard = (): Promise<DomainResult<SessionReadPresence>> =>
      observeSessionReadPresence(scope, ports.membership, read.workspace, read.source, read.target);
    const first = await effectGuard();
    if (!first.ok) return first;

    if (read.source !== read.target) {
      let cursorSha256: Sha256Digest | undefined;
      if (read.cursor) {
        const cursorHash = await digest(scope, ports, read.cursor);
        if (cursorHash.kind === "expired")
          return failure("deadline_expired", "Session read deadline expired.");
        if (cursorHash.kind === "rejected")
          return failure("native_unavailable", "Session read digest is unavailable.", true);
        cursorSha256 = cursorHash.value;
      }
      const binding: SessionReadApprovalBinding = {
        workspaceKey: read.workspace,
        sourceSessionId: read.source,
        targetSessionId: read.target,
        projectionVersion: sessionReadProjectionVersion,
        mode: read.mode,
        lineLimit: read.limit,
        aggregateByteCap: sessionReadLimits.maxContentBytes,
        ...(cursorSha256 === undefined ? {} : { cursorSha256 }),
      };
      const approval = await scope.run(() =>
        ports.approval.requestReadApproval(binding, {
          abort: scope.signal,
          deadlineMs: context.deadlineMs,
        }),
      );
      if (approval.kind === "expired")
        return failure("deadline_expired", "Session read deadline expired.");
      if (approval.kind === "rejected")
        return failure("native_unavailable", "Session read approval is unavailable.", true);
      const decision = snapshotDataRecord({ decision: approval.value }, 1)?.decision;
      if (decision !== "approved" && decision !== "rejected") {
        return failure("native_unavailable", "Session read approval is unavailable.", true);
      }
      if (decision === "rejected")
        return failure("permission_denied", "Cross-session read is denied by policy.");
    }

    if (cursorBoundary && isEmptyBoundary) {
      const expected = await scope.run(() => emptyBoundaryDigest(ports.digest));
      if (expected.kind === "expired")
        return failure("deadline_expired", "Session read deadline expired.");
      if (expected.kind === "rejected")
        return failure("native_unavailable", "Session read digest is unavailable.", true);
      if (expected.value !== cursorBoundary.prefixSha256)
        return failure("cursor_stale", "Session read cursor is stale.");
    }

    const current = await effectGuard();
    if (!current.ok) return current;

    let anchor: ProjectionSafeMessage | undefined;
    let anchorSplit: SplitProjection | undefined;
    const work = new SessionReadWorkBudget();
    if (cursorBoundary && !isEmptyBoundary) {
      const fixed = await readValidatedSessionReadAnchor({
        scope,
        native: ports.native,
        digest: ports.digest,
        workspace: read.workspace,
        target: read.target,
        boundary: cursorBoundary,
        effectGuard,
        work,
      });
      if (!fixed.ok) return fixed;
      anchor = fixed.value.message;
      anchorSplit = fixed.value.split;
    }

    const traversed = await traverseSessionRead(
      scope,
      ports.native,
      read,
      anchor,
      anchorSplit?.before ?? [],
      work,
      effectGuard,
    );
    if (!traversed.ok) return traversed;
    let finalTraversal = traversed.value;
    if (cursorBoundary && anchor) {
      const fixed = await readValidatedSessionReadAnchor({
        scope,
        native: ports.native,
        digest: ports.digest,
        workspace: read.workspace,
        target: read.target,
        boundary: cursorBoundary,
        effectGuard,
        work,
        replaceProjection: true,
      });
      if (!fixed.ok) return fixed;
      anchor = fixed.value.message;
      anchorSplit = fixed.value.split;
      const messages = [...finalTraversal.messages];
      messages[finalTraversal.anchorIndex] = fixed.value.message;
      finalTraversal = { ...finalTraversal, messages };
    }
    return assembleReadResult(
      ports,
      scope,
      read,
      workspaceHash.value,
      cursorBoundary,
      isEmptyBoundary,
      anchor,
      anchorSplit,
      finalTraversal,
      effectGuard,
    );
  } finally {
    scope.close(context.abort);
  }
}
