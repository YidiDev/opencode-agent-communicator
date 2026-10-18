import { expect, test } from "bun:test";
import { ContextAdmissionRuntime } from "../../../src/application/context-admission-runtime";
import {
  type ImmediateRequestAdmissionPorts,
  persistAndAdmitImmediateRequest,
} from "../../../src/application/immediate-session-request-admission";
import { digestMessageContent } from "../../../src/domain/message-payload";
import { type FencingToken, OwnershipLostFault } from "../../../src/domain/ownership";
import { canonicalizeSerializeAndDigestPendingRequestPayload } from "../../../src/domain/request-serialization";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { requestDigestPort, requestFixture } from "../../support/request-store";

const token = 1 as FencingToken;

async function harness() {
  const original = await requestFixture(token, 10_000);
  const payload = await canonicalizeSerializeAndDigestPendingRequestPayload(requestDigestPort, {
    kind: "wait",
    milestone: "ready",
    timeoutSeconds: 30,
  });
  if (!payload.ok) throw new Error("invalid payload fixture");
  const workBytes = new TextEncoder().encode("work");
  const workSha256 = await digestMessageContent(requestDigestPort, workBytes);
  let prepared: RequestMetadata | undefined;
  let envelope: string | undefined;
  const ports = {
    readiness: {
      fencingToken: token,
      assertReady: () => undefined,
      ownershipLost: () => undefined,
    },
    requests: {
      createPrepared: async (input: { request: RequestMetadata; envelopeJson: string }) => {
        prepared = input.request;
        envelope = input.envelopeJson;
        return { ok: true as const, request: input.request };
      },
      claimPrepared: async () => {
        if (!prepared || !envelope) throw new Error("not prepared");
        return {
          ok: true as const,
          request: {
            ...prepared,
            deliveryState: "submitting" as const,
            submittedAtMs: 10_001,
            updatedAtMs: 10_001,
          },
          envelopeJson: envelope,
        };
      },
      completeDelivery: async () => {
        if (!prepared) throw new Error("not prepared");
        return {
          ok: true as const,
          request: {
            ...prepared,
            deliveryState: "delivery_unknown" as const,
            submittedAtMs: 10_001,
            deliveryUnknownAtMs: 10_002,
            updatedAtMs: 10_002,
          },
        };
      },
    },
    scheduler: { wake: () => undefined },
    nativeQueue: { queueMessage: async () => ({ kind: "unknown" as const }) },
    ownership: { isCurrent: async () => true },
    ids: {
      requestId: () => original.request.id,
      nativeMessageId: () => original.request.nativeMessageId,
      startOperationId: () => original.creationOperationId,
    },
    digest: { sha256: requestDigestPort.sha256.bind(requestDigestPort) },
    clock: { nowMs: () => 10_002 },
  } as unknown as ImmediateRequestAdmissionPorts;
  const controller = new AbortController();
  const input = {
    context: {
      workspaceKey: original.request.workspaceKey,
      sourceSessionId: original.request.sourceSessionId,
      fencingToken: token,
      abort: controller.signal,
      deadlineMs: 40_000,
    },
    args: { session_id: original.request.targetSessionId, content: "work" },
    payload,
    workBytes,
    workSha256,
    createdAtMs: 10_000,
    deadlineAtMs: 40_000,
    interrupted: () =>
      ({ ok: false as const, error: { code: "request_cancelled" as const } }) as never,
  };
  return { controller, input, ports, prepared: () => prepared };
}

test("immediate persistence validates every explicit store failure classification", async () => {
  for (const [raw, code] of [
    [null, "storage_unavailable"],
    [{ ok: false, code: "ownership_lost" }, "ownership_lost"],
    [{ ok: false, code: "quota_exceeded" }, "quota_exceeded"],
    [{ ok: false, code: "rate_limited" }, "rate_limited"],
    [{ ok: false, code: "future" }, "storage_unavailable"],
  ] as const) {
    const value = await harness();
    value.ports.requests.createPrepared = async () => raw as never;
    expect(await persistAndAdmitImmediateRequest(value.ports, value.input)).toMatchObject({
      ok: false,
      error: { code },
    });
  }
});

