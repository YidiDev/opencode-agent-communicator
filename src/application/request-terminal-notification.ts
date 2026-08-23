import { validateRequestId } from "../domain/generated-ids";
import { validateRetainedRequestResult } from "../domain/request-content";
import type {
  RequestMetadata,
  RequestResolutionState,
  RetainedRequestResult,
} from "../domain/request-types";
import { requestKinds, requestResolutionStates } from "../domain/request-types";
import { observeNativePromiseRejection } from "./native-promise-observation";
import type {
  CommittedRequestNotificationPort,
  CommittedRequestTerminalEvent,
} from "./request-notification-port";

function snapshotRetainedResult(result: RetainedRequestResult): RetainedRequestResult {
  if (result.kind === "wait") {
    return Object.freeze(
      result.evidence === undefined
        ? { kind: "wait" }
        : { kind: "wait", evidence: result.evidence },
    );
  }
  const answers: string[][] = [];
  for (let outer = 0; outer < result.answers.length; outer += 1) {
    const source = result.answers[outer];
    if (!source) continue;
    const answer: string[] = [];
    for (let inner = 0; inner < source.length; inner += 1) {
      const item = source[inner];
      if (item !== undefined) answer.push(item);
    }
    answers.push(Object.freeze(answer) as string[]);
  }
  return Object.freeze({ kind: "ask", answers: Object.freeze(answers) });
}

function dataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length) return undefined;
  if (
    keys.some(
      (key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)),
    )
  ) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (!required.every((key) => keys.includes(key))) return undefined;
  const snapshot: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function denseDataArray(value: unknown, maximumLength: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximumLength + 1) return undefined;
  if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)) return undefined;
  const rawLength: unknown = lengthDescriptor.value;
  if (
    typeof rawLength !== "number" ||
    !Number.isSafeInteger(rawLength) ||
    rawLength < 0 ||
    rawLength > maximumLength
  ) {
    return undefined;
  }
  const length = rawLength;
  if (
    keys.some(
      (key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)),
    ) ||
    keys.length !== length + 1
  ) {
    return undefined;
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function safeRetainedResult(value: unknown): RetainedRequestResult | undefined {
  const result = dataRecord(value, ["kind"], ["answers", "evidence"]);
  if (!result) return undefined;
  let candidate: unknown;
  if (result.kind === "ask") {
    const outer = denseDataArray(result.answers, 10);
    if (!outer) return undefined;
    const answers: unknown[][] = [];
    for (const entry of outer) {
      const answer = denseDataArray(entry, 20);
      if (!answer) return undefined;
      answers.push(answer);
    }
    candidate = { kind: "ask", answers };
  } else if (result.kind === "wait") {
    candidate = Object.hasOwn(result, "evidence")
      ? { kind: "wait", evidence: result.evidence }
      : { kind: "wait" };
  } else {
    return undefined;
  }
  const validated = validateRetainedRequestResult(candidate);
  return validated.ok ? snapshotRetainedResult(validated.value) : undefined;
}

/**
 * Copies an untrusted notification through a strict data-only boundary. Blocking consumers must
 * always re-read durable state after a reconcile wake; this snapshot is only an acceleration hint.
 */
export function snapshotCommittedRequestTerminalEvent(
  value: unknown,
): CommittedRequestTerminalEvent | undefined {
  try {
    const event = dataRecord(
      value,
      ["requestId", "kind", "resolutionState", "resolvedAtMs"],
      ["retainedResult"],
    );
    if (!event) return undefined;
    const requestId = validateRequestId(event.requestId);
    if (
      !requestId.ok ||
      !requestKinds.includes(event.kind as never) ||
      !requestResolutionStates.includes(event.resolutionState as never) ||
      event.resolutionState === "pending" ||
      !Number.isSafeInteger(event.resolvedAtMs) ||
      (event.resolvedAtMs as number) < 0
    ) {
      return undefined;
    }
    const kind = event.kind as "ask" | "wait";
    const resolutionState = event.resolutionState as Exclude<RequestResolutionState, "pending">;
    if (resolutionState === "answered" && kind !== "ask") return undefined;
    if (resolutionState === "reached" && kind !== "wait") return undefined;
    let retainedResult: RetainedRequestResult | undefined;
    if (Object.hasOwn(event, "retainedResult")) {
      if (resolutionState !== "answered" && resolutionState !== "reached") return undefined;
      retainedResult = safeRetainedResult(event.retainedResult);
      if (!retainedResult || retainedResult.kind !== kind) return undefined;
    }
    return Object.freeze({
      requestId: requestId.value,
      kind,
      resolutionState,
      resolvedAtMs: event.resolvedAtMs as number,
      ...(retainedResult === undefined ? {} : { retainedResult }),
    });
  } catch {
    return undefined;
  }
}

export function createTerminalNotificationEvent(
  request: RequestMetadata & {
    readonly resolutionState: Exclude<RequestResolutionState, "pending">;
  },
  result?: RetainedRequestResult,
): CommittedRequestTerminalEvent {
  const event = {
    requestId: request.id,
    kind: request.kind,
    resolutionState: request.resolutionState,
    resolvedAtMs: request.resolvedAtMs,
    ...(result === undefined ? {} : { retainedResult: snapshotRetainedResult(result) }),
  };
  return Object.freeze(event);
}

export function notifyTerminalSafely(
  notifications: CommittedRequestNotificationPort,
  event: CommittedRequestTerminalEvent,
): void {
  try {
    const returned: unknown = notifications.notifyTerminal(event);
    if (returned !== undefined) observeNativePromiseRejection(returned);
  } catch {
    // Notification is only an optimization; a faulty observer cannot affect durable outcomes.
  }
}
