import type { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";
import type {
  CurrentWorkspaceMembershipPort,
  NativeQueueAdmissionPort,
  SessionReadPresencePort,
} from "../../application/delivery-ports";
import type { ContextTargetEligibilityPort } from "../../application/inject-communicator-context";
import type { NativeParticipantPresencePort } from "../../application/participant-deletion-ports";
import type { ParticipantRootRevalidationPort } from "../../application/participant-registry-ports";
import type { NativeParticipantStopActivityPort } from "../../application/participant-stop-ports";
import type {
  NativeSteerAdmissionPort,
  RequestParticipantActivityPort,
} from "../../application/request-ports";
import type { NativeSessionReadPort } from "../../application/session-read-ports";
import type { NativeSessionStartPort } from "../../application/session-start-ports";
import type { NativeSessionInterruptPort } from "../../application/session-stop-ports";
import type { HostHealthPort } from "../../domain/host";
import { type VisibleRootSessionPort, validateSessionId } from "../../domain/sessions";
import type { WorkspaceKey } from "../../domain/workspaces";
import {
  isVisibleRoot,
  isWorkspaceRoot,
  matchesRequestedIdentity,
  parseRequestedModel,
  timestamp,
} from "./opencode-2-session-identity";
import { readOpenCodeContextProjection } from "./opencode-context-projection";

export class NativeAdapterFault extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "NativeAdapterFault";
  }
}

export interface OpenCodeNativeAdapterInput {
  readonly context: OpenCodeV2NativeContext;
  readonly directory: string;
  readonly workspaceKey: WorkspaceKey;
  readonly projectId: string;
}

export interface OpenCodeV2NativeContext {
  readonly app: Plugin.Context["app"];
  readonly session: Pick<
    Plugin.Context["session"],
    "context" | "create" | "get" | "interrupt" | "prompt" | "update"
  >;
}

export interface OpenCodeNativeAdapterDependencies {
  readonly now?: () => number;
}

export type OpenCodeNativeAdapter = HostHealthPort &
  VisibleRootSessionPort &
  NativeQueueAdmissionPort &
  NativeSteerAdmissionPort &
  RequestParticipantActivityPort &
  CurrentWorkspaceMembershipPort &
  Partial<SessionReadPresencePort> &
  NativeSessionInterruptPort &
  NativeSessionStartPort &
  NativeSessionReadPort &
  NativeParticipantPresencePort &
  NativeParticipantStopActivityPort &
  ContextTargetEligibilityPort &
  ParticipantRootRevalidationPort;

type SessionGetInput = Parameters<OpenCodeV2NativeContext["session"]["get"]>[0];
type SessionPromptInput = Parameters<OpenCodeV2NativeContext["session"]["prompt"]>[0];

interface ContextCursor {
  readonly version: 1;
  readonly snapshotSha256: string;
  readonly endExclusive: number;
  readonly order: "asc" | "desc";
}

function encodeContextCursor(value: ContextCursor): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeContextCursor(value: string): ContextCursor | undefined {
  if (value.length < 1 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const standard = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded: unknown = JSON.parse(
      atob(`${standard}${"=".repeat((4 - (standard.length % 4)) % 4)}`),
    );
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
    const cursor = decoded as Record<string, unknown>;
    if (Object.keys(cursor).join(",") !== "version,snapshotSha256,endExclusive,order")
      return undefined;
    if (
      cursor.version !== 1 ||
      typeof cursor.snapshotSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(cursor.snapshotSha256) ||
      !Number.isSafeInteger(cursor.endExclusive) ||
      (cursor.endExclusive as number) < 0 ||
      (cursor.order !== "asc" && cursor.order !== "desc")
    )
      return undefined;
    const result = cursor as unknown as ContextCursor;
    return encodeContextCursor(result) === value ? result : undefined;
  } catch {
    return undefined;
  }
}

function hostSessionId(value: string): SessionGetInput["sessionID"] {
  const validated = validateSessionId(value);
  if (!validated.ok) throw new NativeAdapterFault(validated.message);
  return validated.value as unknown as SessionGetInput["sessionID"];
}

