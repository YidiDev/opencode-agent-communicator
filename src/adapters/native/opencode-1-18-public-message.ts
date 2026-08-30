import type { NativeMessageId } from "../../domain/generated-ids";
import type { SessionId } from "../../domain/sessions";
import { isAuthoritativeClientRejection } from "./opencode-1-18-admission";

export interface PublicMessageSurface {
  promptAsync(
    input: {
      readonly sessionID: string;
      readonly directory: string;
      readonly messageID: string;
      readonly model?: { readonly providerID: string; readonly modelID: string };
      readonly agent?: string;
      readonly parts: [{ readonly type: "text"; readonly text: string }];
    },
    options: { readonly signal: AbortSignal },
  ): Promise<unknown>;
  message(
    input: { readonly sessionID: string; readonly directory: string; readonly messageID: string },
    options: { readonly signal: AbortSignal },
  ): Promise<unknown>;
}

export type PublicMessageAdmission =
  | { readonly kind: "observed"; readonly observedAtMs: number }
  | { readonly kind: "definitive_rejection" }
  | { readonly kind: "unknown" };

export interface PublicMessageAdmissionDependencies {
  readonly now?: () => number;
  readonly wait?: (abort: AbortSignal) => Promise<void>;
  readonly maximumObservations?: number;
}

export function snapshotPublicRecord(
  value: unknown,
  maximumKeys: number,
  allowedKeys?: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > maximumKeys ||
      keys.some((key) => typeof key !== "string" || (allowedKeys && !allowedKeys.has(key)))
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
const requestUrlGetter = Object.getOwnPropertyDescriptor(Request.prototype, "url")?.get;
const responseStatusGetter = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get;

function genuineRequest(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !requestUrlGetter) return false;
  try {
    return typeof requestUrlGetter.call(value) === "string";
  } catch {
    return false;
  }
}

function genuineResponseStatus(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !responseStatusGetter) return undefined;
  try {
    return responseStatusGetter.call(value);
  } catch {
    return undefined;
  }
}

export function successfulPublicData(
  value: unknown,
  status: number,
  requireResponse = false,
): unknown {
  const envelope = snapshotPublicRecord(value, 3, envelopeKeys);
  if (
    !envelope ||
    !Object.hasOwn(envelope, "data") ||
    (requireResponse && !Object.hasOwn(envelope, "response")) ||
    (Object.hasOwn(envelope, "response") && genuineResponseStatus(envelope.response) !== status) ||
    (Object.hasOwn(envelope, "request") && !genuineRequest(envelope.request))
  ) {
    return undefined;
  }
  return envelope.data;
}

function modelRef(
  model: string | undefined,
): { providerID: string; modelID: string } | undefined | null {
  if (model === undefined) return undefined;
  const separator = model.indexOf("/");
  if (separator < 1 || separator === model.length - 1) return null;
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

function publicPromptOverrides(
  agent: string | undefined,
  model: { providerID: string; modelID: string } | undefined,
) {
  return {
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
  };
}

function matchesPublicUserMessage(
  response: unknown,
  input: {
    readonly sessionId: SessionId;
    readonly nativeMessageId: NativeMessageId;
    readonly text: string;
  },
): boolean | undefined {
  const data = successfulPublicData(response, 200, true);
  if (data === undefined) return undefined;
  const body = snapshotPublicRecord(data, 2, new Set(["info", "parts"]));
  const info = body && snapshotPublicRecord(body.info, 32);
  if (!body || !info || !Array.isArray(body.parts) || body.parts.length > 4_096) return false;
  if (
    info.id !== input.nativeMessageId ||
    info.sessionID !== input.sessionId ||
    info.role !== "user"
  ) {
    return false;
  }
  if (body.parts.length === 0) return undefined;
  if (body.parts.length !== 1) return false;
  const part = snapshotPublicRecord(body.parts[0], 32);
  if (
    part?.type !== "text" ||
    part.sessionID !== input.sessionId ||
    part.messageID !== input.nativeMessageId
  ) {
    return false;
  }
  return part.text === input.text;
}

function defaultWait(abort: AbortSignal): Promise<void> {
  if (abort.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      abort.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 25);
    abort.addEventListener("abort", finish, { once: true });
  });
}

function observedAdmission(now: () => number): PublicMessageAdmission {
  const observedAtMs = now();
  return Number.isSafeInteger(observedAtMs) && observedAtMs >= 0
    ? { kind: "observed", observedAtMs }
    : { kind: "unknown" };
}

export async function admitPublicMessage(
  surface: PublicMessageSurface,
  directory: string,
  input: {
    readonly sessionId: SessionId;
    readonly nativeMessageId: NativeMessageId;
    readonly text: string;
    readonly agent?: string;
    readonly model?: string;
    readonly abort: AbortSignal;
  },
  dependencies: PublicMessageAdmissionDependencies = {},
): Promise<PublicMessageAdmission> {
  if (input.abort.aborted) return { kind: "unknown" };
  const model = modelRef(input.model);
  if (model === null) return { kind: "definitive_rejection" };
  let submission: unknown;
  try {
    submission = await surface.promptAsync(
      {
        sessionID: input.sessionId,
        directory,
        messageID: input.nativeMessageId,
        ...publicPromptOverrides(input.agent, model),
        parts: [{ type: "text", text: input.text }],
      },
      { signal: input.abort },
    );
  } catch {
    // A failed client observation does not prove the at-most-once POST missed the server.
  }
  if (isAuthoritativeClientRejection(submission, input.abort.aborted, input.sessionId)) {
    return { kind: "definitive_rejection" };
  }
  // A genuine 204 proves scheduling only. Fixed-ID public read-back is the admission boundary.
  successfulPublicData(submission, 204, true);
  const wait = dependencies.wait ?? defaultWait;
  const maximumObservations = dependencies.maximumObservations ?? 200;
  for (let attempt = 0; attempt < maximumObservations && !input.abort.aborted; attempt += 1) {
    try {
      const observed = await surface.message(
        {
          sessionID: input.sessionId,
          directory,
          messageID: input.nativeMessageId,
        },
        { signal: input.abort },
      );
      if (input.abort.aborted) return { kind: "unknown" };
      const matches = matchesPublicUserMessage(observed, {
        sessionId: input.sessionId,
        nativeMessageId: input.nativeMessageId,
        text: input.text,
      });
      if (matches === true) {
        return observedAdmission(dependencies.now ?? Date.now);
      }
      if (matches === false) return { kind: "unknown" };
    } catch {
      // Read-only observations are safe to repeat while the bounded operation remains live.
    }
    await wait(input.abort);
  }
  return { kind: "unknown" };
}
