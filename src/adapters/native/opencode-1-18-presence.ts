import type { ContextTargetEligibilityPort } from "../../application/inject-communicator-context";
import type {
  NativeParticipantPresencePort,
  ParticipantPresence,
} from "../../application/participant-deletion-ports";
import type { SessionId } from "../../domain/sessions";
import type { WorkspaceKey } from "../../domain/workspaces";

interface DirectSessionSurface {
  get(
    input: { readonly sessionID: string },
    options: { readonly signal: AbortSignal },
  ): Promise<unknown>;
}

function snapshotRecord(
  value: unknown,
  maximumKeys: number,
  allowed?: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > maximumKeys ||
      keys.some((key) => typeof key !== "string" || (allowed && !allowed.has(key)))
    )
      return undefined;
    const output: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

const envelopeKeys = new Set(["data", "request", "response"]);
const notFoundEnvelopeKeys = new Set(["error", "request", "response"]);
const notFoundErrorKeys = new Set(["_tag", "message", "sessionID"]);
const responseStatusGetter = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get;

function genuineResponseStatus(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !responseStatusGetter) return undefined;
  try {
    // Calling the intrinsic getter performs the Response internal-slot brand check. In particular,
    // `instanceof Response` alone would accept a proxy or an object inheriting Response.prototype.
    return responseStatusGetter.call(value);
  } catch {
    return undefined;
  }
}

function hasPlainObjectPrototype(value: unknown): boolean {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      Object.getPrototypeOf(value) === Object.prototype
    );
  } catch {
    return false;
  }
}

function isExactCorrelatedNotFound(response: unknown, expectedSessionId: SessionId): boolean {
  if (!hasPlainObjectPrototype(response)) return false;
  const outer = snapshotRecord(response, 3, notFoundEnvelopeKeys);
  if (!outer || !Object.hasOwn(outer, "error") || !Object.hasOwn(outer, "response")) return false;
  if (!hasPlainObjectPrototype(outer.error)) return false;
  const error = snapshotRecord(outer.error, 3, notFoundErrorKeys);
  return (
    genuineResponseStatus(outer.response) === 404 &&
    error !== undefined &&
    Reflect.ownKeys(error).length === 3 &&
    error._tag === "SessionNotFoundError" &&
    error.sessionID === expectedSessionId &&
    typeof error.message === "string" &&
    error.message.length >= 1 &&
    error.message.length <= 4_096
  );
}

/** Classifies only direct, ID-correlated V2 evidence; list omission is intentionally irrelevant. */
export function classifyOpenCode118DirectSessionPresence(
  response: unknown,
  expectedSessionId: SessionId,
): ParticipantPresence {
  const outer = snapshotRecord(response, 3, envelopeKeys);
  const nativeStatus = genuineResponseStatus(outer?.response);
  const envelope = snapshotRecord(outer?.data, 1, new Set(["data"]));
  const session = snapshotRecord(envelope?.data, 32);
  if (nativeStatus === 200 && session?.id === expectedSessionId) {
    return "present";
  }
  return isExactCorrelatedNotFound(response, expectedSessionId) ? "absent" : "unknown";
}

export function classifyOpenCode118ContextTargetEligibility(
  response: unknown,
  expected: {
    readonly sessionId: SessionId;
    readonly projectId: string;
    readonly directory: string;
  },
): boolean {
  const outer = snapshotRecord(response, 3, envelopeKeys);
  const envelope = snapshotRecord(outer?.data, 1, new Set(["data"]));
  const session = snapshotRecord(envelope?.data, 32);
  const time = snapshotRecord(session?.time, 4);
  const location = snapshotRecord(session?.location, 8);
  const directories = [session?.directory, location?.directory].filter(
    (directory) => directory !== undefined,
  );
  return (
    genuineResponseStatus(outer?.response) === 200 &&
    session?.id === expected.sessionId &&
    session.projectID === expected.projectId &&
    directories.length > 0 &&
    directories.every((directory) => directory === expected.directory) &&
    !Object.hasOwn(session, "parentID") &&
    !!time &&
    Number.isSafeInteger(time.created) &&
    (time.created as number) >= 0 &&
    Number.isSafeInteger(time.updated) &&
    (time.updated as number) >= (time.created as number) &&
    !Object.hasOwn(time, "archived")
  );
}

export function createDirectParticipantPresencePort(
  surface: DirectSessionSurface,
): NativeParticipantPresencePort {
  return Object.freeze({
    async readParticipantPresence(
      sessionId: SessionId,
      abort: AbortSignal,
    ): Promise<ParticipantPresence> {
      if (abort.aborted) return "unknown";
      try {
        const response = await surface.get({ sessionID: sessionId }, { signal: abort });
        return abort.aborted
          ? "unknown"
          : classifyOpenCode118DirectSessionPresence(response, sessionId);
      } catch {
        return "unknown";
      }
    },
  });
}

export function createDirectContextTargetEligibilityPort(
  surface: DirectSessionSurface,
  binding: {
    readonly workspaceKey: WorkspaceKey;
    readonly projectId: string;
    readonly directory: string;
  },
): ContextTargetEligibilityPort {
  return Object.freeze({
    async isEligibleContextTarget(
      input: Parameters<ContextTargetEligibilityPort["isEligibleContextTarget"]>[0],
    ): Promise<boolean> {
      if (input.abort.aborted || input.workspaceKey !== binding.workspaceKey) return false;
      try {
        const response = await surface.get({ sessionID: input.sessionId }, { signal: input.abort });
        return (
          !input.abort.aborted &&
          classifyOpenCode118ContextTargetEligibility(response, {
            sessionId: input.sessionId,
            projectId: binding.projectId,
            directory: binding.directory,
          })
        );
      } catch {
        return false;
      }
    },
  });
}