function isSessionNotFound(error: unknown, sessionId: string): boolean {
  if (!(error instanceof Error)) return false;
  return (
    Reflect.get(error, "_tag") === "SessionNotFoundError" &&
    Reflect.get(error, "sessionID") === sessionId &&
    typeof Reflect.get(error, "message") === "string"
  );
}

function runHost<Value>(
  effect: Effect.Effect<Value, unknown>,
  abort?: AbortSignal,
): Promise<Value> {
  return Effect.runPromise(effect, abort ? { signal: abort } : undefined);
}

function assertWorkspace(input: OpenCodeNativeAdapterInput, workspaceKey: WorkspaceKey): void {
  if (workspaceKey !== input.workspaceKey) {
    throw new NativeAdapterFault("Workspace binding does not match this native adapter.");
  }
}

async function readWorkspaceSession(
  input: OpenCodeNativeAdapterInput,
  sessionId: string,
  abort?: AbortSignal,
  onNotFound?: () => void,
) {
  try {
    const session = await runHost(
      input.context.session.get({ sessionID: hostSessionId(sessionId) }),
      abort,
    );
    return session.id === sessionId && isWorkspaceRoot(session, input) ? session : undefined;
  } catch (error) {
    if (isSessionNotFound(error, sessionId)) {
      onNotFound?.();
      return undefined;
    }
    throw error;
  }
}

async function readVisibleSession(
  input: OpenCodeNativeAdapterInput,
  sessionId: string,
  abort?: AbortSignal,
) {
  const session = await readWorkspaceSession(input, sessionId, abort);
  return session && isVisibleRoot(session, input) ? session : undefined;
}

async function readCurrentContextPage(
  input: OpenCodeNativeAdapterInput,
  request: Parameters<OpenCodeNativeAdapter["readMessagePage"]>[0],
): ReturnType<OpenCodeNativeAdapter["readMessagePage"]> {
  assertWorkspace(input, request.workspaceKey);
  const projection = await readOpenCodeContextProjection(
    input.context.session,
    request.workspaceKey,
    input.workspaceKey,
    request.sessionId,
    request.abort,
  );
  const cursor =
    "cursor" in request && typeof request.cursor === "string"
      ? decodeContextCursor(request.cursor)
      : undefined;
  if (
    ("cursor" in request && typeof request.cursor === "string" && !cursor) ||
    (cursor && cursor.snapshotSha256 !== projection.snapshotSha256)
  ) {
    throw new NativeAdapterFault("Current-context cursor is malformed or the snapshot changed.");
  }
  if (
    request.maximumResponseBytes !== undefined &&
    projection.serializedByteCount > request.maximumResponseBytes
  ) {
    throw new NativeAdapterFault("Current-context snapshot exceeds the caller projection bound.");
  }
  const order = cursor?.order ?? request.order ?? "desc";
  const ordered = order === "desc" ? projection.messages : [...projection.messages].reverse();
  const endExclusive = cursor?.endExclusive ?? ordered.length;
  if (endExclusive > projection.messages.length) {
    throw new NativeAdapterFault("Current-context cursor is malformed or the snapshot changed.");
  }
  const start = Math.max(0, endExclusive - 8);
  const chronological = ordered.slice(start, endExclusive);
  const messages = [...chronological].reverse();
  const examinedMessageIds = messages.map((message) => message.messageId);
  const examinedPartCount = messages.reduce(
    (count, message) => count + (message.type === "assistant" ? message.parts.length : 0),
    0,
  );
  const projectedTextByteCount = messages.reduce(
    (count, message) =>
      count +
      (message.type === "assistant"
        ? message.parts.reduce(
            (partCount, part) =>
              partCount +
              (part.type === "text" ? new TextEncoder().encode(part.text).byteLength : 0),
            0,
          )
        : 0),
    0,
  );
  return {
    messages,
    ...(projection.earlierContextUnavailable ? { earlierContextUnavailable: true } : {}),
    examinedMessageIds,
    examinedMessageCount: examinedMessageIds.length,
    projectedTextByteCount,
    rawResponseByteCount: projection.serializedByteCount,
    examinedPartCount,
    previousCursor: null,
    nextCursor:
      start === 0
        ? null
        : encodeContextCursor({
            version: 1,
            snapshotSha256: projection.snapshotSha256,
            endExclusive: start,
            order,
          }),
  };
}

