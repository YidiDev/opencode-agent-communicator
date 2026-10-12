import { expect, test } from "bun:test";

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

test("immediate persistence returns a coherent record already advanced by the store", async () => {
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
    ok: true,
    value: { deliveryState: "submitting" },
  });
});

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
