import { describe, expect, test } from "bun:test";
import { ContextAdmissionRuntime } from "../../../src/application/context-admission-runtime";
import {
  createImmediateSessionRequest,
  type ImmediateSessionRequestPorts,
} from "../../../src/application/create-immediate-session-request";
import { ParticipantOperationAbortedFault } from "../../../src/application/participant-operation-gate";
import type {
  PrepareRequestInput,
  RequestStoreResult,
} from "../../../src/application/request-ports";
import type { ContextAdmissionMetadata } from "../../../src/domain/context-admissions";
import {
  validateNativeMessageId,
  validateRequestId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";
import { OwnershipLostFault, validateFencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

function required<Value>(candidate: Value | undefined): Value {
  if (candidate === undefined) throw new Error("missing fixture state");
  return candidate;
}

const workspaceKey = value(validateWorkspaceKey("workspace:immediate-unit"));
const sourceSessionId = value(validateSessionId("ses_source"));
const targetSessionId = value(validateSessionId("ses_target"));
const token = value(validateFencingToken(31));
const requestId = value(validateRequestId(`req_${"1".repeat(32)}`));
const nativeMessageId = value(validateNativeMessageId(`msg_${"2".repeat(32)}`));
const creationOperationId = value(validateStartOperationId(`op_${"3".repeat(32)}`));
const waitRequest = { kind: "wait" as const, milestone: "ready", timeoutSeconds: 30 };

interface Fixture {
  ports: ImmediateSessionRequestPorts;
  messageDecision: "allow" | "deny" | "approval_rejected";
  requestDecision: "allow" | "deny" | "approval_rejected";
  memberships: Array<{ sourceVisible: boolean; targetVisible: boolean }>;
  owner: boolean;
  targetStatus: "busy" | "retry" | "idle" | "unknown";
  admissionState: "context_admitted" | "failed" | "cancelled";
  attachThrows: boolean;
  abortAfterCreate?: () => void;
  createResult?: RequestStoreResult;
  contextReadThrows: boolean;
  requestMetadataMissing: boolean;
  lifecycleStops: number;
  readonly events: string[];
  readonly prepared: PrepareRequestInput[];
  readonly controls: Array<{ abort: AbortSignal; deadlineMs?: number }>;
  readonly nativeCalls: string[];
}

function fixture(): Fixture {
  const result = {
    messageDecision: "allow" as const,
    requestDecision: "allow" as const,
    memberships: [
      { sourceVisible: true, targetVisible: true },
      { sourceVisible: true, targetVisible: true },
    ],
    owner: true,
    targetStatus: "busy" as const,
    admissionState: "context_admitted" as const,
    attachThrows: false,
    contextReadThrows: false,
    requestMetadataMissing: false,
    lifecycleStops: 0,
    events: [] as string[],
    prepared: [] as PrepareRequestInput[],
    controls: [] as Array<{ abort: AbortSignal; deadlineMs?: number }>,
    nativeCalls: [] as string[],
  } as Fixture;
  const admission = (): ContextAdmissionMetadata => {
    const prepared = required(result.prepared[0]);
    const state = result.admissionState;
    return {
      id: prepared.request.id,
      kind: "request",
      workspaceKey,
      sourceSessionId,
      targetSessionId,
      state,
      contentByteLength: required(prepared.contextAdmission).contentByteLength,
      contentSha256: "ab".repeat(32),
      createdAtMs: 10_000,
      updatedAtMs: 10_002,
      awaitingContextAtMs: 10_001,
      ...(state === "context_admitted"
        ? { contextAdmittedAtMs: 10_002, claimedFencingToken: token }
        : {}),
      ...(state === "failed" ? { failedAtMs: 10_002 } : {}),
      ...(state === "cancelled" ? { cancelledAtMs: 10_002 } : {}),
    };
  };
  result.ports = {
    readiness: {
      fencingToken: token,
      assertReady() {},
      ownershipLost() {
        result.lifecycleStops += 1;
      },
    },
    membership: {
      async readCurrentRoots() {
        result.events.push("visibility");
        const visible = result.memberships.shift();
        if (!visible) throw new Error("missing membership fixture");
        return { ...visible, sourceTitle: undefined };
      },
    },
    messageAuthorization: {
      async authorizeMessage(_binding, control) {
        result.events.push("message-authorization");
        result.controls.push(control);
        return { kind: result.messageDecision };
      },
    },
    requestAuthorization: {
      async authorizeRequest(_binding, control) {
        result.events.push("request-authorization");
        result.controls.push(control);
        return { kind: result.requestDecision };
      },
    },
    requests: {
      async createPrepared(input: PrepareRequestInput) {
        result.events.push("prepared");
        result.prepared.push(input);
        result.abortAfterCreate?.();
        return result.createResult ?? { ok: true, request: input.request };
      },
      async getRequestMetadata() {
        result.events.push("request-read");
        if (result.requestMetadataMissing) return undefined;
        const request = required(result.prepared[0]).request;
        if (result.admissionState !== "context_admitted") {
          const { payloadSha256: _payloadSha256, ...terminal } = request;
          return {
            ...terminal,
            deliveryState: "delivery_failed",
            resolutionState: result.admissionState === "failed" ? "delivery_failed" : "cancelled",
            updatedAtMs: 10_002,
            awaitingContextAtMs: 10_001,
            deliveryFailedAtMs: 10_002,
            resolvedAtMs: 10_002,
          } as RequestMetadata;
        }
        return {
          ...request,
          deliveryState: "context_admitted",
          updatedAtMs: 10_002,
          contextAdmittedAtMs: 10_002,
        } as RequestMetadata;
      },
    } as unknown as ImmediateSessionRequestPorts["requests"],
    scheduler: {
      wake() {
        result.events.push("scheduler-wake");
      },
    },
    nativeQueue: {
      async queueMessage(input) {
        result.nativeCalls.push(input.envelope);
        return { kind: "unknown" };
      },
    },
    contexts: {
      async getContextAdmission() {
        result.events.push("context-read");
        if (result.contextReadThrows) throw new Error("context store unavailable");
        return admission();
      },
      async cancelContextAdmission() {
        result.events.push("context-cancel");
        result.admissionState = "cancelled";
        return { ok: true, admission: admission() };
      },
    } as unknown as NonNullable<ImmediateSessionRequestPorts["contexts"]>,
    contextRuntime: {
      effectSignal: new AbortController().signal,
      attach() {
        result.events.push("context-attach");
        if (result.attachThrows) throw new RangeError("waiter capacity");
        let attached = true;
        return {
          outcome: Promise.resolve({
            outcome: "settled" as const,
            event: { id: requestId, kind: "request" as const, state: result.admissionState },
          }),
          detach() {
            if (!attached) return;
            attached = false;
            result.events.push("context-detach");
          },
        };
      },
      notifyContextSettled() {
        return undefined;
      },
    },
    activity: {
      async observeRequestParticipants() {
        result.events.push("activity");
        return {
          sourceVisible: result.memberships[1]?.sourceVisible ?? true,
          targetVisible: result.memberships[1]?.targetVisible ?? true,
          targetStatus: result.targetStatus,
        };
      },
    },
    participantOperations: {
      async run(_participants, _abort, operation) {
        result.events.push("participant-gate");
        return operation();
      },
    },
    ownership: { acquire: async () => token, isCurrent: async () => result.owner },
    clock: { nowMs: () => 10_000 },
    ids: {
      requestId: () => requestId,
      nativeMessageId: () => nativeMessageId,
      startOperationId: () => creationOperationId,
    } as ImmediateSessionRequestPorts["ids"],
    digest: { sha256: async () => new Uint8Array(32).fill(0xab) },
  };
  return result;
}

function context(controller = new AbortController()) {
  return {
    workspaceKey,
    sourceSessionId,
    fencingToken: token,
    abort: controller.signal,
    deadlineMs: 44_000,
  };
}

const args = { session_id: targetSessionId, content: "Perform the work.", request: waitRequest };

function visibleThenAbort(controller: AbortController) {
  return {
    sourceVisible: true,
    get targetVisible() {
      queueMicrotask(() =>
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => controller.abort()))),
      );
      return true;
    },
  };
}