async function readCurrentContextMessage(
  input: OpenCodeNativeAdapterInput,
  request: Parameters<OpenCodeNativeAdapter["readMessage"]>[0],
): ReturnType<OpenCodeNativeAdapter["readMessage"]> {
  assertWorkspace(input, request.workspaceKey);
  const projection = await readOpenCodeContextProjection(
    input.context.session,
    request.workspaceKey,
    input.workspaceKey,
    request.sessionId,
    request.abort,
  );
  if (
    request.maximumResponseBytes !== undefined &&
    projection.serializedByteCount > request.maximumResponseBytes
  ) {
    throw new NativeAdapterFault("Current-context snapshot exceeds the caller projection bound.");
  }
  const message = projection.messages.find(
    (candidate) => candidate.messageId === request.messageId,
  );
  if (!message) return { kind: "not_found", rawResponseByteCount: projection.serializedByteCount };
  return {
    kind: "found",
    message,
    projectedTextByteCount:
      message.type === "assistant"
        ? message.parts.reduce(
            (count, part) =>
              count + (part.type === "text" ? new TextEncoder().encode(part.text).byteLength : 0),
            0,
          )
        : 0,
    rawResponseByteCount: projection.serializedByteCount,
    examinedPartCount: message.type === "assistant" ? message.parts.length : 0,
  };
}

/**
 * OpenCode 2.1 exposes paginated inventory, but no authoritative current activity query here.
 * Discovery deliberately retains registry-driven ID revalidation; status/sequence-dependent ports
 * stay conservative. Do not infer idle from inventory or reach through a private HTTP transport.
 */
function createRootMembership(
  input: OpenCodeNativeAdapterInput,
): CurrentWorkspaceMembershipPort["readCurrentRoots"] {
  return async (workspaceKey, sourceSessionId, targetSessionId, abort) => {
    assertWorkspace(input, workspaceKey);
    const [source, target] = await Promise.all([
      readVisibleSession(input, sourceSessionId, abort),
      readVisibleSession(input, targetSessionId, abort),
    ]);
    return {
      sourceVisible: source !== undefined,
      targetVisible: target !== undefined,
      sourceTitle: source?.title,
    };
  };
}

