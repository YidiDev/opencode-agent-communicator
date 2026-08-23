import type {
  RequestMetadata,
  RequestResolutionState,
  RetainedRequestResult,
} from "../domain/request-types";
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

function observeNativePromiseRejection(value: unknown): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
  let constructorDescriptor: PropertyDescriptor | undefined;
  let removedConstructor = false;
  try {
    constructorDescriptor = Object.getOwnPropertyDescriptor(value, "constructor");
    if (constructorDescriptor?.configurable) {
      removedConstructor = Reflect.deleteProperty(value, "constructor");
    }
    void Promise.prototype.then.call(value, undefined, () => undefined);
  } catch {
    // Non-native thenables are handled by fresh assimilation below.
  } finally {
    if (removedConstructor && constructorDescriptor) {
      try {
        Object.defineProperty(value, "constructor", constructorDescriptor);
      } catch {
        // A hostile value cannot affect the already committed operation.
      }
    }
  }
}

export function notifyTerminalSafely(
  notifications: CommittedRequestNotificationPort,
  event: CommittedRequestTerminalEvent,
): void {
  try {
    const returned: unknown = notifications.notifyTerminal(event);
    if (returned !== undefined) {
      observeNativePromiseRejection(returned);
      const observed = new Promise<unknown>((resolve) => resolve(returned));
      void Promise.prototype.then.call(observed, undefined, () => undefined);
    }
  } catch {
    // Notification is only an optimization; a faulty observer cannot affect durable outcomes.
  }
}
