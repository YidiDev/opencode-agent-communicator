import type {
  NativeFixedMessageRequest,
  NativeFixedMessageResult,
  NativeMessagePage,
  NativeMessagePageRequest,
  NativeSessionReadPort,
} from "../../application/session-read-ports";
import {
  type AssistantProjectionState,
  isSessionReadReservedItemKey,
  type ProjectionSafeAssistantPart,
  type ProjectionSafeMessage,
  sessionReadLimits,
  type ToolProjectionStatus,
} from "../../domain/session-read";
import { validateSessionId } from "../../domain/sessions";
import type { WorkspaceKey } from "../../domain/workspaces";
import { validateWorkspaceKey } from "../../domain/workspaces";
import { isAuthoritativeFixedMessageNotFound } from "./opencode-1-18-session-read-not-found";
import { NativeAdapterFault } from "./opencode-1-18-surface";
import { createBoundedOpenCode118Fetch } from "./opencode-1-18-transport";

interface SessionReadOptions {
  readonly signal: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
  readonly throwOnError: false;
}

export interface OpenCode118SessionReadSurface {
  messages(
    parameters: {
      readonly sessionID: string;
      readonly limit: number;
      readonly order?: "asc" | "desc";
      readonly cursor?: string;
    },
    options: SessionReadOptions,
  ): Promise<unknown>;
  message(
    parameters: { readonly sessionID: string; readonly messageID: string },
    options: SessionReadOptions,
  ): Promise<unknown>;
}

interface SessionReadConfiguration {
  readonly workspaceKey: WorkspaceKey;
  readonly hostFetch: typeof globalThis.fetch;
  readonly serverUrl: URL;
  readonly directory: string;
}

const MAX_IDENTIFIER_CHARACTERS = 256;
const OMITTED_MESSAGE_TYPES = new Set([
  "agent-switched",
  "model-switched",
  "synthetic",
  "system",
  "shell",
  "compaction",
]);
const encoder = new TextEncoder();

function fault(label: string): never {
  throw new NativeAdapterFault(`${label} returned malformed data.`);
}

function snapshotRecord(
  value: unknown,
  label: string,
  maximumKeys: number,
): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return fault(label);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return fault(label);
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumKeys || keys.some((key) => typeof key !== "string"))
      return fault(label);
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return fault(label);
      result[key] = descriptor.value;
    }
    return result;
  } catch (cause: unknown) {
    if (cause instanceof NativeAdapterFault) throw cause;
    return fault(label);
  }
}

function snapshotDenseArray(
  value: unknown,
  label: string,
  maximumLength: number,
): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
      return fault(label);
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    const keys = Reflect.ownKeys(value);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximumLength ||
      keys.length !== length + 1
    ) {
      return fault(label);
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) return fault(label);
      result.push(descriptor.value);
    }
    return result;
  } catch (cause: unknown) {
    if (cause instanceof NativeAdapterFault) throw cause;
    return fault(label);
  }
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  pattern?: RegExp,
  minimum = 1,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    return fault(label);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  return boundedString(value, label, MAX_IDENTIFIER_CHARACTERS, /^[\x21-\x7e]+$/);
}

function cursor(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return boundedString(value, label, sessionReadLimits.maxNativeCursorCharacters, /^[\x21-\x7e]+$/);
}

function finiteTime(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fault(label);
}

function assistantState(message: Readonly<Record<string, unknown>>): AssistantProjectionState {
  const time = snapshotRecord(message.time, "V2 assistant message time", 4);
  finiteTime(time.created, "V2 assistant message time");
  const hasCompleted = Object.hasOwn(time, "completed");
  if (hasCompleted) finiteTime(time.completed, "V2 assistant message time");
  if (Object.hasOwn(message, "error")) {
    if (message.error === undefined) fault("V2 assistant message error state");
    return "error";
  }
  return hasCompleted ? "completed" : "active";
}

interface ProjectedNativePart {
  readonly itemKey: string;
  readonly part?: ProjectionSafeAssistantPart;
}

function projectAssistantPart(value: unknown): ProjectedNativePart {
  const part = snapshotRecord(value, "V2 assistant part", 12);
  const type = boundedString(part.type, "V2 assistant part type", 32);
  const itemKey = identifier(part.id, "V2 assistant part identity");
  if (isSessionReadReservedItemKey(itemKey)) return fault("V2 assistant part identity");
  if (type === "reasoning") return { itemKey };
  if (type === "text") {
    return {
      itemKey,
      part: {
        type: "text",
        itemKey,
        text: boundedString(
          part.text,
          "V2 assistant text",
          sessionReadLimits.maxNativeTextCharacters,
          undefined,
          0,
        ),
      },
    };
  }
  if (type === "tool") {
    const state = snapshotRecord(part.state, "V2 assistant tool state", 12);
    const status = boundedString(state.status, "V2 assistant tool status", 32);
    if (
      !(["pending", "running", "completed", "error"] as const).includes(
        status as ToolProjectionStatus,
      )
    ) {
      return fault("V2 assistant tool status");
    }
    return {
      itemKey,
      part: {
        type: "tool",
        itemKey,
        name: boundedString(
          part.name,
          "V2 assistant tool name",
          sessionReadLimits.maxNativeToolNameCharacters,
        ),
        status: status as ToolProjectionStatus,
      },
    };
  }
  return fault("V2 assistant part type");
}

