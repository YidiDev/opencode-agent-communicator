import { describe, expect, test } from "bun:test";
import type {
  CompleteSubmissionInput,
  CurrentRootMembership,
  DeliveryClaimResult,
  DeliveryPersistencePort,
  DeliveryStoreFailureCode,
  DeliveryStoreResult,
  DeliveryTransitionInput,
  MessageAuthorizationPort,
  NativeQueueAdmission,
  PrepareDeliveryInput,
} from "../../../src/application/delivery-ports";
import {
  type SessionSendPorts,
  sendSessionMessage,
} from "../../../src/application/send-session-message";
import {
  canTransitionDelivery,
  type DeliveryMetadata,
  type DeliveryState,
} from "../../../src/domain/deliveries";
import {
  type NativeMessageId,
  validateDeliveryId,
  validateNativeMessageId,
} from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { type FencingToken, validateFencingToken } from "../../../src/domain/ownership";
import { type SessionId, validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:test"));
const sourceSessionId = valid(validateSessionId("ses_source"));
const targetSessionId = valid(validateSessionId("ses_target"));
const deliveryId = valid(validateDeliveryId(`dlv_${"1".repeat(32)}`));
const nativeMessageId = valid(validateNativeMessageId(`msg_${"2".repeat(32)}`));
const fencingToken = valid(validateFencingToken(23));

function withState(
  record: DeliveryMetadata,
  state: DeliveryState,
  nowMs: number,
): DeliveryMetadata {
  let times: Record<string, number> = {};
  if (state === "submitting") times = { submittedAtMs: nowMs };
  else if (state === "admission_unknown") times = { admissionUnknownAtMs: nowMs };
  else if (state === "admitted") times = { admittedAtMs: nowMs };
  else if (state === "promoted") times = { admittedAtMs: nowMs, promotedAtMs: nowMs };
  else if (state === "failed") times = { failedAtMs: nowMs };
  else if (state === "cancelled") times = { cancelledAtMs: nowMs };
  return { ...record, state, updatedAtMs: nowMs, ...times };
}

class MemoryDeliveries implements DeliveryPersistencePort {
  record: DeliveryMetadata | undefined;
  retainedEnvelope: string | undefined;
  createFailure: DeliveryStoreFailureCode | undefined;
  beginHook: (() => void) | undefined;
  claimBeforeCas: (() => Promise<void>) | undefined;
  claimAfterCas: (() => Promise<void>) | undefined;
  completeFailure: DeliveryStoreFailureCode | undefined;
  readonly events: string[] = [];

  private checkToken(token: FencingToken): void {
    expect(token).toBe(fencingToken);
  }

  async createPrepared(input: PrepareDeliveryInput): Promise<DeliveryStoreResult> {
    this.checkToken(input.fencingToken);
    this.events.push("prepared");
    if (this.createFailure) return { ok: false, code: this.createFailure };
    this.retainedEnvelope = input.envelope;
    this.record = {
      id: input.id,
      workspaceKey: input.workspaceKey,
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      nativeMessageId: input.nativeMessageId,
      state: "prepared",
      contentByteLength: input.contentByteLength,
      contentSha256: input.contentSha256,
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    };
    return { ok: true, delivery: this.record };
  }

  async cancelPrepared(input: DeliveryTransitionInput): Promise<DeliveryStoreResult> {
    this.checkToken(input.fencingToken);
    this.events.push("cancel-attempt");
    if (!this.record) return { ok: false, code: "state_conflict" };
    if (this.record.state === "prepared") {
      this.record = withState(this.record, "cancelled", input.nowMs);
      this.retainedEnvelope = undefined;
      this.events.push("cancelled");
      return { ok: true, delivery: this.record };
    }
    return { ok: false, code: "state_conflict" };
  }

  async claimPrepared(input: DeliveryTransitionInput): Promise<DeliveryClaimResult> {
    this.checkToken(input.fencingToken);
    this.events.push("begin-attempt");
    this.beginHook?.();
    await this.claimBeforeCas?.();
    if (!this.record) return { ok: false, code: "state_conflict" };
    if (this.record.state === "prepared") {
      const envelope = this.retainedEnvelope;
      if (envelope === undefined) return { ok: false as const, code: "state_conflict" as const };
      this.record = withState(this.record, "submitting", input.nowMs);
      this.retainedEnvelope = undefined;
      this.events.push("content-erased");
      await this.claimAfterCas?.();
      return {
        ok: true,
        delivery: this.record as DeliveryMetadata & { readonly state: "submitting" },
        envelope,
      };
    }
    return { ok: true as const, delivery: this.record };
  }

  async completeSubmission(input: CompleteSubmissionInput): Promise<DeliveryStoreResult> {
    this.checkToken(input.fencingToken);
    this.events.push(`complete:${input.state}`);
    if (this.completeFailure) return { ok: false, code: this.completeFailure };
    if (!this.record) return { ok: false, code: "state_conflict" };
    const legal =
      canTransitionDelivery(this.record.state, input.state) ||
      (this.record.state === "submitting" && input.state === "promoted");
    expect(legal).toBe(true);
    const transitionAtMs =
      input.state === "admitted" || input.state === "promoted"
        ? Math.max(input.nowMs, input.evidenceObservedAtMs)
        : input.nowMs;
    this.record = withState(this.record, input.state, transitionAtMs);
    if (input.state === "admitted" || input.state === "promoted") {
      const evidence =
        input.state === "admitted"
          ? {
              nativeMessageId: this.record.nativeMessageId,
              state: "admitted" as const,
              admittedSeq: input.admittedSeq,
              observedAtMs: input.evidenceObservedAtMs,
            }
          : {
              nativeMessageId: this.record.nativeMessageId,
              state: "promoted" as const,
              admittedSeq: input.admittedSeq,
              promotedSeq: input.promotedSeq,
              observedAtMs: input.evidenceObservedAtMs,
            };
      this.record = {
        ...this.record,
        admissionEvidence: evidence,
      };
    }
    const delivery = this.record;
    return { ok: true, delivery };
  }

  async getForParticipant(): Promise<undefined> {
    return undefined;
  }

  async listRecoverable(
    input: Parameters<DeliveryPersistencePort["listRecoverable"]>[0],
  ): Promise<readonly DeliveryMetadata[]> {
    this.checkToken(input.fencingToken);
    return [];
  }
}

interface Fixture {
  readonly ports: SessionSendPorts;
  readonly store: MemoryDeliveries;
  readonly memberships: CurrentRootMembership[];
  readonly ownerStates: boolean[];
  readonly nativeCalls: Array<{
    readonly targetSessionId: SessionId;
    readonly nativeMessageId: NativeMessageId;
    readonly envelope: string;
    readonly abort: AbortSignal;
  }>;
  nativeOutcome: NativeQueueAdmission;
  nativeEffect?: () => void;
  authorizationDecision: "allow" | "deny" | "approval_rejected";
  authorizationGate?: () => Promise<void>;
  readonly authorizationBindings: Array<{
    readonly binding: Parameters<MessageAuthorizationPort["authorizeMessage"]>[0];
    readonly control: Parameters<MessageAuthorizationPort["authorizeMessage"]>[1];
  }>;
  acquireCalls: number;
  lifecycleStops: number;
}

function fixture(): Fixture {
  const store = new MemoryDeliveries();
  const memberships: CurrentRootMembership[] = [
    { sourceVisible: true, targetVisible: true, sourceTitle: "\u001b[31mSource" },
    { sourceVisible: true, targetVisible: true, sourceTitle: "Source" },
    { sourceVisible: true, targetVisible: true, sourceTitle: "Source" },
  ];
  const ownerStates = [true, true, true, true];
  const nativeCalls: Fixture["nativeCalls"] = [];
  const authorizationBindings: Fixture["authorizationBindings"] = [];
  const result: Fixture = {
    store,
    memberships,
    ownerStates,
    nativeCalls,
    nativeOutcome: { kind: "admitted", admittedSeq: 41, observedAtMs: 900 },
    authorizationDecision: "allow",
    authorizationBindings,
    acquireCalls: 0,
    lifecycleStops: 0,
    ports: {
      readiness: {
        fencingToken,
        assertReady() {},
        ownershipLost() {
          result.lifecycleStops += 1;
        },
      },
      membership: {
        async readCurrentRoots() {
          const membership = memberships.shift();
          if (!membership) throw new Error("no membership fixture");
          return membership;
        },
      },
      authorization: {
        async authorizeMessage(binding, control) {
          authorizationBindings.push({ binding, control });
          await result.authorizationGate?.();
          return { kind: result.authorizationDecision };
        },
      },
      deliveries: store,
      nativeQueue: {
        async queueMessage(input) {
          nativeCalls.push(input);
          result.nativeEffect?.();
          return result.nativeOutcome;
        },
      },
      ownership: {
        async acquire() {
          result.acquireCalls += 1;
          return fencingToken;
        },
        async isCurrent(token) {
          expect(token).toBe(fencingToken);
          return ownerStates.shift() ?? false;
        },
      },
      clock: {
        nowMs: (() => {
          let now = 100;
          return () => ++now;
        })(),
      },
      ids: {
        deliveryId: () => deliveryId,
        nativeMessageId: () => nativeMessageId,
        requestId: () => {
          throw new Error("not used");
        },
        managedSessionId: () => {
          throw new Error("not used");
        },
        startOperationId: () => {
          throw new Error("not used");
        },
      },
      digest: {
        async sha256() {
          return new Uint8Array(32).fill(0xab);
        },
      },
    },
  };
  return result;
}

function context(controller = new AbortController()) {
  return { workspaceKey, sourceSessionId, abort: controller.signal };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let finish: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, resolve: () => finish?.() };
}