test("immediate persistence contains envelope overflow and ambiguous creation", async () => {
  const overflow = await harness();
  overflow.ports.digest.sha256 = async () => {
    throw new RangeError("too large");
  };
  expect(await persistAndAdmitImmediateRequest(overflow.ports, overflow.input)).toMatchObject({
    ok: false,
    error: { code: "invalid_arguments" },
  });

  const rejected = await harness();
  rejected.ports.requests.createPrepared = async () => {
    throw new Error("creation outcome unknown");
  };
  expect(await persistAndAdmitImmediateRequest(rejected.ports, rejected.input)).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable", details: { request_id: expect.any(String) } },
  });

  const lost = await harness();
  lost.ports.requests.createPrepared = async () => {
    throw new OwnershipLostFault();
  };
  expect(await persistAndAdmitImmediateRequest(lost.ports, lost.input)).toMatchObject({
    ok: false,
    error: { code: "ownership_lost", details: { request_id: expect.any(String) } },
  });
});

test("immediate persistence cannot trust an advanced claim without durable reconciliation", async () => {
  const value = await harness();
  value.ports.requests.createPrepared = async (input) => ({
    ok: true,
    request: {
      ...input.request,
      deliveryState: "submitting",
      submittedAtMs: 10_001,
      updatedAtMs: 10_001,
    },
  });
  expect(await persistAndAdmitImmediateRequest(value.ports, value.input)).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable" },
  });
});

test.each(["rejected", "malformed", "missing-envelope"] as const)(
  "reconciles a committed %s claim without replaying native I/O",
  async (mode) => {
    const value = await harness();
    const claim = value.ports.requests.claimPrepared;
    let committed: Awaited<ReturnType<typeof claim>> | undefined;
    let nativeCalls = 0;
    value.ports.requests.claimPrepared = async (input) => {
      committed = await claim(input);
      if (mode === "rejected") throw new Error("lost claim response");
      if (mode === "malformed") return null as never;
      return { ok: true, request: committed.ok ? committed.request : undefined } as never;
    };
    value.ports.requests.reconcilePreparedClaim = async () => {
      if (
        !committed?.ok ||
        !committed.envelopeJson ||
        committed.request.deliveryState !== "submitting"
      )
        throw new Error("missing durable claim");
      return {
        outcome: "current_claim",
        request: committed.request as never,
        envelopeJson: committed.envelopeJson,
      };
    };
    value.ports.nativeQueue.queueMessage = async () => {
      nativeCalls += 1;
      return { kind: "unknown" };
    };
    expect(await persistAndAdmitImmediateRequest(value.ports, value.input)).toMatchObject({
      ok: true,
      value: { deliveryState: "delivery_unknown" },
    });
    expect(nativeCalls).toBe(0);
  },
);

test("immediate claim ambiguity is never replayed and malformed claims fail closed", async () => {
  for (const outcome of ["rejected", "malformed", "settled", "missing-envelope"] as const) {
    const value = await harness();
    value.ports.requests.claimPrepared = (async () => {
      if (outcome === "rejected") throw new Error("claim outcome unknown");
      const prepared = value.prepared();
      if (!prepared) throw new Error("missing preparation");
      if (outcome === "malformed") return null as never;
      if (outcome === "settled") return { ok: true, request: prepared, envelopeJson: "{}" };
      return {
        ok: true,
        request: {
          ...prepared,
          deliveryState: "submitting",
          submittedAtMs: 10_001,
          updatedAtMs: 10_001,
        },
      } as never;
    }) as never;
    expect(await persistAndAdmitImmediateRequest(value.ports, value.input)).toMatchObject(
      outcome === "settled"
        ? { ok: true, value: { deliveryState: "prepared" } }
        : { ok: false, error: { code: "storage_unavailable" } },
    );
  }
});

test("immediate admission honors cancellation before persistence and while claiming", async () => {
  const before = await harness();
  before.controller.abort("cancelled");
  expect(await persistAndAdmitImmediateRequest(before.ports, before.input)).toMatchObject({
    ok: false,
    error: { code: "request_cancelled" },
  });

  const claim = await harness();
  claim.ports.requests.claimPrepared = () => {
    claim.controller.abort("cancelled");
    return new Promise<never>(() => undefined);
  };
  expect(await persistAndAdmitImmediateRequest(claim.ports, claim.input)).toMatchObject({
    ok: false,
    error: { code: "request_cancelled" },
  });
});

test.each(["create", "claim"] as const)(
  "lifecycle shutdown interrupts %s without a native replay",
  async (phase) => {
    const value = await harness();
    const runtime = new ContextAdmissionRuntime();
    const ports = { ...value.ports, contextRuntime: runtime };
    const key = phase === "create" ? "createPrepared" : "claimPrepared";
    ports.requests[key] = async () => {
      runtime.stop("shutdown");
      return new Promise<never>(() => {});
    };
    expect(await persistAndAdmitImmediateRequest(ports, value.input)).toMatchObject({
      ok: false,
      error: { code: "request_cancelled" },
    });
  },
);

