import type { NativeQueueAdmission } from "../../application/delivery-ports";
import type { NativeSteerAdmission } from "../../application/request-ports";
import type { NativeMessageId } from "../../domain/generated-ids";
import type { SessionId } from "../../domain/sessions";

export interface ClientRejectionCorrelation {
  readonly abort?: AbortSignal;
  readonly method: "GET" | "POST" | "PATCH";
  readonly serverUrl: URL;
  readonly endpointPath: string;
  readonly directory: string;
  readonly targetSessionId?: SessionId;
  readonly messageId?: NativeMessageId;
  readonly messageIdBodyKey?: "id" | "messageID";
  readonly exactRequestBody?: Readonly<Record<string, string>>;
}

interface AdmissionTarget {
  readonly targetSessionId: SessionId;
  readonly nativeMessageId: NativeMessageId;
  readonly envelope: string;
}

type AdmissionDelivery = "queue" | "steer";
type NativeAdmission =
  | Exclude<NativeQueueAdmission, { readonly kind: "public_message" }>
  | NativeSteerAdmission;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotExactData(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> | undefined {
  try {
    if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !allowed.includes(key)) || keys.length < 2)
      return undefined;
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown, maximum = 4_096): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function safeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

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

function exactWorkspaceBinding(request: Request, url: URL, directory: string): boolean {
  const directoryValues = url.searchParams.getAll("directory");
  const locationValues = url.searchParams.getAll("location[directory]");
  const keys = [...url.searchParams.keys()];
  const exactQuery =
    directoryValues.length === 1 &&
    directoryValues[0] === directory &&
    locationValues.length <= 1 &&
    locationValues.every((value) => value === directory) &&
    keys.every((key) => key === "directory" || key === "location[directory]") &&
    keys.length === 1 + locationValues.length;
  const header = request.headers.get("x-opencode-directory");
  const exactHeader =
    header === null || header === directory || header === encodeURIComponent(directory);
  if (!exactHeader) return false;
  if (exactQuery) return true;
  return keys.length === 0 && header !== null;
}

async function boundedRequestJson(
  request: Request,
  abort: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const clone = request.clone();
  if (clone.body === null) return undefined;
  const reader = clone.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  abort.addEventListener("abort", cancel, { once: true });
  try {
    if (abort.aborted) {
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    while (true) {
      const result = await reader.read();
      if (abort.aborted) return undefined;
      if (result.done) break;
      if (!(result.value instanceof Uint8Array) || result.value.byteLength > 65_536 - bytes) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      bytes += result.value.byteLength;
      chunks.push(result.value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return undefined;
  } finally {
    abort.removeEventListener("abort", cancel);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype ? value : undefined;
  } catch {
    return undefined;
  }
}

async function matchesRequest(
  value: unknown,
  expected: ClientRejectionCorrelation,
): Promise<boolean> {
  if (!genuineRequest(value)) return false;
  try {
    const request = value as Request;
    const url = new URL(request.url);
    if (
      request.method !== expected.method ||
      url.origin !== expected.serverUrl.origin ||
      url.pathname !== expected.endpointPath ||
      url.hash !== "" ||
      !exactWorkspaceBinding(request, url, expected.directory)
    ) {
      return false;
    }
    if (expected.messageId === undefined && expected.exactRequestBody === undefined) return true;
    const body = await boundedRequestJson(request, expected.abort ?? request.signal);
    if (!body) return false;
    if (
      expected.messageId !== undefined &&
      (!expected.messageIdBodyKey || body[expected.messageIdBodyKey] !== expected.messageId)
    ) {
      return false;
    }
    const exactRequestBody = expected.exactRequestBody;
    if (exactRequestBody === undefined) return true;
    const expectedKeys = Object.keys(exactRequestBody);
    const bodyKeys = Object.keys(body);
    return (
      bodyKeys.length === expectedKeys.length &&
      expectedKeys.every((key) => Object.hasOwn(body, key) && body[key] === exactRequestBody[key])
    );
  } catch {
    return false;
  }
}

function supportedRejectionStatus(value: unknown): 400 | 401 | 404 | undefined {
  const status = genuineResponseStatus(value);
  return status === 400 || status === 401 || status === 404 ? status : undefined;
}

function observedTime(data: Record<string, unknown>, now: () => number): number | undefined {
  // The 1.18 line's successful admission response makes timeCreated authoritative.
  // The injected clock is used only when that field is absent, never when native evidence is invalid.
  if ("timeCreated" in data) {
    const timeCreated = data.timeCreated;
    return Number.isSafeInteger(timeCreated) && (timeCreated as number) >= 0
      ? (timeCreated as number)
      : undefined;
  }
  const fallback = now();
  return Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : undefined;
}

export function parseAdmissionResponse(
  response: unknown,
  target: AdmissionTarget,
  now: () => number,
  expectedDelivery: AdmissionDelivery = "queue",
): NativeAdmission {
  if (!isRecord(response) || response.error !== undefined || !isRecord(response.data)) {
    return { kind: "unknown" };
  }
  const body = response.data;
  if (!isRecord(body.data)) return { kind: "unknown" };
  const data = body.data;
  if (
    data.sessionID !== target.targetSessionId ||
    data.id !== target.nativeMessageId ||
    data.delivery !== expectedDelivery ||
    !isRecord(data.prompt) ||
    data.prompt.text !== target.envelope ||
    !safeSequence(data.admittedSeq)
  ) {
    return { kind: "unknown" };
  }
  const observedAtMs = observedTime(data, now);
  if (observedAtMs === undefined) return { kind: "unknown" };
  if (data.promotedSeq === undefined) {
    return { kind: "admitted", admittedSeq: data.admittedSeq, observedAtMs };
  }
  if (!safeSequence(data.promotedSeq) || data.promotedSeq <= data.admittedSeq) {
    return { kind: "unknown" };
  }
  return {
    kind: "promoted",
    admittedSeq: data.admittedSeq,
    promotedSeq: data.promotedSeq,
    observedAtMs,
  };
}

export async function isAuthoritativeClientRejection(
  response: unknown,
  aborted: boolean,
  expected: ClientRejectionCorrelation,
): Promise<boolean> {
  if (aborted) return false;
  const envelope = snapshotExactData(response, ["error", "request", "response"]);
  if (
    !envelope ||
    envelope.error === undefined ||
    !(await matchesRequest(envelope.request, expected))
  )
    return false;
  const status = supportedRejectionStatus(envelope.response);
  if (status === undefined) return false;
  const allowed =
    status === 400
      ? ["_tag", "message", "kind", "field"]
      : status === 404
        ? ["_tag", "sessionID", "message"]
        : ["_tag", "message"];
  const error = snapshotExactData(envelope.error, allowed);
  if (!error || !boundedString(error.message)) return false;
  if (status === 400) {
    if (error._tag !== "InvalidRequestError") return false;
    for (const optional of ["kind", "field"]) {
      if (Object.hasOwn(error, optional) && !boundedString(error[optional], 256)) return false;
    }
    return true;
  }
  if (status === 401) return error._tag === "UnauthorizedError";
  return (
    error._tag === "SessionNotFoundError" &&
    expected.targetSessionId !== undefined &&
    error.sessionID === expected.targetSessionId
  );
}
