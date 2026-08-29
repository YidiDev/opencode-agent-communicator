import { describe, expect, test } from "bun:test";
import type {
  CompleteRequestDeliveryInput,
  PrepareRequestInput,
} from "../../../src/application/request-ports";
import type { PrepareSessionRequestStartInput } from "../../../src/application/session-start-ports";
import {
  type SessionRequestStartPorts,
  startSessionRequest,
} from "../../../src/application/start-session-request";
import {
  validateManagedSessionId,
  validateNativeMessageId,
  validateRequestId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";
import { OwnershipLostFault, validateFencingToken } from "../../../src/domain/ownership";
import { isCoherentRequestMetadata } from "../../../src/domain/request-metadata";
import type { RequestMetadata } from "../../../src/domain/request-types";
import type { StartOperation, ValidatedStartArguments } from "../../../src/domain/session-start";
import { createSessionStartPolicy } from "../../../src/domain/session-start-policy";
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

const workspaceKey = value(validateWorkspaceKey("workspace:start-request-unit"));
const sourceSessionId = value(validateSessionId("ses_source"));
const operationId = value(validateStartOperationId(`op_${"4".repeat(32)}`));
const requestId = value(validateRequestId(`req_${"4".repeat(32)}`));
const sessionId = value(validateManagedSessionId(`ses_${"5".repeat(32)}`));
const nativeMessageId = value(validateNativeMessageId(`msg_${"6".repeat(32)}`));
const token = value(validateFencingToken(37));
const args = {
  idempotency_key: "request-start-unit",
  initial_message: "Build the artifact.",
  request: { kind: "wait" as const, milestone: "artifact ready", timeoutSeconds: 30 },
};

function transitionOperation(
  operation: StartOperation,
  changes: Partial<StartOperation>,
): StartOperation {
  return { ...operation, ...changes, updatedAtMs: operation.updatedAtMs + 1 };
}

function submitting(request: RequestMetadata): RequestMetadata {
  return {
    ...request,
    deliveryState: "submitting",
    submittedAtMs: request.createdAtMs,
  } as RequestMetadata;
}

function settledRequest(
  request: RequestMetadata,
  input: CompleteRequestDeliveryInput,
): RequestMetadata {
  if (input.outcome === "delivery_failed") {
    const { payloadSha256: _payloadSha256, ...base } = request as RequestMetadata & {
      payloadSha256?: string;
    };
    return {
      ...base,
      deliveryState: "delivery_failed",
      resolutionState: "delivery_failed",
      updatedAtMs: request.updatedAtMs,
      submittedAtMs: "submittedAtMs" in request ? request.submittedAtMs : request.createdAtMs,
      deliveryFailedAtMs: request.updatedAtMs,
      resolvedAtMs: request.updatedAtMs,
    } as RequestMetadata;
  }
  if (input.outcome === "delivery_unknown") {
    return {
      ...request,
      deliveryState: "delivery_unknown",
      updatedAtMs: request.updatedAtMs,
      deliveryUnknownAtMs: request.updatedAtMs,
    } as RequestMetadata;
  }
  return {
    ...request,
    deliveryState: input.outcome,
    updatedAtMs: input.evidenceObservedAtMs,
    admittedAtMs: input.evidenceObservedAtMs,
    ...(input.outcome === "promoted" ? { promotedAtMs: input.evidenceObservedAtMs } : {}),
    admissionEvidence:
      input.outcome === "promoted"
        ? {
            state: "promoted",
            nativeMessageId: input.nativeMessageId,
            admittedSeq: input.admittedSeq,
            promotedSeq: input.promotedSeq,
            observedAtMs: input.evidenceObservedAtMs,
          }
        : {
            state: "admitted",
            nativeMessageId: input.nativeMessageId,
            admittedSeq: input.admittedSeq,
            observedAtMs: input.evidenceObservedAtMs,
          },
  } as RequestMetadata;
}

interface Fixture {
  ports: SessionRequestStartPorts;
  operation?: StartOperation;
  request?: RequestMetadata;
  startArguments?: ValidatedStartArguments;
  requestDecision: "allow" | "deny" | "approval_rejected";
  approval: "approved" | "rejected";
  nativeAdmission: "admitted" | "definitive_rejection" | "unknown";
  visible: boolean;
  owner: boolean;
  completionFails: boolean;
  compositeFailure?: "idempotency_conflict" | "quota_exceeded" | "deadlock_detected";
  readonly events: string[];
  readonly composites: PrepareSessionRequestStartInput[];
  readonly preparedRequests: PrepareRequestInput[];
  readonly completions: CompleteRequestDeliveryInput[];
  readonly initialMessages: string[];
  readonly authorizationControls: Array<{ abort: AbortSignal; deadlineMs?: number }>;
}

function fixture(policyDecision: "allow" | "ask" | "deny" = "allow"): Fixture {
  let nowMs = 20_000;
  const current = {
    requestDecision: "allow" as const,
    approval: "approved" as const,
    nativeAdmission: "admitted" as const,
    visible: true,
    owner: true,
    completionFails: false,
    events: [] as string[],
    composites: [] as PrepareSessionRequestStartInput[],
    preparedRequests: [] as PrepareRequestInput[],
    completions: [] as CompleteRequestDeliveryInput[],
    initialMessages: [] as string[],
    authorizationControls: [] as Array<{ abort: AbortSignal; deadlineMs?: number }>,
  } as Fixture;

  current.ports = {
    readiness: { fencingToken: token, assertReady() {} },
    membership: {
      async readCurrentRoots() {
        current.events.push("visibility");
        return {
          sourceTitle: undefined,
          sourceVisible: current.visible,
          targetVisible: current.visible,
        };
      },
    },
    approval: {
      async requestStartApproval(_binding, control) {
        current.events.push("start-approval");
        current.authorizationControls.push(control);
        return current.approval;
      },
    },
    requestAuthorization: {
      async authorizeRequest(_binding, control) {
        current.events.push("request-authorization");
        current.authorizationControls.push(control);
        return { kind: current.requestDecision };
      },
    },
    requestStarts: {
      async readSessionRequestStart() {
        current.events.push("composite-read");
        return current.operation && current.request
          ? { ok: true, found: true, operation: current.operation, request: current.request }
          : { ok: true, found: false };
      },
      async createOrResumeSessionRequestStart(input) {
        current.events.push("composite-persisted");
        current.composites.push(input);
        current.preparedRequests.push(input.request);
        if (current.compositeFailure) return { ok: false, code: current.compositeFailure };
        if (!current.operation) {
          current.startArguments = input.start.arguments;
          current.operation = {
            id: input.start.operationId,
            workspaceKey: input.start.workspaceKey,
            sourceSessionId: input.start.sourceSessionId,
            idempotencyKey: input.start.arguments.idempotencyKey,
            argumentsSha256: input.start.argumentsSha256,
            sessionId: input.start.sessionId,
            nativeMessageId: input.start.nativeMessageId,
            creationState: "prepared",
            titleState: "not_started",
            admissionState: "not_started",
            createdAtMs: input.start.nowMs,
            updatedAtMs: input.start.nowMs,
          };
          current.request = input.request.request;
        }
        return {
          ok: true,
          operation: current.operation,
          request: required(current.request),
          idempotencyArgumentsSha256: required(input.start.idempotencyArgumentsSha256),
        };
      },
    },
    scheduler: {
      wake() {
        current.events.push("scheduler-wake");
      },
    },
    requests: {
      async claimPrepared() {
        current.events.push("request-claimed");
        current.request = submitting(required(current.request));
        return {
          ok: true,
          request: current.request as RequestMetadata & { deliveryState: "submitting" },
          envelopeJson: required(current.preparedRequests[0]).envelopeJson,
        };
      },
      async completeDelivery(input: CompleteRequestDeliveryInput) {
        current.events.push(`request-completed:${input.outcome}`);
        current.completions.push(input);
        if (current.completionFails) return { ok: false, code: "storage_unavailable" };
        current.request = settledRequest(required(current.request), input);
        return { ok: true, request: current.request };
      },
    } as unknown as SessionRequestStartPorts["requests"],
    starts: {
      async isManagedSession() {
        return false;
      },
      async claimStep(input: Parameters<SessionRequestStartPorts["starts"]["claimStep"]>[0]) {
        current.events.push(`start-claimed:${input.step}`);
        current.operation = transitionOperation(required(current.operation), {
          [`${input.step}State`]: "submitting",
        });
        return {
          ok: true,
          operation: current.operation,
          arguments: required(current.startArguments),
        };
      },
      async completeCreation(
        input: Parameters<SessionRequestStartPorts["starts"]["completeCreation"]>[0],
      ) {
        current.events.push(`creation-completed:${input.state}`);
        current.operation = transitionOperation(required(current.operation), {
          creationState: input.state,
          titleState: input.state === "created" ? "skipped" : "not_started",
          admissionState: input.state === "created" ? "prepared" : "not_started",
        });
        return { ok: true, operation: current.operation };
      },
      async completeAdmission(
        input: Parameters<SessionRequestStartPorts["starts"]["completeAdmission"]>[0],
      ) {
        current.events.push(`admission-completed:${input.state}`);
        current.operation = transitionOperation(required(current.operation), {
          admissionState: input.state,
        });
        return { ok: true, operation: current.operation };
      },
    } as unknown as SessionRequestStartPorts["starts"],
    nativeStart: {
      async createRootSession() {
        current.events.push("native-create");
        return "created";
      },
      async reconcileRootSession() {
        return "matching";
      },
      async updateSessionTitle() {
        return "updated";
      },
      async admitInitialMessage(
        input: Parameters<SessionRequestStartPorts["nativeStart"]["admitInitialMessage"]>[0],
      ) {
        current.events.push("native-admission");
        current.initialMessages.push(input.message);
        return current.nativeAdmission;
      },
    },
    ownership: { acquire: async () => token, isCurrent: async () => current.owner },
    clock: { nowMs: () => nowMs++ },
    ids: {
      startOperationId: () => operationId,
      managedSessionId: () => sessionId,
      nativeMessageId: () => nativeMessageId,
    } as SessionRequestStartPorts["ids"],
    digest: { sha256: async () => new Uint8Array(32).fill(0xab) },
    policy: createSessionStartPolicy({ decision: policyDecision }),
  };
  return current;
}

function context(controller = new AbortController(), deadlineMs = 50_000) {
  return {
    workspaceKey,
    sourceSessionId,
    fencingToken: token,
    abort: controller.signal,
    deadlineMs,
  };
}

describe("startSessionRequest policy and control boundaries", () => {
  test.each([
    ["deny", "permission_denied"],
    ["approval_rejected", "approval_rejected"],
  ] as const)(
    "maps request authorization %s before composite persistence",
    async (decision, code) => {
      const current = fixture();
      current.requestDecision = decision;
      const invocation = context();
      expect(await startSessionRequest(current.ports, invocation, args)).toMatchObject({
        ok: false,
        error: { code },
      });
      expect(current.composites).toEqual([]);
      expect(current.events).not.toContain("native-create");
      expect(current.authorizationControls).toEqual([
        { abort: expect.any(AbortSignal), deadlineMs: invocation.deadlineMs },
      ]);
    },
  );

  test.each([
    ["deny", "approved", "permission_denied"],
    ["ask", "rejected", "approval_rejected"],
  ] as const)(
    "maps composite start policy %s/%s before persistence",
    async (policy, approval, code) => {
      const current = fixture(policy);
      current.approval = approval;
      expect(await startSessionRequest(current.ports, context(), args)).toMatchObject({
        ok: false,
        error: { code },
      });
      expect(current.composites).toEqual([]);
      expect(current.events).not.toContain("native-create");
    },
  );

  test("fails closed for caller visibility, abort, deadline, and ownership", async () => {
    const hidden = fixture();
    hidden.visible = false;
    expect(await startSessionRequest(hidden.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "caller_not_visible" },
    });

    const controller = new AbortController();
    controller.abort();
    const aborted = fixture();
    expect(await startSessionRequest(aborted.ports, context(controller), args)).toMatchObject({
      ok: false,
      error: { code: "deadline_expired" },
    });

    const invalidDeadline = fixture();
    expect(
      await startSessionRequest(invalidDeadline.ports, context(undefined, -1), args),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });

    const stale = fixture();
    stale.owner = false;
    expect(await startSessionRequest(stale.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });
    expect(stale.composites).toEqual([]);
  });
});

