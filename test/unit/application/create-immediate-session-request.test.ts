import { describe, expect, test } from "bun:test";
import {
  createImmediateSessionRequest,
  type ImmediateSessionRequestPorts,
} from "../../../src/application/create-immediate-session-request";
import type {
  CompleteRequestDeliveryInput,
  PrepareRequestInput,
  RequestClaimResult,
  RequestStoreResult,
} from "../../../src/application/request-ports";
import {
  validateNativeMessageId,
  validateRequestId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { PendingRequestMetadata, RequestMetadata } from "../../../src/domain/request-types";
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

function submitting(
  request: PendingRequestMetadata,
): RequestMetadata & { deliveryState: "submitting" } {
  return {
    ...request,
    deliveryState: "submitting",
    submittedAtMs: 10_001,
  } as RequestMetadata & { deliveryState: "submitting" };
}

function completeMetadata(
  request: RequestMetadata,
  input: CompleteRequestDeliveryInput,
): RequestMetadata {
  if (input.outcome === "delivery_unknown") {
    return {
      ...request,
      deliveryState: "delivery_unknown",
      deliveryUnknownAtMs: 10_002,
    } as RequestMetadata;
  }
  if (input.outcome === "delivery_failed") {
    return {
      ...request,
      deliveryState: "delivery_failed",
      resolutionState: "delivery_failed",
      deliveryFailedAtMs: 10_002,
      resolvedAtMs: 10_002,
      payloadSha256: undefined,
    } as unknown as RequestMetadata;
  }
  const evidence =
    input.outcome === "promoted"
      ? {
          state: "promoted" as const,
          nativeMessageId: input.nativeMessageId,
          admittedSeq: input.admittedSeq,
          promotedSeq: input.promotedSeq,
          observedAtMs: input.evidenceObservedAtMs,
        }
      : {
          state: "admitted" as const,
          nativeMessageId: input.nativeMessageId,
          admittedSeq: input.admittedSeq,
          observedAtMs: input.evidenceObservedAtMs,
        };
  return {
    ...request,
    deliveryState: input.outcome,
    admittedAtMs: 10_002,
    ...(input.outcome === "promoted" ? { promotedAtMs: 10_002 } : {}),
    admissionEvidence: evidence,
  } as RequestMetadata;
}

interface Fixture {
  ports: ImmediateSessionRequestPorts;
  messageDecision: "allow" | "deny" | "approval_rejected";
  requestDecision: "allow" | "deny" | "approval_rejected";
  memberships: Array<{ sourceVisible: boolean; targetVisible: boolean }>;
  owner: boolean;
  nativeOutcome: Awaited<ReturnType<ImmediateSessionRequestPorts["nativeQueue"]["queueMessage"]>>;
  nativeThrows: boolean;
  abortAfterClaim?: () => void;
  createResult?: RequestStoreResult;
  claimResult?: RequestClaimResult;
  readonly events: string[];
  readonly prepared: PrepareRequestInput[];
  readonly completions: CompleteRequestDeliveryInput[];
  readonly controls: Array<{ abort: AbortSignal; deadlineMs?: number }>;
  readonly envelopes: string[];
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
    nativeOutcome: { kind: "admitted" as const, admittedSeq: 7, observedAtMs: 10_003 },
    nativeThrows: false,
    events: [] as string[],
    prepared: [] as PrepareRequestInput[],
    completions: [] as CompleteRequestDeliveryInput[],
    controls: [] as Array<{ abort: AbortSignal; deadlineMs?: number }>,
    envelopes: [] as string[],
  } as Fixture;
  result.ports = {
    readiness: { fencingToken: token, assertReady() {} },
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
        return result.createResult ?? { ok: true, request: input.request };
      },
      async claimPrepared() {
        result.events.push("claimed");
        result.abortAfterClaim?.();
        if (result.claimResult) return result.claimResult;
        const prepared = required(result.prepared[0]);
        const request = submitting(prepared.request);
        return { ok: true, request, envelopeJson: prepared.envelopeJson };
      },
      async completeDelivery(input: CompleteRequestDeliveryInput) {
        result.events.push(`completed:${input.outcome}`);
        result.completions.push(input);
        const current = result.claimResult?.ok
          ? result.claimResult.request
          : submitting(required(result.prepared[0]).request);
        return { ok: true, request: completeMetadata(current, input) };
      },
    } as unknown as ImmediateSessionRequestPorts["requests"],
    scheduler: {
      wake() {
        result.events.push("scheduler-wake");
      },
    },
    nativeQueue: {
      async queueMessage(input) {
        result.events.push("native");
        result.envelopes.push(input.envelope);
        if (result.nativeThrows) throw new Error("write may have happened");
        return result.nativeOutcome;
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
      expect(current.envelopes).toEqual([]);
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
  test("persists and claims one linked envelope before one successful queue call", async () => {
    const current = fixture();
    const result = await createImmediateSessionRequest(current.ports, context(), args);
    expect(result).toMatchObject({
      ok: true,
      value: {
        id: requestId,
        nativeMessageId,
        deliveryMode: "queue",
        deliveryState: "admitted",
      },
    });
    expect(current.events).toEqual([
      "visibility",
      "message-authorization",
      "request-authorization",
      "visibility",
      "prepared",
      "scheduler-wake",
      "claimed",
      "native",
      "completed:admitted",
    ]);
    expect(current.prepared[0]).toMatchObject({
      creationOperationId,
      deliveryMode: "queue",
      request: { id: requestId, deadlineAtMs: 40_000 },
    });
    const envelope = JSON.parse(required(current.envelopes[0]));
    expect(envelope).toMatchObject({
      request_id: requestId,
      source_session_id: sourceSessionId,
      target_session_id: targetSessionId,
      work: { content: args.content },
    });
    expect(current.completions).toEqual([
      {
        fencingToken: token,
        workspaceKey,
        requestId,
        outcome: "admitted",
        nativeMessageId,
        admittedSeq: 7,
        evidenceObservedAtMs: 10_003,
      },
    ]);
  });

  test.each([
    [{ kind: "unknown" }, "delivery_unknown"],
    [{ kind: "definitive_rejection" }, "delivery_failed"],
  ] as const)("records native %s as recovery-relevant %s", async (native, state) => {
    const current = fixture();
    current.nativeOutcome = native;
    expect(await createImmediateSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: true,
      value: { id: requestId, deliveryState: state },
    });
    expect(current.envelopes).toHaveLength(1);
  });

  test("records a thrown queue outcome as ambiguous and never retries", async () => {
    const current = fixture();
    current.nativeThrows = true;
    expect(await createImmediateSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: true,
      value: { deliveryState: "delivery_unknown" },
    });
    expect(current.envelopes).toHaveLength(1);
    expect(current.completions[0]?.outcome).toBe("delivery_unknown");
  });

  test("returns an already-settled claim without replaying native work", async () => {
    const current = fixture();
    const settled = {
      id: requestId,
      workspaceKey,
      sourceSessionId,
      targetSessionId,
      nativeMessageId,
      deliveryMode: "queue" as const,
      kind: "wait" as const,
      resolutionState: "delivery_failed" as const,
      deliveryState: "delivery_failed" as const,
      resultState: "none" as const,
      payloadByteLength: 50,
      createdAtMs: 10_000,
      updatedAtMs: 10_001,
      deadlineAtMs: 40_000,
      submittedAtMs: 10_001,
      deliveryFailedAtMs: 10_001,
      resolvedAtMs: 10_001,
    };
    current.claimResult = { ok: true, request: settled };
    expect(await createImmediateSessionRequest(current.ports, context(), args)).toEqual({
      ok: true,
      value: settled,
    });
    expect(current.envelopes).toEqual([]);
    expect(current.completions).toEqual([]);
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
    expect(stale.envelopes).toEqual([]);
  });

  test("an already-expired invocation deadline never persists or calls native", async () => {
    const current = fixture();
    expect(
      await createImmediateSessionRequest(
        current.ports,
        { ...context(), deadlineMs: 10_000 },
        args,
      ),
    ).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
    expect(current.prepared).toEqual([]);
    expect(current.envelopes).toEqual([]);
  });

  test("an interruption after claim commits ambiguity without calling native", async () => {
    const current = fixture();
    const controller = new AbortController();
    current.abortAfterClaim = () => controller.abort();
    expect(
      await createImmediateSessionRequest(current.ports, context(controller), args),
    ).toMatchObject({
      ok: true,
      value: { deliveryState: "delivery_unknown" },
    });
    expect(current.events).not.toContain("native");
    expect(current.completions[0]?.outcome).toBe("delivery_unknown");
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
  ] as const)("maps prepare failure %s without claiming", async (stored, code, retryable) => {
    const current = fixture();
    current.createResult = { ok: false, code: stored };
    expect(await createImmediateSessionRequest(current.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code, retryable },
    });
    expect(current.events).not.toContain("claimed");
    expect(current.envelopes).toEqual([]);
  });
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
  test("maps persistence, claim, and completion failures", async () => {
    const persistence = fixture();
    persistence.ports.requests.createPrepared = async () => {
      throw new Error("storage unavailable");
    };
    expect(await createImmediateSessionRequest(persistence.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    const claim = fixture();
    claim.claimResult = { ok: false, code: "storage_unavailable" };
    expect(await createImmediateSessionRequest(claim.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable", details: { request_id: requestId } },
    });

    const completion = fixture();
    completion.ports.requests.completeDelivery = async () => ({
      ok: false,
      code: "storage_unavailable",
    });
    expect(await createImmediateSessionRequest(completion.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable", details: { request_id: requestId } },
    });
  });

  test.each(["ownership", "digest", "persistence", "final visibility"] as const)(
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
      } else if (boundary === "persistence") {
        current.ports.requests.createPrepared = async (input) => {
          current.prepared.push(input);
          controller.abort();
          return { ok: true, request: input.request };
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
      expect(current.envelopes).toEqual([]);
    },
  );

  test("records promoted and public-message admission evidence", async () => {
    const promoted = fixture();
    promoted.nativeOutcome = {
      kind: "promoted",
      admittedSeq: 8,
      promotedSeq: 9,
      observedAtMs: 10_004,
    };
    expect(await createImmediateSessionRequest(promoted.ports, context(), args)).toMatchObject({
      ok: true,
      value: { deliveryState: "promoted" },
    });

    const publicMessage = fixture();
    publicMessage.nativeOutcome = { kind: "public_message", observedAtMs: 10_005 };
    expect(await createImmediateSessionRequest(publicMessage.ports, context(), args)).toMatchObject(
      {
        ok: true,
        value: { deliveryState: "admitted" },
      },
    );
    expect(publicMessage.completions[0]).toMatchObject({ admittedSeq: 0 });
  });
});