export function createOpenCode2NativeAdapter(
  input: OpenCodeNativeAdapterInput,
  dependencies: OpenCodeNativeAdapterDependencies = {},
): OpenCodeNativeAdapter {
  const context = input.context;
  const now = dependencies.now ?? Date.now;
  const readCurrentRoots = createRootMembership(input);
  return {
    async readHealth() {
      return { healthy: true, version: context.app.version };
    },
    async readVisibleRoots() {
      return [];
    },
    readCurrentRoots,
    async observeSessionReadPresence(workspaceKey, sourceSessionId, targetSessionId, abort) {
      const membership = await readCurrentRoots(
        workspaceKey,
        sourceSessionId,
        targetSessionId,
        abort,
      );
      return {
        sourceVisible: membership.sourceVisible,
        targetVisible: membership.targetVisible,
        targetStatus: "unknown",
        observedAtMs: now(),
      };
    },
    async observeRequestParticipants(workspaceKey, sourceSessionId, targetSessionId, abort) {
      const membership = await readCurrentRoots(
        workspaceKey,
        sourceSessionId,
        targetSessionId,
        abort,
      );
      return {
        sourceVisible: membership.sourceVisible,
        targetVisible: membership.targetVisible,
        targetStatus: "unknown",
      };
    },
    async observeParticipantActivities(workspaceKey, sessionIds) {
      assertWorkspace(input, workspaceKey);
      return sessionIds.map((sessionId) => ({ sessionId, activity: "unknown" as const }));
    },
    async isEligibleContextTarget() {
      return false;
    },
    async readParticipantPresence(sessionId, abort) {
      let notFound = false;
      try {
        const session = await readWorkspaceSession(input, sessionId, abort, () => {
          notFound = true;
        });
        if (notFound) return "absent";
        return session && isVisibleRoot(session, input) ? "present" : "unknown";
      } catch (error) {
        return isSessionNotFound(error, sessionId) ? "absent" : "unknown";
      }
    },
    async revalidateRoot(workspaceKey, sessionId, abort) {
      assertWorkspace(input, workspaceKey);
      const session = await readWorkspaceSession(input, sessionId, abort);
      if (!session) return undefined;
      const updatedAtMs = timestamp(session.time.updated);
      const observedAtMs = now();
      if (updatedAtMs === undefined || !Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
        throw new NativeAdapterFault("OpenCode v2 returned malformed session timestamps.");
      }
      const validatedId = validateSessionId(session.id);
      if (!validatedId.ok) throw new NativeAdapterFault(validatedId.message);
      return Object.freeze({
        id: validatedId.value,
        title: session.title ?? "",
        updatedAtMs,
        isArchived: session.time.archived !== undefined,
        status: "unknown" as const,
        observedAtMs,
      });
    },
    async queueMessage(request) {
      if (request.abort.aborted) return { kind: "unknown" };
      try {
        const prompt: SessionPromptInput = {
          sessionID: hostSessionId(request.targetSessionId),
          id: request.nativeMessageId as unknown as SessionPromptInput["id"],
          text: request.envelope,
          delivery: "queue",
          resume: true,
        };
        await runHost(context.session.prompt(prompt), request.abort);
        return request.abort.aborted
          ? { kind: "unknown" }
          : { kind: "public_message", observedAtMs: now() };
      } catch {
        return { kind: "unknown" };
      }
    },
    async steerRequest() {
      return { kind: "unknown" };
    },
    async interruptSession(request) {
      if (request.abort.aborted) return "unknown";
      try {
        const result = await runHost(
          context.session.interrupt({ sessionID: hostSessionId(request.targetSessionId) }),
          request.abort,
        );
        return !request.abort.aborted && result.interrupted ? "interrupted" : "unknown";
      } catch {
        return "unknown";
      }
    },
    async createRootSession(request) {
      if (request.abort.aborted) return "unknown";
      const model = parseRequestedModel(request.model);
      if (request.model !== undefined && model === undefined) return "definitive_rejection";
      try {
        const created = await runHost(
          context.session.create({
            id: hostSessionId(request.sessionId),
            location: { directory: input.directory as never },
            ...(request.agent ? { agent: request.agent as never } : {}),
            ...(model ? { model } : {}),
          }),
          request.abort,
        );
        if (request.abort.aborted) return "unknown";
        if (String(created.id) !== request.sessionId || !isVisibleRoot(created, input)) {
          return "unknown";
        }
        return matchesRequestedIdentity(created, request.agent, model) ? "created" : "collision";
      } catch {
        return "unknown";
      }
    },
    async reconcileRootSession(request) {
      if (request.abort.aborted) return "unknown";
      const model = parseRequestedModel(request.model);
      if (request.model !== undefined && model === undefined) return "collision";
      const session = await readVisibleSession(input, request.sessionId, request.abort);
      if (!session) return "absent";
      return matchesRequestedIdentity(session, request.agent, model) ? "matching" : "collision";
    },
    async updateSessionTitle(request) {
      if (request.abort.aborted) return "unknown";
      try {
        await runHost(
          context.session.update({
            sessionID: hostSessionId(request.sessionId),
            title: request.title,
          }),
          request.abort,
        );
        return request.abort.aborted ? "unknown" : "updated";
      } catch {
        return "unknown";
      }
    },
    async admitInitialMessage(request) {
      if (request.abort.aborted) return "unknown";
      try {
        await runHost(
          context.session.prompt({
            sessionID: hostSessionId(request.sessionId),
            id: request.nativeMessageId as unknown as SessionPromptInput["id"],
            text: request.message,
            delivery: "queue",
            resume: true,
          }),
          request.abort,
        );
        return request.abort.aborted ? "unknown" : "admitted";
      } catch {
        return "unknown";
      }
    },
    async readMessagePage(request) {
      return readCurrentContextPage(input, request);
    },
    async readMessage(request) {
      return readCurrentContextMessage(input, request);
    },
  };
}
