import { expect, test } from "bun:test";

import {
  admitClaimedSessionRequest,
  type ClaimedSessionRequestAdmissionPorts,
} from "../../../src/application/admit-claimed-session-request";
import { claimAndAdmitBlockingRequest } from "../../../src/application/blocking-session-request-admission";
import type { SessionBlockingRequestPorts } from "../../../src/application/blocking-session-request-boundaries";
import type { NativeSteerAdmission } from "../../../src/application/request-ports";
import { RequestRuntime } from "../../../src/application/request-runtime";
import { type FencingToken, OwnershipLostFault } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { requestFixture } from "../../support/request-store";

const token = 1 as FencingToken;

async function submittingFixture() {
  const fixture = await requestFixture(token, 1_000);
  return {
    ...fixture,
    request: {
      ...fixture.request,
      deliveryState: "submitting" as const,
      submittedAtMs: 1_001,
      updatedAtMs: 1_001,
    },
  };
}

function unknownCompletion(request: RequestMetadata): RequestMetadata {
  return {
    ...request,
    deliveryState: "delivery_unknown" as const,
    deliveryUnknownAtMs: 1_002,
    updatedAtMs: 1_002,
  } as unknown as RequestMetadata;
}

function admissionHarness(request: Awaited<ReturnType<typeof submittingFixture>>["request"]) {
  const ports: ClaimedSessionRequestAdmissionPorts = {
    requests: {
      completeDelivery: async () => ({ ok: true, request: unknownCompletion(request) }),
    } as unknown as ClaimedSessionRequestAdmissionPorts["requests"],
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" }) },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    notifications: { notifyTerminal: () => undefined },
    clock: { nowMs: () => 1_001 },
  };
  const input = {
    workspaceKey: request.workspaceKey,
    fencingToken: token,
    request,
    envelope: "{}",
    control: { abort: new AbortController().signal, deadlineMs: 9_000 },
    effectSignal: new AbortController().signal,
  };
  return { ports, input };
}

test("claimed admission classifies ownership and persistence rejection boundaries", async () => {
  const fixture = await submittingFixture();
  for (const [cause, code] of [
    [new OwnershipLostFault("lost"), "ownership_lost"],
    [new Error("disk"), "storage_unavailable"],
  ] as const) {
    const before = admissionHarness(fixture.request);
    before.ports.ownership.isCurrent = async () => {
      throw cause;
    };
    expect(await admitClaimedSessionRequest(before.ports, before.input)).toMatchObject({
      ok: false,
      error: { code },
    });

    const after = admissionHarness(fixture.request);
    let checks = 0;
    after.ports.ownership.isCurrent = async () => {
      checks += 1;
      if (checks === 2) throw cause;
      return true;
    };
    expect(await admitClaimedSessionRequest(after.ports, after.input)).toMatchObject({
      ok: false,
      error: { code },
    });

    const completion = admissionHarness(fixture.request);
    completion.ports.requests.completeDelivery = async () => {
      throw cause;
    };
    expect(await admitClaimedSessionRequest(completion.ports, completion.input)).toMatchObject({
      ok: false,
      error: { code },
    });
  }
});