describe("startSessionRequest linked durability and native outcomes", () => {
  test("atomically links IDs, admits the canonical envelope, and resumes idempotently", async () => {
    const current = fixture();
    const first = await startSessionRequest(current.ports, context(), args);
    expect(first).toMatchObject({
      ok: true,
      value: {
        operation: { id: operationId, admissionState: "admitted" },
        request: {
          id: requestId,
          linkedStartOperationId: operationId,
          targetSessionId: sessionId,
          nativeMessageId,
          deliveryMode: "initial",
          deliveryState: "admitted",
        },
      },
    });
    expect(current.composites).toHaveLength(1);
    expect(current.composites[0]).toMatchObject({
      start: { operationId, sessionId, nativeMessageId },
      request: {
        creationOperationId: operationId,
        linkedStartOperationId: operationId,
        request: { id: requestId, linkedStartOperationId: operationId },
      },
    });
    expect(current.initialMessages).toHaveLength(1);
    expect(JSON.parse(required(current.initialMessages[0]))).toMatchObject({
      request_id: requestId,
      work: { content: args.initial_message },
    });
    expect(isCoherentRequestMetadata(current.request)).toBe(true);

    const second = await startSessionRequest(current.ports, context(), args);
    expect(second).toMatchObject({
      ok: true,
      value: { operation: { id: operationId }, request: { id: requestId } },
    });
    expect(current.initialMessages).toHaveLength(1);
    expect(current.completions).toHaveLength(1);
    expect(current.events.filter((event) => event === "scheduler-wake")).toHaveLength(2);
  });

  test("reconciles request settlement after definitive start admission was committed", async () => {
    const current = fixture();
    current.completionFails = true;
    expect(await startSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: {
        code: "storage_unavailable",
        details: {
          operation: { admissionState: "admitted" },
          request: { deliveryState: "submitting" },
        },
      },
    });
    expect(current.initialMessages).toHaveLength(1);
    current.completionFails = false;
    expect(await startSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: true,
      value: {
        operation: { admissionState: "admitted" },
        request: { deliveryState: "admitted" },
      },
    });
    expect(current.initialMessages).toHaveLength(1);
  });

  test("rejects a combined start envelope overflow before composite persistence", async () => {
    const current = fixture();
    const result = await startSessionRequest(current.ports, context(), {
      ...args,
      initial_message: "w".repeat(32 * 1_024),
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
    expect(current.composites).toEqual([]);
  });

  test.each([
    ["idempotency_conflict", "idempotency_conflict"],
    ["quota_exceeded", "quota_exceeded"],
    ["deadlock_detected", "deadlock_detected"],
  ] as const)("maps atomic composite failure %s without native work", async (stored, code) => {
    const current = fixture();
    current.compositeFailure = stored;
    expect(await startSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(current.events).not.toContain("native-create");
    expect(current.events).not.toContain("request-claimed");
  });

  test("settles a definitive native initial-message rejection as delivery_failed", async () => {
    const current = fixture();
    current.nativeAdmission = "definitive_rejection";
    const result = await startSessionRequest(current.ports, context(), args);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "admission_failed",
        details: {
          operation: { id: operationId, admissionState: "failed" },
          request: {
            id: requestId,
            deliveryState: "delivery_failed",
            resolutionState: "delivery_failed",
          },
        },
      },
    });
    expect(current.completions).toEqual([
      { fencingToken: token, workspaceKey, requestId, outcome: "delivery_failed" },
    ]);
  });

  test("retains admission ambiguity as an explicit recovery-relevant request outcome", async () => {
    const current = fixture();
    current.nativeAdmission = "unknown";
    const result = await startSessionRequest(current.ports, context(), args);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "admission_unknown",
        details: {
          operation: { id: operationId, admissionState: "admission_unknown" },
          request: { id: requestId, deliveryState: "delivery_unknown" },
        },
      },
    });
    expect(current.completions[0]?.outcome).toBe("delivery_unknown");
  });
});