describe("session_send orchestration", () => {
  test("throws lifecycle not-ready before validation or any effect", async () => {
    const fake = fixture();
    const fault = new Error("communicator not ready");
    fake.ports.readiness.assertReady = () => {
      throw fault;
    };
    await expect(
      sendSessionMessage(fake.ports, context(), { session_id: "invalid", content: 7 }),
    ).rejects.toBe(fault);
    expect(fake.memberships).toHaveLength(3);
    expect(fake.acquireCalls).toBe(0);
    expect(fake.authorizationBindings).toEqual([]);
    expect(fake.nativeCalls).toEqual([]);
  });

  test("derives source from context, fixes the message ID, and reports admission evidence only", async () => {
    const fake = fixture();
    const invocation = context();
    const result = await sendSessionMessage(fake.ports, invocation, {
      session_id: targetSessionId,
      content: 'hello "peer"',
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        id: deliveryId,
        sourceSessionId,
        targetSessionId,
        nativeMessageId,
        state: "admitted",
        contentByteLength: 12,
        contentSha256: "ab".repeat(32),
        admissionEvidence: { state: "admitted", admittedSeq: 41, observedAtMs: 900 },
      },
    });
    expect(fake.nativeCalls).toHaveLength(1);
    expect(fake.nativeCalls[0]?.abort).toBe(invocation.abort);
    expect(fake.acquireCalls).toBe(0);
    expect(fake.authorizationBindings).toEqual([
      {
        binding: {
          workspaceKey,
          sourceSessionId,
          targetSessionId,
          operation: "message",
          contentSha256: "ab".repeat(32) as Sha256Digest,
          contentByteLength: 12,
        },
        control: { abort: invocation.abort },
      },
    ]);
    const envelope = JSON.parse(fake.nativeCalls[0]?.envelope ?? "");
    expect(envelope).toMatchObject({
      source_session_id: sourceSessionId,
      target_session_id: targetSessionId,
      delivery_id: deliveryId,
      payload: { content: 'hello "peer"' },
      display: { source_title: "Source" },
    });
  });

  test.each([
    [{ sourceVisible: false, targetVisible: true, sourceTitle: undefined }, "caller_not_visible"],
    [{ sourceVisible: true, targetVisible: false, sourceTitle: undefined }, "target_not_visible"],
  ] as const)("requires both visible roots before persistence", async (membership, code) => {
    const fake = fixture();
    fake.memberships.splice(0, 2, membership);
    const result = await sendSessionMessage(fake.ports, context(), {
      session_id: targetSessionId,
      content: "hello",
    });
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(fake.store.events).toEqual([]);
    expect(fake.nativeCalls).toEqual([]);
  });

  test.each([
    [{ sourceVisible: false, targetVisible: true, sourceTitle: undefined }, "caller_not_visible"],
    [{ sourceVisible: true, targetVisible: false, sourceTitle: undefined }, "target_not_visible"],
  ] as const)(
    "cancels when visibility races immediately before effect",
    async (membership, code) => {
      const fake = fixture();
      fake.memberships[2] = membership;
      const result = await sendSessionMessage(fake.ports, context(), {
        session_id: targetSessionId,
        content: "hello",
      });
      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(fake.store.record?.state).toBe("cancelled");
      expect(fake.nativeCalls).toEqual([]);
    },
  );

  test.each(["quota_exceeded", "rate_limited"] as const)(
    "honors atomic persistence outcome %s without native I/O",
    async (code) => {
      const fake = fixture();
      fake.store.createFailure = code;
      const result = await sendSessionMessage(fake.ports, context(), {
        session_id: targetSessionId,
        content: "hello",
      });
      expect(result).toMatchObject({ ok: false, error: { code } });
      if (!result.ok) expect(result.error.details).toBeUndefined();
      expect(fake.nativeCalls).toEqual([]);
    },
  );

  test.each([
    ["deny", "permission_denied"],
    ["approval_rejected", "approval_rejected"],
  ] as const)("maps message authorization %s before persistence", async (decision, code) => {
    const fake = fixture();
    fake.authorizationDecision = decision;
    const result = await sendSessionMessage(fake.ports, context(), {
      session_id: targetSessionId,
      content: "authorize me",
    });
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(fake.authorizationBindings[0]?.binding).toMatchObject({
      workspaceKey,
      sourceSessionId,
      targetSessionId,
      operation: "message",
      contentByteLength: 12,
      contentSha256: "ab".repeat(32),
    });
    expect(fake.store.events).toEqual([]);
    expect(fake.acquireCalls).toBe(0);
    expect(fake.nativeCalls).toEqual([]);
  });

  test("passes operation abort and deadline to an approval decision", async () => {
    const fake = fixture();
    const deadlineMs = Date.now() + 12_345;
    const invocation = { ...context(), deadlineMs };
    await sendSessionMessage(fake.ports, invocation, {
      session_id: targetSessionId,
      content: "hello",
    });
    expect(fake.authorizationBindings[0]?.control).toEqual({
      abort: invocation.abort,
      deadlineMs,
    });
  });

  test.each([
    [{ sourceVisible: false, targetVisible: true }, "caller_not_visible"],
    [{ sourceVisible: true, targetVisible: false }, "target_not_visible"],
  ] as const)(
    "persists nothing when visibility changes across a controlled authorization gate",
    async (visibility, code) => {
      const fake = fixture();
      const entered = deferred();
      const release = deferred();
      fake.authorizationGate = async () => {
        entered.resolve();
        await release.promise;
      };
      const pending = sendSessionMessage(fake.ports, context(), {
        session_id: targetSessionId,
        content: "hello",
      });
      await entered.promise;
      fake.memberships[0] = { ...visibility, sourceTitle: "Source" };
      release.resolve();
      const result = await pending;
      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(fake.store.events).toEqual([]);
      expect(fake.nativeCalls).toEqual([]);
    },
  );
});

