import { expect, test } from "bun:test";

import { claimAndAdmitBlockingRequest } from "../../../src/application/blocking-session-request-admission";
import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "../../../src/application/blocking-session-request-boundaries";
import { RequestRuntime } from "../../../src/application/request-runtime";
import { type FencingToken, OwnershipLostFault } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { requestFixture } from "../../support/request-store";

const token = 1 as FencingToken;

async function harness() {
  const prepared = (await requestFixture(token, 1_000)).request;
  const submitting = {
    ...prepared,
    deliveryState: "submitting" as const,
    submittedAtMs: 1_001,
    updatedAtMs: 1_001,
  };
  const unknown: RequestMetadata = {
    ...submitting,
    deliveryState: "delivery_unknown",
    deliveryUnknownAtMs: 1_002,
    updatedAtMs: 1_002,
  };
  const runtime = new RequestRuntime();
  const calls: string[] = [];
  const ports = {
    requests: {
      claimPrepared: async () => ({ ok: true, request: submitting, envelopeJson: "{}" }),
      reconcilePreparedClaim: async () => ({
        outcome: "current_claim" as const,
        request: submitting,
        envelopeJson: "{}",
      }),
      completeDelivery: async () => ({ ok: true, request: unknown }),
    },
    ownership: { isCurrent: async () => true },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" as const }) },
    workflowFault: { fault: () => calls.push("fault") },
    deadlineTimer: { arm: () => ({ cancel: () => undefined }) },
    clock: { nowMs: () => 1_001 },
    scheduler: { wake: () => calls.push("wake") },
    runtime,
    notifications: runtime,
  } as unknown as SessionBlockingRequestPorts;
  const context: SessionBlockingRequestContext = {
    workspaceKey: prepared.workspaceKey,
    sourceSessionId: prepared.sourceSessionId,
    fencingToken: token,
    abort: new AbortController().signal,
    deadlineMs: prepared.deadlineAtMs,
  };
  return { calls, context, ports, prepared, submitting, unknown };
}

async function drain(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

test("classifies an already-submitting current claim by durably recording ambiguity", async () => {
  const value = await harness();
  expect(
    await claimAndAdmitBlockingRequest(
      value.ports,
      value.context,
      value.submitting,
      new AbortController(),
    ),
  ).toEqual({ ok: true, value: undefined });
});

test("accepts a settled ambiguity after completion loses its result", async () => {
  const value = await harness();
  let reconciles = 0;
  value.ports.requests.completeDelivery = async () => ({ ok: false, code: "state_conflict" });
  value.ports.requests.reconcilePreparedClaim = async () => {
    reconciles += 1;
    return reconciles === 1
      ? { outcome: "current_claim", request: value.submitting, envelopeJson: "{}" }
      : { outcome: "settled", request: value.unknown };
  };
  expect(
    await claimAndAdmitBlockingRequest(
      value.ports,
      value.context,
      value.submitting,
      new AbortController(),
    ),
  ).toEqual({ ok: true, value: undefined });
});

test("faults an unresolved submitting claim only while ownership remains current", async () => {
  for (const owner of [true, false]) {
    const value = await harness();
    value.ports.requests.completeDelivery = async () => null as never;
    value.ports.requests.reconcilePreparedClaim = async () => ({
      outcome: "current_claim",
      request: value.submitting,
      envelopeJson: "{}",
    });
    value.ports.ownership.isCurrent = async () => owner;
    expect(
      await claimAndAdmitBlockingRequest(
        value.ports,
        value.context,
        value.submitting,
        new AbortController(),
      ),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    expect(value.calls).toContain("wake");
    expect(value.calls.includes("fault")).toBe(owner);
  }
});

test("retries a still-prepared ambiguous claim through the common claim boundary", async () => {
  const value = await harness();
  let claims = 0;
  value.ports.requests.claimPrepared = async () => {
    claims += 1;
    if (claims === 1) throw new Error("claim outcome lost");
    return { ok: true, request: value.submitting, envelopeJson: "{}" };
  };
  value.ports.requests.reconcilePreparedClaim = async () => ({
    outcome: "still_prepared",
    request: value.prepared,
  });
  expect(
    await claimAndAdmitBlockingRequest(
      value.ports,
      value.context,
      value.prepared,
      new AbortController(),
    ),
  ).toEqual({ ok: true, value: undefined });
  await drain();
  expect(claims).toBe(2);
});

test("maps exceptions thrown while entering ambiguous reconciliation", async () => {
  for (const [cause, code] of [
    [new OwnershipLostFault(), "ownership_lost"],
    [new Error("hostile abort signal"), "storage_unavailable"],
  ] as const) {
    const value = await harness();
    const context = new Proxy(value.context, {
      get(target, key, receiver) {
        if (key === "abort") throw cause;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(
      await claimAndAdmitBlockingRequest(
        value.ports,
        context,
        value.submitting,
        new AbortController(),
      ),
    ).toMatchObject({ ok: false, error: { code } });
  }
});

test("background admission cleanup handles non-submitting and repeated current claims", async () => {
  for (const outcome of ["still_prepared", "settled"] as const) {
    const value = await harness();
    value.ports.ownership.isCurrent = async () => false;
    value.ports.requests.reconcilePreparedClaim = async () =>
      outcome === "still_prepared"
        ? { outcome, request: value.prepared }
        : { outcome, request: value.unknown };
    expect(
      await claimAndAdmitBlockingRequest(
        value.ports,
        value.context,
        value.prepared,
        new AbortController(),
      ),
    ).toEqual({ ok: true, value: undefined });
    await drain();
    expect(value.calls).toContain("wake");
  }

  const repeated = await harness();
  repeated.ports.ownership.isCurrent = async () => false;
  repeated.ports.requests.completeDelivery = async () => null as never;
  repeated.ports.requests.reconcilePreparedClaim = async () => ({
    outcome: "current_claim",
    request: repeated.submitting,
    envelopeJson: "{}",
  });
  expect(
    await claimAndAdmitBlockingRequest(
      repeated.ports,
      repeated.context,
      repeated.prepared,
      new AbortController(),
    ),
  ).toEqual({ ok: true, value: undefined });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(repeated.calls).toContain("wake");

  const rejected = await harness();
  rejected.ports.ownership.isCurrent = async () => false;
  rejected.ports.requests.reconcilePreparedClaim = async () => {
    throw new Error("reconciliation unavailable");
  };
  expect(
    await claimAndAdmitBlockingRequest(
      rejected.ports,
      rejected.context,
      rejected.prepared,
      new AbortController(),
    ),
  ).toEqual({ ok: true, value: undefined });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(rejected.calls).toContain("wake");
});