test.each([
  "malformed",
  "foreign",
  "prepared",
  "settled",
  "terminal",
  "submitting",
  "aborted-read",
  "aborted-write",
  "bad-write",
  "wrong-write",
  "lost",
  "error",
] as const)("ambiguous claim reconciliation stays fail-closed for %s", async (mode) => {
  const value = await harness();
  const runtime = new ContextAdmissionRuntime();
  const ports = { ...value.ports, contextRuntime: runtime };
  const claim = ports.requests.claimPrepared;
  let committed: RequestMetadata | undefined;
  ports.requests.claimPrepared = async (input) => {
    const result = await claim(input);
    if (!result.ok) throw new Error("fixture claim failed");
    committed = result.request;
    return null as never;
  };
  ports.requests.reconcilePreparedClaim = async () => {
    if (!committed) throw new Error("no committed claim");
    if (mode === "malformed") return null as never;
    if (mode === "foreign")
      return {
        outcome: "current_claim",
        request: { ...committed, targetSessionId: committed.sourceSessionId },
      } as never;
    if (mode === "prepared")
      return { outcome: "still_prepared", request: value.prepared() } as never;
    if (mode === "settled")
      return {
        outcome: "settled",
        request: {
          ...committed,
          deliveryState: "delivery_unknown",
          deliveryUnknownAtMs: 10_002,
          updatedAtMs: 10_002,
        },
      } as never;
    if (mode === "terminal") {
      const terminal = {
        ...committed,
        resolutionState: "cancelled",
        resolvedAtMs: 10_002,
        updatedAtMs: 10_002,
      };
      Reflect.deleteProperty(terminal, "payloadSha256");
      return {
        outcome: "settled",
        request: terminal,
      } as never;
    }
    if (mode === "submitting") return { outcome: "settled", request: committed } as never;
    if (mode === "lost") throw new OwnershipLostFault();
    if (mode === "error") throw new Error("read failed");
    if (mode === "aborted-read") {
      runtime.stop("shutdown");
      return new Promise<never>(() => {});
    }
    return { outcome: "current_claim", request: committed, envelopeJson: "retained" } as never;
  };
  const complete = ports.requests.completeDelivery;
  ports.requests.completeDelivery = async (input) => {
    if (mode === "aborted-write") {
      runtime.stop("shutdown");
      return new Promise<never>(() => {});
    }
    if (mode === "bad-write") return null as never;
    if (mode === "wrong-write") return { ok: true, request: value.prepared() } as never;
    return complete(input);
  };
  let nativeCalls = 0;
  ports.nativeQueue.queueMessage = async () => {
    nativeCalls += 1;
    return { kind: "unknown" };
  };
  expect(await persistAndAdmitImmediateRequest(ports, value.input)).toMatchObject(
    mode === "settled" || mode === "terminal"
      ? { ok: true }
      : { ok: false, error: { code: mode === "lost" ? "ownership_lost" : "storage_unavailable" } },
  );
  expect(nativeCalls).toBe(0);
});

test.each(["create", "claim", "queue"] as const)(
  "caller abort during %s settles the durable claim without restart",
  async (phase) => {
    const value = await harness();
    let queueCalls = 0;
    let completeCalls = 0;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const create = value.ports.requests.createPrepared;
    const claim = value.ports.requests.claimPrepared;
    const complete = value.ports.requests.completeDelivery;
    value.ports.requests.createPrepared = async (input) => {
      if (phase === "create") {
        entered();
        await paused;
      }
      return create(input);
    };
    value.ports.requests.claimPrepared = async (input) => {
      const result = await claim(input);
      if (phase === "claim") {
        entered();
        await paused;
      }
      return result;
    };
    value.ports.nativeQueue.queueMessage = async () => {
      queueCalls += 1;
      entered();
      await paused;
      return { kind: "unknown" };
    };
    let settled!: () => void;
    const persisted = new Promise<void>((resolve) => {
      settled = resolve;
    });
    value.ports.requests.completeDelivery = async (input) => {
      completeCalls += 1;
      expect(input.outcome).toBe("delivery_unknown");
      const result = await complete(input);
      settled();
      return result;
    };
    const foreground = persistAndAdmitImmediateRequest(value.ports, value.input);
    await started;
    value.controller.abort();
    expect(await foreground).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
    release();
    await persisted;
    expect(completeCalls).toBe(1);
    expect(queueCalls).toBe(phase === "queue" ? 1 : 0);
  },
);