describe("startSessionRequest fail-closed boundaries", () => {
  test("rejects invalid start and request arguments", async () => {
    const invalidStart = fixture();
    expect(
      await startSessionRequest(invalidStart.ports, context(), { ...args, idempotency_key: "" }),
    ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });

    const invalidRequest = fixture();
    expect(
      await startSessionRequest(invalidRequest.ports, context(), {
        ...args,
        request: { ...args.request, timeoutSeconds: 0 },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  test("fails closed when ownership inspection throws", async () => {
    const current = fixture();
    current.ports.ownership.isCurrent = async () => {
      throw new Error("ownership unavailable");
    };
    expect(await startSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });
  });

  test("rejects unknown approval outcomes and malformed generated identifiers", async () => {
    const approval = fixture("ask");
    approval.ports.approval.requestStartApproval = async () => "unknown" as never;
    await expect(startSessionRequest(approval.ports, context(), args)).rejects.toThrow(
      "unknown outcome",
    );

    const identifiers = fixture();
    identifiers.ports.ids.startOperationId = () => "invalid" as never;
    await expect(startSessionRequest(identifiers.ports, context(), args)).rejects.toThrow(
      "identifiers are malformed",
    );
  });

  test("accepts explicit start approval and denies managed-session recursion", async () => {
    const approved = fixture("ask");
    expect(await startSessionRequest(approved.ports, context(), args)).toMatchObject({ ok: true });
    expect(approved.events).toContain("start-approval");

    const recursive = fixture();
    recursive.ports.starts.isManagedSession = async () => true;
    expect(await startSessionRequest(recursive.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
  });

  test.each([
    [new OwnershipLostFault(), "ownership_lost"],
    [new Error("storage unavailable"), "storage_unavailable"],
  ] as const)("maps composite read failure to %s", async (cause, code) => {
    const current = fixture();
    current.ports.requestStarts.readSessionRequestStart = async () => {
      throw cause;
    };
    expect(await startSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code },
    });
  });

  test.each([
    [new OwnershipLostFault(), "ownership_lost"],
    [new Error("storage unavailable"), "storage_unavailable"],
  ] as const)("maps composite persistence failure to %s", async (cause, code) => {
    const current = fixture();
    current.ports.requestStarts.createOrResumeSessionRequestStart = async () => {
      throw cause;
    };
    expect(await startSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code },
    });
  });

  test.each([
    ["deadlock_detected", "deadlock_detected"],
    ["storage_unavailable", "storage_unavailable"],
  ] as const)("maps linked request claim failure %s", async (stored, code) => {
    const current = fixture();
    current.ports.requests.claimPrepared = async () => ({ ok: false, code: stored });
    expect(await startSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(current.events).not.toContain("native-create");
  });

  test("rejects unrelated composite state", async () => {
    const current = fixture();
    expect(await startSessionRequest(current.ports, context(), args)).toMatchObject({ ok: true });
    current.request = { ...required(current.request), linkedStartOperationId: undefined } as never;
    await expect(startSessionRequest(current.ports, context(), args)).rejects.toThrow(
      "unrelated state",
    );
  });

  test("maps a thrown linked-request settlement", async () => {
    const current = fixture();
    current.ports.requests.completeDelivery = async () => {
      throw new Error("settlement unavailable");
    };
    expect(await startSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: {
        code: "storage_unavailable",
        details: { operation: { admissionState: "admitted" } },
      },
    });
  });
});
