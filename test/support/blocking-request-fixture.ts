import { ContextAdmissionRuntime } from "../../src/application/context-admission-runtime";
import type { NativeQueueAdmissionPort } from "../../src/application/delivery-ports";
import { ParticipantOperationGate } from "../../src/application/participant-operation-gate";
import { RequestRuntime } from "../../src/application/request-runtime";
import { createGeneratedIdFactory } from "../../src/domain/generated-ids";
import {
  openRequestStore,
  requestDigestPort,
  requestSession,
  requestTestWorkspace,
} from "./request-store";

export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export async function blockingRequestFixture(native: NativeQueueAdmissionPort["queueMessage"]) {
  const store = openRequestStore();
  const token = await store.acquire();
  const runtime = new RequestRuntime();
  const contextRuntime = new ContextAdmissionRuntime();
  const participantOperations = new ParticipantOperationGate();
  const source = requestSession("ses_source");
  const target = requestSession("ses_target");
  let byte = 1;
  const ids = createGeneratedIdFactory({
    randomBytes: (length) => {
      const output = new Uint8Array(length);
      output.fill(byte++);
      return output;
    },
  });
  const ready = { assertReady: () => undefined };
  const clock = { nowMs: () => 25_000 };
  const membership = {
    readCurrentRoots: async () => ({
      sourceTitle: undefined,
      sourceVisible: true,
      targetVisible: true,
    }),
  };
  return {
    store,
    token,
    runtime,
    contextRuntime,
    source,
    target,
    context: {
      workspaceKey: requestTestWorkspace(),
      sourceSessionId: source,
      fencingToken: token,
      abort: new AbortController().signal,
      deadlineMs: 90_000,
    },
    ports: {
      readiness: ready,
      membership,
      activity: {
        observeRequestParticipants: async () => ({
          sourceVisible: true,
          targetVisible: true,
          targetStatus: "busy" as const,
        }),
      },
      authorization: { authorizeRequest: async () => ({ kind: "allow" as const }) },
      requests: store,
      nativeSteer: {
        steerRequest: async () => {
          throw new Error("blocking requests must use native queue admission");
        },
      },
      nativeQueue: { queueMessage: native },
      ownership: store,
      notifications: runtime,
      runtime,
      contextRuntime,
      contexts: store,
      participantOperations,
      scheduler: { wake: () => undefined },
      deadlineTimer: {
        arm: (delayMs: number, wake: () => void) => {
          const handle = setTimeout(wake, delayMs);
          return { cancel: () => clearTimeout(handle) };
        },
      },
      workflowFault: { fault: () => undefined },
      clock,
      ids,
      digest: requestDigestPort,
    },
    mutationPorts: {
      readiness: ready,
      membership,
      clock,
      digest: requestDigestPort,
      requests: store,
      notifications: runtime,
    },
  };
}

export function requestIdFromEnvelope(envelope: string): string {
  const value: unknown = JSON.parse(envelope);
  if (typeof value !== "object" || value === null || !("request_id" in value)) {
    throw new Error("missing request ID");
  }
  return String(value.request_id);
}