function allowThenAbort(controller: AbortController): { readonly kind: "allow" } {
  return new Proxy(
    { kind: "allow" as const },
    {
      ownKeys(target) {
        controller.abort();
        return Reflect.ownKeys(target);
      },
    },
  );
}

describe("createImmediateSessionRequest authorization and visibility", () => {
  test.each([
    ["message", "deny", "permission_denied"],
    ["message", "approval_rejected", "approval_rejected"],
    ["request", "deny", "permission_denied"],
    ["request", "approval_rejected", "approval_rejected"],
  ] as const)(
    "maps %s policy %s before durable or native effects",
    async (port, decision, code) => {
      const current = fixture();
      if (port === "message") current.messageDecision = decision;
      else current.requestDecision = decision;
      const invocation = context();

      expect(await createImmediateSessionRequest(current.ports, invocation, args)).toMatchObject({
        ok: false,
        error: { code },
      });
      expect(current.prepared).toEqual([]);
      expect(current.nativeCalls).toEqual([]);
      expect(current.controls).toEqual(
        Array.from({ length: port === "message" ? 1 : 2 }, () => ({
          abort: invocation.abort,
          deadlineMs: invocation.deadlineMs,
        })),
      );
    },
  );

  test.each([
    [{ sourceVisible: false, targetVisible: true }, "caller_not_visible"],
    [{ sourceVisible: true, targetVisible: false }, "target_not_visible"],
  ] as const)("rejects initial hidden participants with %s", async (membership, code) => {
    const current = fixture();
    current.memberships = [membership];
    expect(await createImmediateSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(current.events).toEqual(["visibility"]);
  });

  test("revalidates visibility after both authorization decisions", async () => {
    const current = fixture();
    current.memberships[1] = { sourceVisible: true, targetVisible: false };
    expect(await createImmediateSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "target_not_visible" },
    });
    expect(current.events).toEqual([
      "visibility",
      "message-authorization",
      "request-authorization",
      "visibility",
    ]);
  });
});