interface ProjectedNativeMessage {
  readonly messageId: string;
  readonly message?: ProjectionSafeMessage;
  readonly projectedTextByteCount: number;
  readonly examinedPartCount: number;
}

function projectMessage(value: unknown, abort?: AbortSignal): ProjectedNativeMessage {
  const message = snapshotRecord(value, "V2 session message", 24);
  const type = boundedString(message.type, "V2 session message type", 32);
  const messageId = identifier(message.id, "V2 session message identity");
  if (OMITTED_MESSAGE_TYPES.has(type))
    return { messageId, projectedTextByteCount: 0, examinedPartCount: 0 };
  if (type === "user")
    return {
      messageId,
      message: { type: "user", messageId },
      projectedTextByteCount: 0,
      examinedPartCount: 0,
    };
  if (type !== "assistant") return fault("V2 session message type");

  const values = snapshotDenseArray(
    message.content,
    "V2 assistant content",
    sessionReadLimits.maxNativeAssistantParts,
  );
  const seen = new Set<string>();
  const parts: ProjectionSafeAssistantPart[] = [];
  let projectedTextByteCount = 0;
  for (const value of values) {
    if (abort?.aborted) throw new NativeAdapterFault("Session read was aborted.");
    const projected = projectAssistantPart(value);
    if (seen.has(projected.itemKey)) fault("V2 assistant part identity");
    seen.add(projected.itemKey);
    if (projected.part) {
      parts.push(projected.part);
      if (projected.part.type === "text") {
        projectedTextByteCount += encoder.encode(projected.part.text).length;
      }
    }
  }
  return {
    messageId,
    message: { type: "assistant", messageId, state: assistantState(message), parts },
    projectedTextByteCount,
    examinedPartCount: values.length,
  };
}

function responseData(value: unknown, label: string): unknown {
  const envelope = snapshotRecord(value, label, 3);
  const keys = Object.keys(envelope);
  const testEnvelope = keys.length === 1 && keys[0] === "data";
  const sdkEnvelope =
    keys.length === 3 &&
    keys.includes("data") &&
    keys.includes("request") &&
    keys.includes("response") &&
    envelope.request instanceof Request &&
    envelope.response instanceof Response;
  if (!testEnvelope && !sdkEnvelope) return fault(label);
  return envelope.data;
}

function projectPage(
  value: unknown,
  abort: AbortSignal,
  rawResponseByteCount: number,
): NativeMessagePage {
  const body = snapshotRecord(
    responseData(value, "V2 session message page"),
    "V2 session message page",
    4,
  );
  if (
    Object.keys(body).length !== 2 ||
    !Object.hasOwn(body, "data") ||
    !Object.hasOwn(body, "cursor")
  )
    return fault("V2 session message page");
  const nativeMessages = snapshotDenseArray(
    body.data,
    "V2 session message page data",
    sessionReadLimits.nativePageMessages,
  );
  const pagination = snapshotRecord(body.cursor, "V2 session message page cursor", 2);
  if (Object.keys(pagination).some((key) => key !== "previous" && key !== "next")) {
    return fault("V2 session message page cursor");
  }
  const seen = new Set<string>();
  const messages: ProjectionSafeMessage[] = [];
  let projectedTextByteCount = 0;
  let examinedPartCount = 0;
  for (const value of nativeMessages) {
    if (abort.aborted) throw new NativeAdapterFault("Session read was aborted.");
    const projected = projectMessage(value, abort);
    if (seen.has(projected.messageId)) fault("V2 session message identity");
    seen.add(projected.messageId);
    if (projected.message) messages.push(projected.message);
    projectedTextByteCount += projected.projectedTextByteCount;
    examinedPartCount += projected.examinedPartCount;
  }
  return {
    messages,
    examinedMessageIds: [...seen],
    examinedMessageCount: nativeMessages.length,
    projectedTextByteCount,
    rawResponseByteCount,
    examinedPartCount,
    previousCursor: Object.hasOwn(pagination, "previous")
      ? pagination.previous === null
        ? null
        : (cursor(pagination.previous, "V2 previous page cursor") ??
          fault("V2 previous page cursor"))
      : null,
    nextCursor: Object.hasOwn(pagination, "next")
      ? pagination.next === null
        ? null
        : (cursor(pagination.next, "V2 next page cursor") ?? fault("V2 next page cursor"))
      : null,
  };
}

function assertRequest(
  workspaceKey: unknown,
  sessionId: unknown,
  abort: unknown,
  configuredWorkspace: WorkspaceKey,
): asserts abort is AbortSignal {
  const workspace = validateWorkspaceKey(workspaceKey);
  const session = validateSessionId(sessionId);
  if (!workspace.ok || workspace.value !== configuredWorkspace) {
    throw new NativeAdapterFault("Session read workspace binding is invalid.");
  }
  if (!session.ok) throw new NativeAdapterFault("Session read identity is invalid.");
  if (!(abort instanceof AbortSignal) || abort.aborted) {
    throw new NativeAdapterFault("Session read abort signal is invalid or aborted.");
  }
}