describe("session_send prepared claim and abort races", () => {
  test("cancels an already-aborted prepared delivery before submission", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fixture();
    const result = await sendSessionMessage(fake.ports, context(controller), {
      session_id: targetSessionId,
      content: "hello",
    });
    expect(result).toMatchObject({ ok: true, value: { state: "cancelled" } });
    expect(fake.nativeCalls).toEqual([]);
  });

  test("a cancellation racing begin wins only while state is prepared", async () => {
    const controller = new AbortController();
    const fake = fixture();
    fake.store.beginHook = () => controller.abort();
    const result = await sendSessionMessage(fake.ports, context(controller), {
      session_id: targetSessionId,
      content: "hello",
    });
    expect(result).toMatchObject({ ok: true, value: { state: "cancelled" } });
    expect(fake.store.events).toContain("cancelled");
    expect(fake.nativeCalls).toEqual([]);
  });

  test("linearizes an asynchronous claim race when fenced cancellation commits first", async () => {
    const controller = new AbortController();
    const fake = fixture();
    const entered = deferred();
    const release = deferred();
    fake.store.claimBeforeCas = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = sendSessionMessage(fake.ports, context(controller), {
      session_id: targetSessionId,
      content: "hello",
    });
    await entered.promise;
    controller.abort();
    release.resolve();
    const result = await pending;
    expect(result).toMatchObject({ ok: true, value: { state: "cancelled" } });
    expect(fake.store.events).not.toContain("content-erased");
    expect(fake.nativeCalls).toEqual([]);
  });

  test("treats abort as post-submission when the fenced claim commits first", async () => {
    const controller = new AbortController();
    const fake = fixture();
    const entered = deferred();
    const release = deferred();
    fake.store.claimAfterCas = async () => {
      entered.resolve();
      await release.promise;
    };
    fake.nativeOutcome = { kind: "definitive_rejection" };
    const pending = sendSessionMessage(fake.ports, context(controller), {
      session_id: targetSessionId,
      content: "hello",
    });
    await entered.promise;
    controller.abort();
    release.resolve();
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "admission_unknown", details: { delivery_id: deliveryId } },
    });
    expect(fake.store.events.indexOf("content-erased")).toBeLessThan(
      fake.store.events.indexOf("cancel-attempt"),
    );
    expect(fake.store.record?.state).toBe("admission_unknown");
    expect(fake.nativeCalls).toHaveLength(0);
  });

  test("commits submitting and erases content before native admission", async () => {
    const fake = fixture();
    fake.nativeEffect = () => {
      expect(fake.store.record?.state).toBe("submitting");
      expect(fake.store.retainedEnvelope).toBeUndefined();
      expect(fake.store.events.indexOf("content-erased")).toBeLessThan(
        fake.store.events.indexOf("native-call"),
      );
    };
    const original = fake.ports.nativeQueue.queueMessage;
    fake.ports.nativeQueue.queueMessage = async (input) => {
      fake.store.events.push("native-call");
      return original(input);
    };
    await sendSessionMessage(fake.ports, context(), {
      session_id: targetSessionId,
      content: "secret",
    });
    expect(fake.store.retainedEnvelope).toBeUndefined();
  });
});