describe("createImmediateSessionRequest durable admission", () => {
  test("persists one linked envelope and returns after durable context admission", async () => {
    const current = fixture();
    const result = await createImmediateSessionRequest(current.ports, context(), args);
    expect(result).toMatchObject({
      ok: true,
      value: {
        id: requestId,
        nativeMessageId,
        deliveryMode: "context",
        deliveryState: "context_admitted",
      },
    });
    expect(current.events).toEqual([
      "visibility",
      "message-authorization",
      "request-authorization",
      "visibility",
      "context-attach",
      "participant-gate",
      "activity",
      "prepared",
      "scheduler-wake",
      "context-read",
      "context-read",
      "context-detach",
      "request-read",
    ]);
    expect(current.prepared[0]).toMatchObject({
      creationOperationId,
      deliveryMode: "context",
      request: { id: requestId, deadlineAtMs: 40_000 },
      contextAdmission: { requestId },
    });
    const envelope = JSON.parse(required(current.prepared[0]).envelopeJson);
    expect(envelope).toMatchObject({
      request_id: requestId,
      source_session_id: sourceSessionId,
      target_session_id: targetSessionId,
      work: { content: args.content },
    });
    expect(current.nativeCalls).toEqual([]);
  });

  test.each([
    ["failed", "delivery_failed"],
    ["cancelled", "request_cancelled"],
  ] as const)("maps durable context state %s to %s", async (state, code) => {
    const current = fixture();
    current.admissionState = state;
    expect(await createImmediateSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(current.nativeCalls).toEqual([]);
  });

  test("rejects bounded context waiter exhaustion before persistence", async () => {
    const current = fixture();
    current.attachThrows = true;
    expect(await createImmediateSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "quota_exceeded" },
    });
    expect(current.prepared).toEqual([]);
    expect(current.nativeCalls).toEqual([]);
  });

  test("fails before persistence when aborted or ownership is stale", async () => {
    const aborted = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await createImmediateSessionRequest(aborted.ports, context(controller), args),
    ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
    expect(aborted.events).toEqual([]);

    const stale = fixture();
    stale.owner = false;
    expect(await createImmediateSessionRequest(stale.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });
    expect(stale.prepared).toEqual([]);
    expect(stale.nativeCalls).toEqual([]);
    expect(stale.lifecycleStops).toBe(1);
  });

  test.each(["returned", "thrown"] as const)(
    "preserves %s prepared-context ownership loss and stops immediately",
    async (fault) => {
      const current = fixture();
      current.ports.requests.createPrepared = async () => {
        if (fault === "thrown") throw new OwnershipLostFault();
        return { ok: false, code: "ownership_lost" };
      };
      expect(await createImmediateSessionRequest(current.ports, context(), args)).toMatchObject({
        ok: false,
        error: { code: "ownership_lost" },
      });
      expect(current.lifecycleStops).toBe(1);
      expect(current.events).not.toContain("context-read");
    },
  );

  test("preserves a thrown context read ownership fault and stops before admission wait", async () => {
    const current = fixture();
    const contexts = current.ports.contexts;
    if (!contexts) throw new Error("missing context fixture");
    contexts.getContextAdmission = async () => {
      throw new OwnershipLostFault();
    };
    expect(await createImmediateSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });
    expect(current.lifecycleStops).toBe(1);
    expect(current.events.filter((event) => event === "context-read")).toHaveLength(0);
  });

  test("an already-expired invocation deadline never persists or admits context", async () => {
    const current = fixture();
    expect(
      await createImmediateSessionRequest(
        current.ports,
        { ...context(), deadlineMs: 10_000 },
        args,
      ),
    ).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
    expect(current.prepared).toEqual([]);
    expect(current.nativeCalls).toEqual([]);
  });

  test("rejects a combined envelope overflow before persistence", async () => {
    const current = fixture();
    const result = await createImmediateSessionRequest(current.ports, context(), {
      session_id: targetSessionId,
      content: "w".repeat(32 * 1_024),
      request: {
        kind: "ask",
        questions: Array.from({ length: 4 }, (_, index) => ({
          prompt: `${index}${"q".repeat(7_999)}`,
          options: [],
          multiple: false,
          allowCustom: true,
        })),
        timeoutSeconds: 30,
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments", message: expect.stringContaining("envelope limit") },
    });
    expect(current.prepared).toEqual([]);
  });

  test.each([
    ["quota_exceeded", "quota_exceeded", false],
    ["rate_limited", "rate_limited", true],
    ["storage_unavailable", "storage_unavailable", true],
  ] as const)(
    "maps prepare failure %s without waiting for context",
    async (stored, code, retryable) => {
      const current = fixture();
      current.createResult = { ok: false, code: stored };
      expect(await createImmediateSessionRequest(current.ports, context(), args)).toMatchObject({
        ok: false,
        error: { code, retryable },
      });
      expect(current.events).not.toContain("context-read");
      expect(current.nativeCalls).toEqual([]);
    },
  );
});

