import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";
import type { ProjectionSafeMessage, ToolProjectionStatus } from "../../domain/session-read";
import { sessionReadLimits } from "../../domain/session-read";
import type { SessionId } from "../../domain/sessions";
import { validateSessionId } from "../../domain/sessions";
import type { WorkspaceKey } from "../../domain/workspaces";

const encoder = new TextEncoder();

export interface CurrentContextProjection {
  readonly messages: readonly ProjectionSafeMessage[];
  readonly examinedMessageIds: readonly string[];
  readonly examinedMessageCount: number;
  readonly examinedPartCount: number;
  readonly projectedTextByteCount: number;
  readonly snapshotSha256: string;
  readonly serializedByteCount: number;
  readonly earlierContextUnavailable: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedToken(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= sessionReadLimits.maxNativeCursorCharacters &&
    /^[\x21-\x7e]+$/.test(value)
    ? value
    : undefined;
}

function toolStatus(value: unknown): ToolProjectionStatus | undefined {
  const state = record(value);
  const status = state?.status;
  if (status === "streaming") return "pending";
  return status === "running" || status === "completed" || status === "error" ? status : undefined;
}

/**
 * Converts the public v2 model-context snapshot to the deliberately narrow shared projection.
 * It never copies user text, reasoning, files, tool arguments/results, metadata, or provider state.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: strict untrusted host-shape projection keeps every rejected field and bound adjacent.
export function projectOpenCodeContext(value: unknown): CurrentContextProjection {
  if (!Array.isArray(value)) {
    throw new TypeError("OpenCode current context is malformed or exceeds its message bound.");
  }
  const messages: ProjectionSafeMessage[] = [];
  const examinedMessageIds: string[] = [];
  let examinedPartCount = 0;
  let projectedTextByteCount = 0;
  const contextLength = value.length;
  const tailStart = Math.max(0, contextLength - sessionReadLimits.maxMessagesExamined);
  // Index only the bounded tail: even getters in the excluded prefix must not be visited.
  for (let index = tailStart; index < contextLength; index += 1) {
    const candidate = value[index];
    const message = record(candidate);
    const messageId = boundedToken(message?.id);
    if (!message || !messageId || examinedMessageIds.includes(messageId)) {
      throw new TypeError("OpenCode current context contains malformed message identity.");
    }
    examinedMessageIds.push(messageId);
    if (message.type === "user") {
      messages.push({ type: "user", messageId });
      continue;
    }
    if (message.type !== "assistant") continue;
    if (
      !Array.isArray(message.content) ||
      message.content.length > sessionReadLimits.maxNativeAssistantParts
    ) {
      throw new TypeError("OpenCode current context contains malformed assistant content.");
    }
    const parts: Array<
      | { readonly type: "text"; readonly itemKey: string; readonly text: string }
      | {
          readonly type: "tool";
          readonly itemKey: string;
          readonly name: string;
          readonly status: ToolProjectionStatus;
        }
    > = [];
    for (const [index, candidatePart] of message.content.entries()) {
      examinedPartCount += 1;
      if (examinedPartCount > sessionReadLimits.maxPartsExamined) {
        throw new TypeError("OpenCode current context exceeds its part bound.");
      }
      const part = record(candidatePart);
      if (!part || part.type === "reasoning") continue;
      if (part.type === "text") {
        if (
          typeof part.text !== "string" ||
          part.text.length > sessionReadLimits.maxNativeTextCharacters
        ) {
          throw new TypeError("OpenCode current context contains malformed assistant text.");
        }
        projectedTextByteCount += encoder.encode(part.text).byteLength;
        if (projectedTextByteCount > sessionReadLimits.maxProjectedTextBytesExamined) {
          throw new TypeError("OpenCode current context exceeds its text bound.");
        }
        parts.push({ type: "text", itemKey: `text:${index}`, text: part.text });
        continue;
      }
      if (part.type === "tool") {
        const itemKey = boundedToken(part.id);
        const name = boundedToken(part.name);
        const status = toolStatus(part.state);
        if (!itemKey || !name || !status) {
          throw new TypeError("OpenCode current context contains malformed tool state.");
        }
        parts.push({ type: "tool", itemKey, name, status });
      }
    }
    const time = record(message.time);
    const state =
      message.error !== undefined
        ? "error"
        : time?.completed === undefined
          ? "active"
          : "completed";
    messages.push({ type: "assistant", messageId, state, parts });
  }
  const serialized = JSON.stringify(messages);
  const serializedByteCount = encoder.encode(serialized).byteLength;
  if (serializedByteCount > sessionReadLimits.maxNativeResponseBytes) {
    throw new TypeError("OpenCode current context exceeds its serialized bound.");
  }
  return Object.freeze({
    messages: Object.freeze(messages),
    examinedMessageIds: Object.freeze(examinedMessageIds),
    examinedMessageCount: examinedMessageIds.length,
    examinedPartCount,
    projectedTextByteCount,
    snapshotSha256: createHash("sha256").update(`${tailStart}\0${serialized}`).digest("hex"),
    serializedByteCount,
    earlierContextUnavailable: tailStart > 0,
  });
}

export async function readOpenCodeContextProjection(
  session: Pick<Plugin.Context["session"], "context">,
  workspaceKey: WorkspaceKey,
  expectedWorkspaceKey: WorkspaceKey,
  sessionId: SessionId,
  abort?: AbortSignal,
): Promise<CurrentContextProjection> {
  if (workspaceKey !== expectedWorkspaceKey || !validateSessionId(sessionId).ok) {
    throw new TypeError("Current-context projection binding is invalid.");
  }
  const output = await Effect.runPromise(
    session.context({
      sessionID: sessionId as unknown as Parameters<typeof session.context>[0]["sessionID"],
    }),
    abort ? { signal: abort } : undefined,
  );
  if (abort?.aborted) throw new Error("Current-context projection was cancelled.");
  return projectOpenCodeContext(output);
}
