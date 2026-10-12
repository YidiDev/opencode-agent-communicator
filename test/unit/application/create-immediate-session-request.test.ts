import { expect, test } from "bun:test";

import {
  createImmediateSessionRequest,
  type ImmediateSessionRequestPorts,
} from "../../../src/application/create-immediate-session-request";
import type {
  CompleteRequestDeliveryInput,
  PrepareRequestInput,
} from "../../../src/application/request-ports";
import {
  validateNativeMessageId,
  validateRequestId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:immediate-unit"));
const sourceSessionId = value(validateSessionId("ses_source"));
const targetSessionId = value(validateSessionId("ses_target"));
const token = value(validateFencingToken(31));
const requestId = value(validateRequestId(`req_${"1".repeat(32)}`));
const nativeMessageId = value(validateNativeMessageId(`msg_${"2".repeat(32)}`));
const creationOperationId = value(validateStartOperationId(`op_${"3".repeat(32)}`));
const args = {
  session_id: targetSessionId,
  content: "Perform the work.",
  request: { kind: "wait" as const, milestone: "ready", timeoutSeconds: 30 },
};

function context(controller = new AbortController()) {
  return {
    workspaceKey,
    sourceSessionId,
    fencingToken: token,
    abort: controller.signal,
    deadlineMs: 44_000,
  };
}

function fixture() {
  let prepared: (RequestMetadata & { readonly deliveryState: "prepared" }) | undefined;
  let envelope: string | undefined;
  let owner = true;
  let sourceVisible = true;
  let targetVisible = true;
  let messageDecision: "allow" | "deny" | "approval_rejected" = "allow";
  let requestDecision: "allow" | "deny" | "approval_rejected" = "allow";
  let nativeOutcome: Awaited<
    ReturnType<ImmediateSessionRequestPorts["nativeQueue"]["queueMessage"]>
  > = {
    kind: "public_message",
    observedAtMs: 10_002,
  };
  const events: string[] = [];
  const completions: CompleteRequestDeliveryInput[] = [];
  const ports: ImmediateSessionRequestPorts = {
    readiness: {
      fencingToken: token,
      assertReady: () => undefined,
      ownershipLost: () => events.push("ownership-lost"),
    },
    membership: {
      async readCurrentRoots() {
        events.push("visibility");
        return { sourceTitle: undefined, sourceVisible, targetVisible };
      },
    },
    messageAuthorization: {
      async authorizeMessage() {
        events.push("message-authorization");
        return { kind: messageDecision };
      },
    },
    requestAuthorization: {
      async authorizeRequest() {
        events.push("request-authorization");
        return { kind: requestDecision };
      },
    },
    requests: {
      async createPrepared(input: PrepareRequestInput) {
        events.push("prepared");
        prepared = input.request;
        envelope = input.envelopeJson;
        return { ok: true as const, request: input.request };
      },
      async claimPrepared() {
        events.push("claimed");
        if (!prepared || !envelope) throw new Error("not prepared");
        const submitting = {
          ...prepared,
          deliveryState: "submitting" as const,
          submittedAtMs: 10_001,
          updatedAtMs: 10_001,
        };
        return { ok: true as const, request: submitting, envelopeJson: envelope };
      },
      async completeDelivery(input: CompleteRequestDeliveryInput) {
        events.push("completed");
        completions.push(input);
        if (!prepared) throw new Error("not prepared");
        const submitting = {
          ...prepared,
          submittedAtMs: 10_001,
          updatedAtMs: 10_002,
        };
        const request =
          input.outcome === "admitted"
            ? {
                ...submitting,
                deliveryState: "admitted" as const,
                admittedAtMs: 10_002,
                admissionEvidence: {
                  state: "admitted" as const,
                  nativeMessageId,
                  admittedSeq: input.admittedSeq,
                  observedAtMs: input.evidenceObservedAtMs,
                },
              }
            : {
                ...submitting,
                deliveryState: "delivery_unknown" as const,
                deliveryUnknownAtMs: 10_002,
              };
        return { ok: true as const, request };
      },
    } as unknown as ImmediateSessionRequestPorts["requests"],
    scheduler: { wake: () => undefined },
    nativeQueue: {
      async queueMessage() {
        events.push("queue");
        return nativeOutcome;
      },
    },
    ownership: { acquire: async () => token, isCurrent: async () => owner },
    clock: { nowMs: () => 10_000 },
    ids: {
      requestId: () => requestId,
      nativeMessageId: () => nativeMessageId,
      startOperationId: () => creationOperationId,
    } as ImmediateSessionRequestPorts["ids"],
    digest: { sha256: async () => new Uint8Array(32).fill(0xab) },
    activity: {
      observeRequestParticipants: async () => {
        throw new Error("activity must not be consulted");
      },
    },
  };
  return {
    ports,
    events,
    completions,
    setOwner: (value_: boolean) => (owner = value_),
    setVisibility: (source: boolean, target: boolean) => {
      sourceVisible = source;
      targetVisible = target;
    },
    setMessageDecision: (value_: typeof messageDecision) => (messageDecision = value_),
    setRequestDecision: (value_: typeof requestDecision) => (requestDecision = value_),
    setNativeOutcome: (value_: typeof nativeOutcome) => (nativeOutcome = value_),
  };
}

test("immediate request uses durable public queue admission without activity gating", async () => {
  const setup = fixture();
  const result = await createImmediateSessionRequest(setup.ports, context(), args);

  expect(result).toMatchObject({
    ok: true,
    value: { deliveryMode: "queue", deliveryState: "delivery_unknown" },
  });
  expect(setup.events).toEqual([
    "visibility",
    "message-authorization",
    "request-authorization",
    "visibility",
    "prepared",
    "claimed",
    "queue",
    "completed",
  ]);
  expect(setup.completions).toEqual([
    expect.objectContaining({ outcome: "delivery_unknown", requestId }),
  ]);
  expect(setup.completions[0]).not.toHaveProperty("admittedSeq");
});

test("immediate request preserves real queue sequence evidence when supplied", async () => {
  const setup = fixture();
  setup.setNativeOutcome({ kind: "admitted", admittedSeq: 7, observedAtMs: 10_002 });

  expect(await createImmediateSessionRequest(setup.ports, context(), args)).toMatchObject({
    ok: true,
    value: {
      deliveryMode: "queue",
      deliveryState: "admitted",
      admissionEvidence: { admittedSeq: 7 },
    },
  });
  expect(setup.completions).toEqual([
    expect.objectContaining({ outcome: "admitted", admittedSeq: 7 }),
  ]);
});

test.each(["deny", "approval_rejected"] as const)(
  "message authorization %s prevents persistence and queue effects",
  async (decision) => {
    const setup = fixture();
    setup.setMessageDecision(decision);
    expect(await createImmediateSessionRequest(setup.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: decision === "deny" ? "permission_denied" : "approval_rejected" },
    });
    expect(setup.events).not.toContain("prepared");
    expect(setup.events).not.toContain("queue");
  },
);

