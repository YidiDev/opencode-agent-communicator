import type { SessionId } from "./sessions";

export const sessionReadLimits = Object.freeze({
  defaultLines: 100,
  maxLines: 500,
  maxRenderedLineBytes: 4_096,
  maxContentBytes: 65_536,
  maxCursorCharacters: 4_096,
  maxNativeCursorCharacters: 512,
  nativePageMessages: 8,
  maxNativeResponseBytes: 4 * 1_024 * 1_024,
  maxNativeResponseBytesExamined: 32 * 1_024 * 1_024,
  maxNativeCalls: 96,
  maxMessagesExamined: 512,
  maxProjectedTextBytesExamined: 8 * 1_024 * 1_024,
  maxPartsExamined: 16_384,
  maxRenderedLinesExamined: 32_768,
  maxRenderedLinesPerMessage: 8_192,
  /** Exact per-text-part structural adapter ceiling (UTF-16 code units). */
  maxNativeTextCharacters: 1_048_576,
  /** Exact per-assistant-message structural adapter ceiling. */
  maxNativeAssistantParts: 4_096,
  /** Exact raw native tool-name ceiling (UTF-16 code units). */
  maxNativeToolNameCharacters: 256,
});

export const sessionReadProjectionVersion = 1;

/** Item keys synthesized by the projector and therefore forbidden for native assistant parts. */
export const sessionReadReservedItemKeys = Object.freeze([
  "$user",
  "$assistant",
  "$assistant-state",
] as const);

export function isSessionReadReservedItemKey(value: string): boolean {
  return (sessionReadReservedItemKeys as readonly string[]).includes(value);
}

export type SessionReadDirection = "before" | "after";
export type AssistantProjectionState = "active" | "completed" | "error";
export type ToolProjectionStatus = "pending" | "running" | "completed" | "error";

/** Restricted adapter output. Raw native objects cannot inhabit this union. */
export type ProjectionSafeMessage = ProjectionSafeUserMessage | ProjectionSafeAssistantMessage;

export interface ProjectionSafeUserMessage {
  readonly type: "user";
  readonly messageId: string;
}

export interface ProjectionSafeAssistantMessage {
  readonly type: "assistant";
  readonly messageId: string;
  readonly state: AssistantProjectionState;
  readonly parts: readonly ProjectionSafeAssistantPart[];
}

export type ProjectionSafeAssistantPart = ProjectionSafeTextPart | ProjectionSafeToolPart;

export interface ProjectionSafeTextPart {
  readonly type: "text";
  readonly itemKey: string;
  readonly text: string;
}

export interface ProjectionSafeToolPart {
  readonly type: "tool";
  readonly itemKey: string;
  readonly name: string;
  readonly status: ToolProjectionStatus;
}

export interface RenderedLinePosition {
  readonly messageId: string;
  readonly itemKey: string;
  readonly utf8ByteOffset: number;
}

export interface RenderedProjectionLine {
  readonly text: string;
  readonly start: RenderedLinePosition;
  readonly end: RenderedLinePosition;
}

export interface PackedProjectionLines {
  readonly content: string;
  readonly lines: readonly RenderedProjectionLine[];
  readonly hasMore: boolean;
}

export interface SessionReadValue {
  readonly sessionId: SessionId;
  readonly content: string;
  readonly startCursor: string;
  readonly endCursor: string;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly observedAtMs: number;
  readonly isLive: boolean;
}
