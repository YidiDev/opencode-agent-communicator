import type {
  NativeInitialMessageAdmission,
  NativeStartCreation,
  NativeStartReconciliation,
  NativeTitleUpdate,
} from "../../application/session-start-ports";
import type { NativeMessageId } from "../../domain/generated-ids";
import type { SessionId } from "../../domain/sessions";
import { isAuthoritativeClientRejection } from "./opencode-1-18-admission";
import {
  admitPublicMessage,
  type PublicMessageAdmissionDependencies,
  type PublicMessageSurface,
  snapshotPublicRecord,
  successfulPublicData,
} from "./opencode-1-18-public-message";

interface StartSessionSurface {
  create(
    input: {
      readonly id: string;
      readonly agent?: string;
      readonly model?: { readonly providerID: string; readonly id: string };
      readonly location: { readonly directory: string };
    },
    options: { readonly signal: AbortSignal },
  ): Promise<unknown>;
  get(
    input: { readonly sessionID: string },
    options: { readonly signal: AbortSignal },
  ): Promise<unknown>;
}

interface PublicStartSurface extends PublicMessageSurface {
  updateTitle(
    input: { readonly sessionID: string; readonly directory: string; readonly title: string },
    options: { readonly signal: AbortSignal },
  ): Promise<unknown>;
}

function sessionInfo(value: unknown): Record<string, unknown> | undefined {
  const body = snapshotPublicRecord(successfulPublicData(value, 200), 1, new Set(["data"]));
  return body ? snapshotPublicRecord(body.data, 32) : undefined;
}

function publicSession(value: unknown): Record<string, unknown> | undefined {
  return snapshotPublicRecord(successfulPublicData(value, 200), 32);
}

function modelRef(
  model: string | undefined,
): { providerID: string; id: string } | undefined | null {
  if (model === undefined) return undefined;
  const separator = model.indexOf("/");
  if (separator < 1 || separator === model.length - 1) return null;
  return { providerID: model.slice(0, separator), id: model.slice(separator + 1) };
}

function matchesRequested(
  value: unknown,
  input: { sessionId: SessionId; directory: string; agent?: string; model?: string },
): boolean {
  const session = sessionInfo(value);
  const location = session && snapshotPublicRecord(session.location, 8);
  const model = session && snapshotPublicRecord(session.model, 8);
  const separator = input.model?.indexOf("/") ?? -1;
  return Boolean(
    session &&
      session.id === input.sessionId &&
      !Object.hasOwn(session, "parentID") &&
      location?.directory === input.directory &&
      (input.agent === undefined || session.agent === input.agent) &&
      (input.model === undefined ||
        (model?.providerID === input.model.slice(0, separator) &&
          model.id === input.model.slice(separator + 1))),
  );
}

export async function reconcileDeterministicRootSession(
  surface: Pick<StartSessionSurface, "get">,
  directory: string,
  input: {
    readonly sessionId: SessionId;
    readonly agent?: string;
    readonly model?: string;
    readonly abort: AbortSignal;
  },
): Promise<NativeStartReconciliation> {
  if (input.abort.aborted || modelRef(input.model) === null) return "unknown";
  try {
    const observed = await surface.get({ sessionID: input.sessionId }, { signal: input.abort });
    if (input.abort.aborted) return "unknown";
    if (sessionInfo(observed)) {
      return matchesRequested(observed, { ...input, directory }) ? "matching" : "collision";
    }
    // A direct 404 proves only that this read did not observe the ID. After a submitted create, the
    // server may still commit later, so the pinned API provides no bounded proof of stable absence.
    // Keep provenance unresolved rather than releasing the deterministic reservation.
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function createDeterministicRootSession(
  surface: StartSessionSurface,
  directory: string,
  input: {
    readonly sessionId: SessionId;
    readonly agent?: string;
    readonly model?: string;
    readonly abort: AbortSignal;
  },
): Promise<NativeStartCreation> {
  if (input.abort.aborted) return "unknown";
  const model = modelRef(input.model);
  if (model === null) return "definitive_rejection";
  try {
    const before = await surface.get({ sessionID: input.sessionId }, { signal: input.abort });
    if (sessionInfo(before)) return "collision";
    if (!isAuthoritativeClientRejection(before, input.abort.aborted, input.sessionId))
      return "unknown";
    const created = await surface.create(
      {
        id: input.sessionId,
        location: { directory },
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(model === undefined ? {} : { model }),
      },
      { signal: input.abort },
    );
    const expected = { ...input, directory };
    if (!matchesRequested(created, expected)) return "unknown";
    // The exact successful create response is authoritative creation evidence. Read-back is useful
    // corroboration, but transient unavailability/404 must not downgrade it to ambiguous provenance.
    try {
      await surface.get({ sessionID: input.sessionId }, { signal: input.abort });
    } catch {
      // Best-effort only after the exact create response was validated above.
    }
    return "created";
  } catch {
    return "unknown";
  }
}

export async function updateAndVerifySessionTitle(
  surface: Pick<PublicStartSurface, "updateTitle">,
  directory: string,
  input: { readonly sessionId: SessionId; readonly title: string; readonly abort: AbortSignal },
): Promise<NativeTitleUpdate> {
  if (input.abort.aborted) return "unknown";
  try {
    const response = await surface.updateTitle(
      { sessionID: input.sessionId, directory, title: input.title },
      { signal: input.abort },
    );
    if (isAuthoritativeClientRejection(response, input.abort.aborted, input.sessionId)) {
      return "definitive_rejection";
    }
    const updated = publicSession(response);
    return updated?.id === input.sessionId &&
      updated.title === input.title &&
      updated.directory === directory &&
      !Object.hasOwn(updated, "parentID") &&
      !input.abort.aborted
      ? "updated"
      : "unknown";
  } catch {
    return "unknown";
  }
}

export async function admitLegacyInitialMessage(
  surface: Pick<PublicStartSurface, "promptAsync" | "message">,
  directory: string,
  input: {
    readonly sessionId: SessionId;
    readonly nativeMessageId: NativeMessageId;
    readonly message: string;
    readonly agent?: string;
    readonly model?: string;
    readonly abort: AbortSignal;
  },
  dependencies: PublicMessageAdmissionDependencies = {},
): Promise<NativeInitialMessageAdmission> {
  const result = await admitPublicMessage(
    surface,
    directory,
    {
      sessionId: input.sessionId,
      nativeMessageId: input.nativeMessageId,
      text: input.message,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      ...(input.model === undefined ? {} : { model: input.model }),
      abort: input.abort,
    },
    dependencies,
  );
  return result.kind === "observed" ? "admitted" : result.kind;
}