function requestOptions(
  abort: AbortSignal,
  hostFetch: typeof globalThis.fetch,
  maximumResponseBytes: number,
): { readonly options: SessionReadOptions; readonly measuredBytes: () => number } {
  let measuredBytes = 0;
  return {
    options: {
      signal: abort,
      throwOnError: false,
      fetch: createBoundedOpenCode118Fetch(hostFetch, maximumResponseBytes, (byteLength) => {
        if (byteLength > maximumResponseBytes - measuredBytes) {
          throw new NativeAdapterFault("Pinned OpenCode response exceeded its byte ceiling.");
        }
        measuredBytes += byteLength;
      }),
    },
    measuredBytes: () => measuredBytes,
  };
}

function requestResponseByteCeiling(value: number | undefined): number {
  const maximum = value ?? sessionReadLimits.maxNativeResponseBytes;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > sessionReadLimits.maxNativeResponseBytes
  ) {
    throw new NativeAdapterFault("Session read response byte ceiling is invalid.");
  }
  return maximum;
}

export function createOpenCode118SessionReadPort(
  surface: OpenCode118SessionReadSurface,
  configuration: SessionReadConfiguration,
): NativeSessionReadPort {
  const configuredWorkspace = validateWorkspaceKey(configuration.workspaceKey);
  if (!configuredWorkspace.ok) throw new NativeAdapterFault(configuredWorkspace.message);
  return {
    async readMessagePage(request: NativeMessagePageRequest): Promise<NativeMessagePage> {
      assertRequest(
        request.workspaceKey,
        request.sessionId,
        request.abort,
        configuredWorkspace.value,
      );
      const hasCursor = request.cursor !== undefined && request.cursor !== null;
      if (hasCursor) cursor(request.cursor, "V2 requested page cursor");
      if (
        (hasCursor && request.order !== undefined) ||
        (!hasCursor && request.order !== "asc" && request.order !== "desc")
      ) {
        throw new NativeAdapterFault("Session read pagination request is invalid.");
      }
      const parameters = hasCursor
        ? {
            sessionID: request.sessionId,
            limit: sessionReadLimits.nativePageMessages,
            cursor: request.cursor as string,
          }
        : {
            sessionID: request.sessionId,
            limit: sessionReadLimits.nativePageMessages,
            order: request.order as "asc" | "desc",
          };
      try {
        const bounded = requestOptions(
          request.abort,
          configuration.hostFetch,
          requestResponseByteCeiling(request.maximumResponseBytes),
        );
        const response = await surface.messages(parameters, bounded.options);
        if (request.abort.aborted) throw new NativeAdapterFault("Session read was aborted.");
        return projectPage(response, request.abort, bounded.measuredBytes());
      } catch (cause: unknown) {
        if (cause instanceof NativeAdapterFault) throw cause;
        throw new NativeAdapterFault("V2 session message page read failed.", cause);
      }
    },
    async readMessage(request: NativeFixedMessageRequest): Promise<NativeFixedMessageResult> {
      assertRequest(
        request.workspaceKey,
        request.sessionId,
        request.abort,
        configuredWorkspace.value,
      );
      identifier(request.messageId, "V2 requested message identity");
      try {
        const bounded = requestOptions(
          request.abort,
          configuration.hostFetch,
          requestResponseByteCeiling(request.maximumResponseBytes),
        );
        const response = await surface.message(
          { sessionID: request.sessionId, messageID: request.messageId },
          bounded.options,
        );
        if (request.abort.aborted) throw new NativeAdapterFault("Session read was aborted.");
        if (
          isAuthoritativeFixedMessageNotFound(
            response,
            { sessionId: request.sessionId, messageId: request.messageId },
            { serverUrl: configuration.serverUrl, directory: configuration.directory },
          )
        )
          return { kind: "not_found", rawResponseByteCount: bounded.measuredBytes() };
        const body = snapshotRecord(
          responseData(response, "V2 fixed session message"),
          "V2 fixed session message",
          2,
        );
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "data")) {
          throw new NativeAdapterFault("V2 fixed session message returned malformed data.");
        }
        const projected = projectMessage(body.data, request.abort);
        if (!projected.message) {
          throw new NativeAdapterFault("Fixed session message is not projectable.");
        }
        if (projected.messageId !== request.messageId) {
          throw new NativeAdapterFault(
            "Fixed session message identity does not match the request.",
          );
        }
        return {
          kind: "found",
          message: projected.message,
          projectedTextByteCount: projected.projectedTextByteCount,
          rawResponseByteCount: bounded.measuredBytes(),
          examinedPartCount: projected.examinedPartCount,
        };
      } catch (cause: unknown) {
        if (cause instanceof NativeAdapterFault) throw cause;
        throw new NativeAdapterFault("V2 fixed session message read failed.", cause);
      }
    },
  };
}