test("request authorization and current visibility are checked before persistence", async () => {
  const denied = fixture();
  denied.setRequestDecision("deny");
  expect(await createImmediateSessionRequest(denied.ports, context(), args)).toMatchObject({
    ok: false,
    error: { code: "permission_denied" },
  });
  expect(denied.events).not.toContain("prepared");

  const hidden = fixture();
  hidden.setVisibility(true, false);
  expect(await createImmediateSessionRequest(hidden.ports, context(), args)).toMatchObject({
    ok: false,
    error: { code: "target_not_visible" },
  });
  expect(hidden.events).toEqual(["visibility"]);
});

test("ownership loss prevents durable and native effects", async () => {
  const setup = fixture();
  setup.setOwner(false);
  expect(await createImmediateSessionRequest(setup.ports, context(), args)).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });
  expect(setup.events).toContain("ownership-lost");
  expect(setup.events).not.toContain("prepared");
  expect(setup.events).not.toContain("queue");
});

test("immediate creation distinguishes caller visibility and malformed membership", async () => {
  const hidden = fixture();
  hidden.setVisibility(false, true);
  expect(await createImmediateSessionRequest(hidden.ports, context(), args)).toMatchObject({
    ok: false,
    error: { code: "caller_not_visible" },
  });

  for (const failure of ["throw", "malformed"] as const) {
    const setup = fixture();
    setup.ports.membership.readCurrentRoots = async () => {
      if (failure === "throw") throw new Error("membership unavailable");
      return null as never;
    };
    expect(await createImmediateSessionRequest(setup.ports, context(), args)).toMatchObject({
      ok: false,
      error: { code: "native_unavailable" },
    });
    expect(setup.events).not.toContain("prepared");
  }
});