describe("createImmediateSessionRequest fail-closed boundaries", () => {
  test("maps unavailable membership and invalid payloads", async () => {
    const unavailable = fixture();
    unavailable.ports.membership.readCurrentRoots = async () => {
      throw new Error("membership unavailable");
    };
    expect(await createImmediateSessionRequest(unavailable.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "native_unavailable" },
    });

    const invalid = fixture();
    expect(
      await createImmediateSessionRequest(invalid.ports, context(), {
        ...args,
        request: { ...waitRequest, timeoutSeconds: 0 },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  test("maps unavailable membership during final visibility revalidation", async () => {
    const current = fixture();
    let calls = 0;
    current.ports.membership.readCurrentRoots = async () => {
      calls += 1;
      if (calls > 1) throw new Error("membership unavailable");
      return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
    };

    expect(await createImmediateSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "native_unavailable" },
    });
    expect(current.prepared).toEqual([]);
  });

  test.each([
    "initial visibility",
    "message authorization",
    "request authorization",
    "final visibility",
  ] as const)("rechecks cancellation after settled %s", async (boundary) => {
    const current = fixture();
    const controller = new AbortController();
    if (boundary === "initial visibility") {
      current.memberships = [visibleThenAbort(controller)];
    } else if (boundary === "message authorization") {
      current.ports.messageAuthorization.authorizeMessage = async () => allowThenAbort(controller);
    } else if (boundary === "request authorization") {
      current.ports.requestAuthorization.authorizeRequest = async () => allowThenAbort(controller);
    } else {
      current.memberships[1] = visibleThenAbort(controller);
    }

    expect(
      await createImmediateSessionRequest(current.ports, context(controller), args),
    ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
    expect(current.prepared).toEqual([]);
  });

  test("maps digest failure and an unsafe request deadline", async () => {
    const digestFailure = fixture();
    let digestCalls = 0;
    digestFailure.ports.digest.sha256 = async () => {
      digestCalls += 1;
      if (digestCalls > 1) throw new Error("digest unavailable");
      return new Uint8Array(32).fill(0xab);
    };
    expect(await createImmediateSessionRequest(digestFailure.ports, context(), args)).toMatchObject(
      { ok: false, error: { code: "storage_unavailable" } },
    );

    const unsafeDeadline = fixture();
    unsafeDeadline.ports.clock.nowMs = () => Number.MAX_SAFE_INTEGER - 10_000;
    expect(
      await createImmediateSessionRequest(
        unsafeDeadline.ports,
        { ...context(), deadlineMs: Number.MAX_SAFE_INTEGER },
        args,
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  test.each(["message", "request"] as const)(
    "fails closed when %s authorization throws or is malformed",
    async (boundary) => {
      const rejected = fixture();
      const malformed = fixture();
      if (boundary === "message") {
        rejected.ports.messageAuthorization.authorizeMessage = async () => {
          throw new Error("authorization unavailable");
        };
        malformed.ports.messageAuthorization.authorizeMessage = async () => ({}) as never;
      } else {
        rejected.ports.requestAuthorization.authorizeRequest = async () => {
          throw new Error("authorization unavailable");
        };
        malformed.ports.requestAuthorization.authorizeRequest = async () => ({}) as never;
      }
      expect(await createImmediateSessionRequest(rejected.ports, context(), args)).toMatchObject({
        ok: false,
        error: { code: "storage_unavailable" },
      });
      expect(await createImmediateSessionRequest(malformed.ports, context(), args)).toMatchObject({
        ok: false,
        error: { code: "storage_unavailable" },
      });
    },
  );

  test.each(["message", "request"] as const)(
    "honors cancellation during %s authorization",
    async (boundary) => {
      const current = fixture();
      const controller = new AbortController();
      if (boundary === "message") {
        current.ports.messageAuthorization.authorizeMessage = async () => {
          controller.abort();
          return { kind: "allow" };
        };
      } else {
        current.ports.requestAuthorization.authorizeRequest = async () => {
          controller.abort();
          return { kind: "allow" };
        };
      }
      expect(
        await createImmediateSessionRequest(current.ports, context(controller), args),
      ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
      expect(current.prepared).toEqual([]);
    },
  );
});

describe("createImmediateSessionRequest storage and admission boundaries", () => {
  test.each(["context", "request"] as const)("bounds a never-settling %s read", async (read) => {
    const current = fixture();
    if (read === "context") {
      current.ports = {
        ...current.ports,
        contexts: {
          ...current.ports.contexts,
          getContextAdmission: () => new Promise(() => {}),
        } as NonNullable<ImmediateSessionRequestPorts["contexts"]>,
      };
    } else {
      current.ports = {
        ...current.ports,
        requests: {
          ...current.ports.requests,
          getRequestMetadata: () => new Promise(() => {}),
        } as ImmediateSessionRequestPorts["requests"],
      };
    }
    expect(
      await createImmediateSessionRequest(
        current.ports,
        { ...context(), deadlineMs: 10_100 },
        args,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable", details: { request_id: requestId } },
    });
    expect(current.events).toContain("context-detach");
  });

  test("reclaims waiter capacity after persistence rejection", async () => {
    const current = fixture();
    current.ports.membership.readCurrentRoots = async () => ({
      sourceVisible: true,
      targetVisible: true,
      sourceTitle: undefined,
    });
    current.ports = { ...current.ports, contextRuntime: new ContextAdmissionRuntime(1) };
    current.ports.requests.createPrepared = async () => {
      throw new Error("storage unavailable");
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await createImmediateSessionRequest(current.ports, context(), args)).toMatchObject({
        ok: false,
        error: { code: "storage_unavailable" },
      });
    }
  });

  test("detaches and preserves interruption when the participant gate aborts", async () => {
    const current = fixture();
    current.ports = {
      ...current.ports,
      participantOperations: {
        run: async () => {
          throw new ParticipantOperationAbortedFault("aborted");
        },
      },
    };
    expect(await createImmediateSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "deadline_expired" },
    });
    expect(current.events).toContain("context-detach");
  });

  test("maps persistence, context-read, and final metadata failures", async () => {
    const persistence = fixture();
    persistence.ports.requests.createPrepared = async () => {
      throw new Error("storage unavailable");
    };
    expect(await createImmediateSessionRequest(persistence.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    expect(persistence.events).toContain("context-detach");

    const contextRead = fixture();
    contextRead.contextReadThrows = true;
    expect(await createImmediateSessionRequest(contextRead.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    expect(contextRead.events).toContain("context-detach");

    const metadata = fixture();
    metadata.requestMetadataMissing = true;
    expect(await createImmediateSessionRequest(metadata.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable", details: { request_id: requestId } },
    });
  });

  test.each(["ownership", "digest", "final visibility"] as const)(
    "honors cancellation after %s",
    async (boundary) => {
      const current = fixture();
      const controller = new AbortController();
      if (boundary === "ownership") {
        current.ports.ownership.isCurrent = async () => {
          controller.abort();
          return true;
        };
      } else if (boundary === "digest") {
        let calls = 0;
        current.ports.digest.sha256 = async () => {
          calls += 1;
          if (calls > 1) controller.abort();
          return new Uint8Array(32).fill(0xab);
        };
      } else {
        let calls = 0;
        current.ports.membership.readCurrentRoots = async () => {
          calls += 1;
          if (calls > 1) controller.abort();
          return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
        };
      }
      expect(
        await createImmediateSessionRequest(current.ports, context(controller), args),
      ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
      expect(current.nativeCalls).toEqual([]);
    },
  );

  test.each(["idle", "unknown"] as const)(
    "rejects target activity %s before persistence",
    async (status) => {
      const current = fixture();
      current.targetStatus = status;
      expect(await createImmediateSessionRequest(current.ports, context(), args)).toMatchObject({
        ok: false,
        error: { code: status === "idle" ? "target_idle" : "target_status_unknown" },
      });
      expect(current.prepared).toEqual([]);
      expect(current.nativeCalls).toEqual([]);
    },
  );
});