test("lifecycle interruption never commits an ambiguous native effect", async () => {
  const fixture = await submittingFixture();
  const harness = admissionHarness(fixture.request);
  const lifecycle = new AbortController();
  let completeCalls = 0;
  harness.ports.nativeSteer.steerRequest = (_input) =>
    new Promise<NativeSteerAdmission>((resolve) => {
      lifecycle.abort("lost");
      resolve({ kind: "definitive_rejection" });
    });
  harness.ports.requests.completeDelivery = async () => {
    completeCalls += 1;
    return { ok: true, request: unknownCompletion(fixture.request) };
  };
  expect(
    await admitClaimedSessionRequest(harness.ports, {
      ...harness.input,
      effectSignal: lifecycle.signal,
    }),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  expect(completeCalls).toBe(0);
});

test("caller abort before native is persisted as unknown only for blocking admission", async () => {
  const fixture = await submittingFixture();
  const harness = admissionHarness(fixture.request);
  const caller = new AbortController();
  caller.abort("caller");
  let nativeCalls = 0;
  harness.ports.nativeSteer.steerRequest = async () => {
    nativeCalls += 1;
    return { kind: "definitive_rejection" };
  };
  expect(
    await admitClaimedSessionRequest(harness.ports, {
      ...harness.input,
      control: { ...harness.input.control, abort: caller.signal },
      callerAbortPersistsUnknown: true,
    }),
  ).toMatchObject({ ok: true, value: { outcome: "delivery_unknown" } });
  expect(nativeCalls).toBe(0);

  expect(
    await admitClaimedSessionRequest(harness.ports, {
      ...harness.input,
      control: { ...harness.input.control, abort: caller.signal },
    }),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});

test("admission rechecks caller and lifecycle interruption on both sides of the native effect", async () => {
  const fixture = await submittingFixture();
  const callerRace = admissionHarness(fixture.request);
  const caller = new AbortController();
  callerRace.ports.ownership.isCurrent = async () => {
    caller.abort("cancelled_during_ownership");
    return true;
  };
  expect(
    await admitClaimedSessionRequest(callerRace.ports, {
      ...callerRace.input,
      control: { abort: caller.signal, deadlineMs: 9_000 },
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "ownership_lost" },
  });

  const lifecycleRace = admissionHarness(fixture.request);
  const lifecycle = new AbortController();
  let checks = 0;
  lifecycleRace.ports.ownership.isCurrent = async () => {
    checks += 1;
    if (checks === 2) lifecycle.abort("lost_after_native");
    return new Promise((resolve) => queueMicrotask(() => resolve(true)));
  };
  expect(
    await admitClaimedSessionRequest(lifecycleRace.ports, {
      ...lifecycleRace.input,
      effectSignal: lifecycle.signal,
    }),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});

test("admission preserves exact state-conflict failures and contains hostile effect signals", async () => {
  const fixture = await submittingFixture();
  const conflict = admissionHarness(fixture.request);
  conflict.ports.requests.completeDelivery = async () => ({ ok: false, code: "state_conflict" });
  expect(await admitClaimedSessionRequest(conflict.ports, conflict.input)).toMatchObject({
    ok: false,
    error: { code: "state_conflict" },
  });

  const hostile = admissionHarness(fixture.request);
  const effectSignal = new Proxy(new AbortController().signal, {
    get(target, key, receiver) {
      if (key === "aborted") throw new Error("hostile signal");
      return Reflect.get(target, key, receiver);
    },
  });
  expect(
    await admitClaimedSessionRequest(hostile.ports, { ...hostile.input, effectSignal }),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});

function blockingHarness(prepared: Awaited<ReturnType<typeof requestFixture>>["request"]) {
  const runtime = new RequestRuntime();
  const ports = {
    requests: {},
    ownership: { isCurrent: async () => true },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" as const }) },
    workflowFault: { fault: () => undefined },
    deadlineTimer: { arm: () => ({ cancel: () => undefined }) },
    clock: { nowMs: () => prepared.createdAtMs },
    scheduler: { wake: () => undefined },
    runtime,
    notifications: runtime,
  } as unknown as SessionBlockingRequestPorts;
  const context = {
    workspaceKey: prepared.workspaceKey,
    sourceSessionId: prepared.sourceSessionId,
    fencingToken: token,
    abort: new AbortController().signal,
    deadlineMs: prepared.deadlineAtMs,
  };
  return { ports, context };
}

test("blocking claim rejects exact and malformed store failures without starting native admission", async () => {
  const prepared = (await requestFixture(token)).request;
  for (const [claim, code] of [
    [{ ok: false, code: "ownership_lost" }, "ownership_lost"],
    [{ ok: false, code: "quota_exceeded" }, "quota_exceeded"],
    [{ ok: false, code: "state_conflict" }, "storage_unavailable"],
    [{ ok: false, code: "ownership_lost", extra: true }, "storage_unavailable"],
    [{ ok: "yes" }, "storage_unavailable"],
  ] as const) {
    const harness = blockingHarness(prepared);
    harness.ports.requests.claimPrepared = async () => claim as never;
    expect(
      await claimAndAdmitBlockingRequest(
        harness.ports,
        harness.context,
        prepared,
        new AbortController(),
      ),
    ).toMatchObject({ ok: false, error: { code } });
  }
});

test("blocking claim accepts terminal races and rejects malformed submitting envelopes", async () => {
  const prepared = (await requestFixture(token)).request;
  const { payloadSha256: _payloadSha256, ...terminalBase } = prepared;
  const terminal = {
    ...terminalBase,
    resolutionState: "deadline_expired" as const,
    resolvedAtMs: prepared.deadlineAtMs,
    updatedAtMs: prepared.deadlineAtMs,
  };
  for (const claim of [
    { ok: true, request: terminal },
    { ok: true, request: prepared },
  ]) {
    const harness = blockingHarness(prepared);
    harness.ports.requests.claimPrepared = async () => claim as never;
    expect(
      await claimAndAdmitBlockingRequest(
        harness.ports,
        harness.context,
        prepared,
        new AbortController(),
      ),
    ).toEqual({ ok: true, value: undefined });
  }
  const submitting = await submittingFixture();
  const malformed = blockingHarness(prepared);
  malformed.ports.requests.claimPrepared = async () => ({ ok: true, request: submitting.request });
  expect(
    await claimAndAdmitBlockingRequest(
      malformed.ports,
      malformed.context,
      prepared,
      new AbortController(),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});

test("ambiguous blocking claims fail closed when foreground and cleanup infrastructure is malformed", async () => {
  const prepared = (await requestFixture(token)).request;
  for (const portsOverride of [
    { clock: { nowMs: () => Number.NaN } },
    {
      deadlineTimer: {
        arm: () => {
          throw new Error("timer");
        },
      },
    },
  ]) {
    const harness = blockingHarness(prepared);
    harness.ports.requests.claimPrepared = async () => {
      throw new Error("ambiguous");
    };
    Object.assign(harness.ports, portsOverride);
    expect(
      await claimAndAdmitBlockingRequest(
        harness.ports,
        harness.context,
        prepared,
        new AbortController(),
      ),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  }
});

test("ambiguous reconciliation validates absent and settled claim shapes", async () => {
  const prepared = (await requestFixture(token)).request;
  for (const [reconciliation, succeeds] of [
    [{ outcome: "absent_or_other_claim", extra: true }, false],
    [{ outcome: "settled", request: prepared }, true],
    [{ outcome: "current_claim", request: prepared, envelopeJson: 1 }, false],
  ] as const) {
    const harness = blockingHarness(prepared);
    harness.ports.requests.claimPrepared = async () => {
      throw new Error("ambiguous");
    };
    harness.ports.requests.reconcilePreparedClaim = async () => reconciliation as never;
    const result = await claimAndAdmitBlockingRequest(
      harness.ports,
      harness.context,
      prepared,
      new AbortController(),
    );
    expect(result.ok).toBe(succeeds);
    if (!succeeds) expect(result).toMatchObject({ error: { code: "storage_unavailable" } });
  }
});

test("blocking claim validates exact non-submitting and reconciliation envelope shapes", async () => {
  const prepared = (await requestFixture(token)).request;
  for (const claim of [
    { ok: true, request: prepared, envelopeJson: "unexpected" },
    { ok: false, code: 1 },
  ]) {
    const harness = blockingHarness(prepared);
    harness.ports.requests.claimPrepared = async () => claim as never;
    expect(
      await claimAndAdmitBlockingRequest(
        harness.ports,
        harness.context,
        prepared,
        new AbortController(),
      ),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  }
  for (const reconciliation of [
    { outcome: "absent_or_other_claim" },
    { outcome: "still_prepared", request: { ...prepared, resolutionState: "cancelled" } },
  ]) {
    const harness = blockingHarness(prepared);
    harness.ports.requests.claimPrepared = async () => {
      throw new Error("ambiguous");
    };
    harness.ports.requests.reconcilePreparedClaim = async () => reconciliation as never;
    expect(
      await claimAndAdmitBlockingRequest(
        harness.ports,
        harness.context,
        prepared,
        new AbortController(),
      ),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  }
});

test("current ambiguous claims validate completion and retry settlement contracts", async () => {
  const prepared = (await requestFixture(token)).request;
  const submitting = {
    ...prepared,
    deliveryState: "submitting" as const,
    submittedAtMs: prepared.createdAtMs + 1,
    updatedAtMs: prepared.createdAtMs + 1,
  };
  const current = { outcome: "current_claim" as const, request: submitting, envelopeJson: "{}" };
  const harness = blockingHarness(prepared);
  harness.ports.requests.claimPrepared = async () => {
    throw new Error("ambiguous");
  };
  harness.ports.requests.reconcilePreparedClaim = async () => current;
  harness.ports.requests.completeDelivery = async () => null as never;
  expect(
    await claimAndAdmitBlockingRequest(
      harness.ports,
      harness.context,
      prepared,
      new AbortController(),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  const retry = blockingHarness(prepared);
  let claims = 0;
  retry.ports.requests.claimPrepared = async () => {
    claims += 1;
    if (claims === 1) throw new Error("ambiguous");
    return { ok: null } as never;
  };
  let reconciles = 0;
  retry.ports.requests.reconcilePreparedClaim = async () => {
    reconciles += 1;
    return reconciles === 1 ? { outcome: "still_prepared", request: prepared } : (null as never);
  };
  expect(
    await claimAndAdmitBlockingRequest(retry.ports, retry.context, prepared, new AbortController()),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  const stopped = blockingHarness(prepared);
  stopped.ports.requests.claimPrepared = async () => {
    throw new Error("ambiguous");
  };
  stopped.ports.runtime.stop("shutdown");
  expect(
    await claimAndAdmitBlockingRequest(
      stopped.ports,
      stopped.context,
      prepared,
      new AbortController(),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});