test("immediate creation rejects cancellation, digest failure, and unsafe deadlines before effects", async () => {
  const cancelled = fixture();
  const controller = new AbortController();
  controller.abort("caller cancelled");
  expect(
    await createImmediateSessionRequest(cancelled.ports, context(controller), args),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });

  const digest = fixture();
  let digestCalls = 0;
  digest.ports.digest.sha256 = async () => {
    digestCalls += 1;
    if (digestCalls > 1) throw new Error("digest unavailable");
    return new Uint8Array(32).fill(0xab);
  };
  expect(await createImmediateSessionRequest(digest.ports, context(), args)).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable" },
  });

  const deadline = fixture();
  deadline.ports.clock.nowMs = () => Number.MAX_SAFE_INTEGER - 100;
  expect(
    await createImmediateSessionRequest(
      deadline.ports,
      { ...context(), deadlineMs: Number.MAX_SAFE_INTEGER },
      args,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "invalid_arguments" },
  });
  expect(deadline.events).not.toContain("prepared");
});

test("immediate creation validates canonical payloads and cancellation after digesting", async () => {
  const invalid = fixture();
  expect(
    await createImmediateSessionRequest(invalid.ports, context(), {
      ...args,
      request: { ...args.request, timeoutSeconds: 0 },
    }),
  ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  expect(invalid.events).not.toContain("message-authorization");

  const cancelled = fixture();
  const controller = new AbortController();
  let digestCalls = 0;
  cancelled.ports.digest.sha256 = async () => {
    digestCalls += 1;
    if (digestCalls === 2) controller.abort("cancelled after digest");
    return new Uint8Array(32).fill(0xab);
  };
  expect(
    await createImmediateSessionRequest(cancelled.ports, context(controller), args),
  ).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  expect(cancelled.events).not.toContain("message-authorization");
});

test("immediate creation fails closed on ambiguous static authorization results", async () => {
  for (const authorization of ["message", "request"] as const) {
    for (const outcome of ["reject", "malformed", "abort"] as const) {
      const setup = fixture();
      const controller = new AbortController();
      const operation = async () => {
        if (outcome === "reject") throw new Error("authorization unavailable");
        if (outcome === "abort") {
          controller.abort("cancelled");
          return new Promise<never>(() => undefined);
        }
        return null as never;
      };
      if (authorization === "message")
        setup.ports.messageAuthorization.authorizeMessage = operation;
      else setup.ports.requestAuthorization.authorizeRequest = operation;
      expect(
        await createImmediateSessionRequest(setup.ports, context(controller), args),
      ).toMatchObject({
        ok: false,
        error: { code: outcome === "abort" ? "request_cancelled" : "storage_unavailable" },
      });
      expect(setup.events).not.toContain("prepared");
    }
  }
});

test("immediate creation rechecks membership immediately before persistence", async () => {
  for (const outcome of ["hidden", "reject", "abort"] as const) {
    const setup = fixture();
    const controller = new AbortController();
    let reads = 0;
    setup.ports.membership.readCurrentRoots = async () => {
      reads += 1;
      if (reads === 1) return { sourceTitle: undefined, sourceVisible: true, targetVisible: true };
      if (outcome === "reject") throw new Error("membership unavailable");
      if (outcome === "abort") {
        controller.abort("cancelled");
        return new Promise<never>(() => undefined);
      }
      return { sourceTitle: undefined, sourceVisible: true, targetVisible: false };
    };
    expect(
      await createImmediateSessionRequest(setup.ports, context(controller), args),
    ).toMatchObject({
      ok: false,
      error: {
        code:
          outcome === "hidden"
            ? "target_not_visible"
            : outcome === "reject"
              ? "native_unavailable"
              : "request_cancelled",
      },
    });
    expect(setup.events).not.toContain("prepared");
  }
});