describe("session_send native outcomes", () => {
  test.each([
    [{ kind: "definitive_rejection" }, "admission_failed", "failed"],
    [{ kind: "unknown" }, "admission_unknown", "admission_unknown"],
  ] as const)("records native %s explicitly", async (outcome, code, state) => {
    const fake = fixture();
    fake.nativeOutcome = outcome;
    const result = await sendSessionMessage(fake.ports, context(), {
      session_id: targetSessionId,
      content: "hello",
    });
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(fake.store.record?.state).toBe(state);
    expect(fake.nativeCalls).toHaveLength(1);
  });

  test("records transport exceptions as ambiguous and never retries", async () => {
    const fake = fixture();
    let calls = 0;
    fake.ports.nativeQueue.queueMessage = async () => {
      calls += 1;
      throw new Error("connection dropped after write");
    };
    const result = await sendSessionMessage(fake.ports, context(), {
      session_id: targetSessionId,
      content: "hello",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "admission_unknown" } });
    expect(fake.store.record?.state).toBe("admission_unknown");
    expect(calls).toBe(1);
  });

  test("an abort after submitting reports ambiguity even if admission settles late", async () => {
    const controller = new AbortController();
    const fake = fixture();
    fake.nativeEffect = () => controller.abort();
    const result = await sendSessionMessage(fake.ports, context(controller), {
      session_id: targetSessionId,
      content: "hello",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "admission_unknown", details: { delivery_id: deliveryId } },
    });
    expect(fake.store.events).not.toContain("cancelled");
  });

  test("an abort after submitting is ambiguous without an authoritative outcome", async () => {
    const controller = new AbortController();
    const fake = fixture();
    fake.nativeOutcome = { kind: "unknown" };
    fake.nativeEffect = () => controller.abort();
    const result = await sendSessionMessage(fake.ports, context(controller), {
      session_id: targetSessionId,
      content: "hello",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "admission_unknown" } });
    expect(fake.store.record?.state).toBe("admission_unknown");
    expect(fake.store.events).not.toContain("cancelled");
    expect(fake.nativeCalls[0]?.abort).toBe(controller.signal);
  });

  test("retains admitted and promoted native sequence evidence coherently", async () => {
    const fake = fixture();
    fake.nativeOutcome = {
      kind: "promoted",
      admittedSeq: 51,
      promotedSeq: 52,
      observedAtMs: 950,
    };
    const result = await sendSessionMessage(fake.ports, context(), {
      session_id: targetSessionId,
      content: "hello",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        state: "promoted",
        admissionEvidence: {
          state: "promoted",
          admittedSeq: 51,
          promotedSeq: 52,
          observedAtMs: 950,
        },
      },
    });
    expect(fake.store.events).toContain("complete:promoted");
    expect(fake.store.events.filter((event) => event.startsWith("complete:"))).toEqual([
      "complete:promoted",
    ]);
    expect(fake.store.record?.admittedAtMs).toBe(fake.store.record?.promotedAtMs);
  });

  test("does not manufacture promotion from incoherent native sequence evidence", async () => {
    const fake = fixture();
    fake.nativeOutcome = {
      kind: "promoted",
      admittedSeq: 60,
      promotedSeq: 59,
      observedAtMs: 950,
    };
    const result = await sendSessionMessage(fake.ports, context(), {
      session_id: targetSessionId,
      content: "hello",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "admission_unknown" } });
    expect(fake.store.record?.state).toBe("admission_unknown");
    expect(fake.store.record?.admissionEvidence).toBeUndefined();
    expect(fake.store.events).not.toContain("complete:promoted");
  });

  test.each(["storage_unavailable", "state_conflict"] as const)(
    "preserves safe delivery correlation for post-claim %s",
    async (code) => {
      const fake = fixture();
      fake.store.completeFailure = code;
      const result = await sendSessionMessage(fake.ports, context(), {
        session_id: targetSessionId,
        content: "hello",
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "admission_unknown", details: { delivery_id: deliveryId } },
      });
    },
  );

  test.each([
    [[false], undefined, 0],
    [[true, false], "cancelled", 0],
    [[true, true, false], "submitting", 0],
    [[true, true, true, false], "admission_unknown", 1],
  ] as const)("fails closed on ownership loss around the effect", async (owners, state, calls) => {
    const fake = fixture();
    fake.ownerStates.splice(0, fake.ownerStates.length, ...owners);
    const result = await sendSessionMessage(fake.ports, context(), {
      session_id: targetSessionId,
      content: "hello",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: calls === 1 ? "admission_unknown" : "ownership_lost" },
    });
    if (state === "submitting" || state === "admission_unknown") {
      expect(result).toMatchObject({
        ok: false,
        error: { details: { delivery_id: deliveryId } },
      });
    }
    expect(fake.store.record?.state).toBe(state);
    expect(fake.nativeCalls).toHaveLength(calls);
    expect(fake.lifecycleStops).toBe(calls === 1 ? 0 : 1);
  });
});
