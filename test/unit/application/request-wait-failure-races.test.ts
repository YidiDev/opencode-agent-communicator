import { expect, test } from "bun:test";

import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "../../../src/application/blocking-session-request-boundaries";
import { blockUntilRequestTerminal } from "../../../src/application/blocking-session-request-wait";
import type { RequestRuntimeRegistration } from "../../../src/application/request-runtime";
import { RequestRuntime } from "../../../src/application/request-runtime";
import { type FencingToken, OwnershipLostFault } from "../../../src/domain/ownership";
import type { PendingRequestMetadata } from "../../../src/domain/request-types";
import { requestFixture } from "../../support/request-store";

const token = 1 as FencingToken;
const payload = { kind: "wait", milestone: "ready", timeoutSeconds: 30 } as const;

function metadata(request: PendingRequestMetadata) {
  return {
    requestId: request.id,
    participantRole: "source" as const,
    kind: request.kind,
    sourceSessionId: request.sourceSessionId,
    targetSessionId: request.targetSessionId,
    resolutionState: "pending" as const,
    deliveryState: request.deliveryState,
    resultState: "none" as const,
    createdAtMs: request.createdAtMs,
    updatedAtMs: request.updatedAtMs,
    deadlineAtMs: request.deadlineAtMs,
  };
}

function pendingProjection(request: PendingRequestMetadata) {
  return {
    outcome: "metadata",
    view: "source_pending",
    metadata: metadata(request),
    terminalized: [],
  };
}

function setup(
  request: PendingRequestMetadata,
  getParticipantRequest: () => Promise<unknown>,
  overrides: Partial<SessionBlockingRequestPorts> = {},
) {
  const runtime = new RequestRuntime();
  const registration = runtime.attachProvisional({
    requestId: request.id,
    expectedKind: request.kind,
    sourceSessionId: request.sourceSessionId,
    workspaceKey: request.workspaceKey,
  });
  const context: SessionBlockingRequestContext = {
    workspaceKey: request.workspaceKey,
    sourceSessionId: request.sourceSessionId,
    fencingToken: token,
    abort: new AbortController().signal,
    deadlineMs: request.deadlineAtMs,
  };
  const ports = {
    runtime,
    notifications: runtime,
    requests: {
      getParticipantRequest,
      cancelPending: async () => ({ ok: false, code: "storage_unavailable" as const }),
    },
    clock: { nowMs: () => request.createdAtMs },
    scheduler: { wake: () => undefined },
    deadlineTimer: { arm: () => ({ cancel: () => undefined }) },
    workflowFault: { fault: () => undefined },
    ...overrides,
  } as unknown as SessionBlockingRequestPorts;
  return { runtime, registration, context, ports };
}

async function runProjection(request: PendingRequestMetadata, projection: unknown) {
  const harness = setup(request, async () => projection);
  return blockUntilRequestTerminal(
    harness.ports,
    harness.context,
    request,
    harness.registration,
    payload,
    new AbortController(),
  );
}

test("authoritative reads reject malformed notification and projection envelopes", async () => {
  const request = (await requestFixture(token)).request;
  const base = pendingProjection(request);
  const malformed = [
    { ...base, terminalized: undefined },
    { ...base, terminalized: {} },
    { ...base, terminalized: [request] },
    { ...base, outcome: 1 },
    { ...base, extra: true },
    { ...base, metadata: { ...base.metadata, participantRole: "target" } },
    { ...base, view: "source_unsuccessful_terminal" },
    { outcome: "unexpected", view: "source_pending", metadata: base.metadata, terminalized: [] },
  ];
  for (const projection of malformed) {
    expect(await runProjection(request, projection)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
  }
});

test("available wait results validate retention and result snapshots before succeeding", async () => {
  const request = (await requestFixture(token)).request;
  const resolvedAtMs = request.createdAtMs + 3;
  const resultBase = {
    outcome: "available_result",
    metadata: {
      ...metadata(request),
      resolutionState: "reached",
      deliveryState: "admitted",
      resultState: "available",
      submittedAtMs: request.createdAtMs + 1,
      admittedAtMs: request.createdAtMs + 2,
      resolvedAtMs,
      updatedAtMs: resolvedAtMs,
      resultAvailableAtMs: resolvedAtMs,
      resultExpiresAtMs: resolvedAtMs + 10,
    },
    result: { kind: "wait", evidence: "done" },
    terminalized: [],
  };
  expect(await runProjection(request, resultBase)).toEqual({
    ok: true,
    value: { request_id: request.id, state: "reached", evidence: "done" },
  });
  for (const projection of [
    { ...resultBase, result: { kind: "other" } },
    { ...resultBase, result: { kind: "ask", answers: {} } },
    { ...resultBase, result: { kind: "ask", answers: [["yes"], {}] } },
    {
      ...resultBase,
      metadata: { ...resultBase.metadata, resultExpiresAtMs: resolvedAtMs - 1 },
    },
    {
      ...resultBase,
      metadata: { ...resultBase.metadata, resolutionState: "cancelled" },
    },
  ]) {
    expect(await runProjection(request, projection)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
  }
});

test("foreground authority maps ownership rejection and bounds malformed local infrastructure", async () => {
  const request = (await requestFixture(token)).request;
  const rejected = setup(request, async () => {
    throw new OwnershipLostFault("lost");
  });
  expect(
    await blockUntilRequestTerminal(
      rejected.ports,
      rejected.context,
      request,
      rejected.registration,
      payload,
      new AbortController(),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  for (const overrides of [
    { clock: { nowMs: () => Number.NaN } },
    {
      deadlineTimer: {
        arm: () => {
          throw new Error("timer unavailable");
        },
      },
    },
  ]) {
    const harness = setup(request, async () => pendingProjection(request), overrides as never);
    expect(
      await blockUntilRequestTerminal(
        harness.ports,
        harness.context,
        request,
        harness.registration,
        payload,
        new AbortController(),
      ),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  }
});

test("reattachment capacity race performs one final authoritative read", async () => {
  const request = (await requestFixture(token)).request;
  let resolveWake!: (value: { outcome: "reconcile" }) => void;
  const registration: RequestRuntimeRegistration = {
    expectedKind: request.kind,
    outcome: new Promise((resolve) => {
      resolveWake = resolve;
    }),
    detach: () => undefined,
  };
  let reads = 0;
  const terminal = {
    outcome: "metadata",
    view: "source_unsuccessful_terminal",
    metadata: {
      ...metadata(request),
      resolutionState: "cancelled",
      resolvedAtMs: request.createdAtMs + 1,
      updatedAtMs: request.createdAtMs + 1,
    },
    terminalized: [],
  };
  const effectSignal = new AbortController().signal;
  const ports = {
    runtime: {
      effectSignal,
      attach: () => {
        throw new Error("capacity");
      },
      wakeRequest: () => undefined,
    },
    notifications: { notifyTerminal: () => undefined },
    requests: {
      getParticipantRequest: async () => {
        reads += 1;
        return reads === 1 ? pendingProjection(request) : terminal;
      },
    },
    clock: { nowMs: () => request.createdAtMs },
    scheduler: { wake: () => undefined },
    deadlineTimer: { arm: () => ({ cancel: () => undefined }) },
  } as unknown as SessionBlockingRequestPorts;
  const blocked = blockUntilRequestTerminal(
    ports,
    {
      workspaceKey: request.workspaceKey,
      sourceSessionId: request.sourceSessionId,
      fencingToken: token,
      abort: new AbortController().signal,
      deadlineMs: request.deadlineAtMs,
    },
    request,
    registration,
    payload,
    new AbortController(),
  );
  while (reads < 1) await Promise.resolve();
  resolveWake({ outcome: "reconcile" });
  expect(await blocked).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
  expect(reads).toBe(2);
});

test("a committed stop wake interrupts a never-settling authoritative read", async () => {
  const request = (await requestFixture(token)).request;
  let reads = 0;
  const terminal = {
    outcome: "metadata",
    view: "source_unsuccessful_terminal",
    metadata: {
      ...metadata(request),
      resolutionState: "target_stopped",
      resolvedAtMs: request.createdAtMs + 1,
      updatedAtMs: request.createdAtMs + 1,
    },
    terminalized: [],
  };
  const harness = setup(request, async () => {
    reads += 1;
    return reads === 1 ? new Promise(() => undefined) : terminal;
  });
  const blocked = blockUntilRequestTerminal(
    harness.ports,
    harness.context,
    request,
    harness.registration,
    payload,
    new AbortController(),
  );
  while (reads === 0) await Promise.resolve();
  harness.runtime.notifyTerminal({
    requestId: request.id,
    kind: request.kind,
    resolutionState: "target_stopped",
    resolvedAtMs: request.createdAtMs + 1,
  });
  expect(await blocked).toMatchObject({
    ok: false,
    error: { code: "target_stopped" },
  });
  expect(reads).toBe(2);
});

test("an abort reports ownership loss when cancellation and reconciliation cannot settle", async () => {
  const request = (await requestFixture(token)).request;
  const abort = new AbortController();
  let timersArmed = 0;
  abort.abort("caller");
  const harness = setup(request, async () => new Promise(() => undefined), {
    requests: {
      cancelPending: async () => {
        throw new OwnershipLostFault("lost");
      },
      getParticipantRequest: async () => new Promise(() => undefined),
    },
    deadlineTimer: {
      arm: (_delay: number, wake: () => void) => {
        timersArmed += 1;
        if (timersArmed === 3) queueMicrotask(wake);
        return { cancel: () => undefined };
      },
    },
  } as never);
  const blocked = blockUntilRequestTerminal(
    harness.ports,
    { ...harness.context, abort: abort.signal },
    request,
    harness.registration,
    payload,
    new AbortController(),
  );
  expect(await blocked).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
});

test("authoritative reads emit only correlated committed terminal notifications", async () => {
  const request = (await requestFixture(token)).request;
  const { payloadSha256: _payloadSha256, ...terminalBase } = request;
  const terminalized = {
    ...terminalBase,
    resolutionState: "deadline_expired" as const,
    resolvedAtMs: request.deadlineAtMs,
    updatedAtMs: request.deadlineAtMs,
  };
  const events: unknown[] = [];
  const harness = setup(
    request,
    async () => ({ ...pendingProjection(request), terminalized: [terminalized] }),
    { notifications: { notifyTerminal: (event: unknown) => void events.push(event) } } as never,
  );
  harness.runtime.stop("ownership_lost");
  expect(
    await blockUntilRequestTerminal(
      harness.ports,
      harness.context,
      request,
      harness.registration,
      payload,
      new AbortController(),
    ),
  ).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  expect(events).toHaveLength(1);
});

test("invocation-first deadline starts bounded cancellation and wakes local reconciliation", async () => {
  const request = (await requestFixture(token)).request;
  let fire = (): void => undefined;
  let reads = 0;
  const harness = setup(
    request,
    async () => {
      reads += 1;
      if (reads === 1) return pendingProjection(request);
      return {
        outcome: "metadata",
        view: "source_unsuccessful_terminal",
        metadata: {
          ...metadata(request),
          resolutionState: "cancelled",
          resolvedAtMs: request.createdAtMs + 1,
          updatedAtMs: request.createdAtMs + 1,
        },
        terminalized: [],
      };
    },
    {
      requests: {
        getParticipantRequest: async () => {
          reads += 1;
          return reads === 1
            ? pendingProjection(request)
            : {
                outcome: "metadata",
                view: "source_unsuccessful_terminal",
                metadata: {
                  ...metadata(request),
                  resolutionState: "cancelled",
                  resolvedAtMs: request.createdAtMs + 1,
                  updatedAtMs: request.createdAtMs + 1,
                },
                terminalized: [],
              };
        },
        cancelPending: async () => ({ ok: true, request: request }),
      },
      deadlineTimer: {
        arm: (delay: number, wake: () => void) => {
          if (delay !== 1_000) fire = wake;
          return { cancel: () => undefined };
        },
      },
    } as never,
  );
  const blocked = blockUntilRequestTerminal(
    harness.ports,
    { ...harness.context, deadlineMs: request.createdAtMs + 1 },
    request,
    harness.registration,
    payload,
    new AbortController(),
  );
  while (reads < 1) await Promise.resolve();
  fire();
  expect(await blocked).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
});

test("cleanup timer setup failures are contained and still release runtime capacity", async () => {
  const request = (await requestFixture(token)).request;
  const abort = new AbortController();
  abort.abort("caller");
  const harness = setup(request, async () => pendingProjection(request), {
    deadlineTimer: {
      arm: () => {
        throw new Error("cleanup timer");
      },
    },
  } as never);
  expect(
    await blockUntilRequestTerminal(
      harness.ports,
      { ...harness.context, abort: abort.signal },
      request,
      harness.registration,
      payload,
      new AbortController(),
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});

test("available wait results preserve omitted evidence and acknowledged expiry is terminal", async () => {
  const request = (await requestFixture(token)).request;
  const resolvedAtMs = request.createdAtMs + 3;
  const availableMetadata = {
    ...metadata(request),
    resolutionState: "reached",
    deliveryState: "admitted",
    resultState: "available",
    submittedAtMs: request.createdAtMs + 1,
    admittedAtMs: request.createdAtMs + 2,
    resolvedAtMs,
    updatedAtMs: resolvedAtMs,
    resultAvailableAtMs: resolvedAtMs,
    resultExpiresAtMs: resolvedAtMs + 10,
  };
  expect(
    await runProjection(request, {
      outcome: "available_result",
      metadata: availableMetadata,
      result: { kind: "wait" },
      terminalized: [],
    }),
  ).toEqual({ ok: true, value: { request_id: request.id, state: "reached" } });
  expect(
    await runProjection(request, {
      outcome: "result_expired",
      metadata: {
        ...availableMetadata,
        resultState: "acknowledged",
        acknowledgedAtMs: resolvedAtMs + 11,
      },
      terminalized: [],
    }),
  ).toMatchObject({ ok: false, error: { code: "result_expired" } });
});

test("reattachment capacity reports unavailable when the final projection remains pending", async () => {
  const request = (await requestFixture(token)).request;
  let resolveWake!: (value: { outcome: "reconcile" }) => void;
  const registration: RequestRuntimeRegistration = {
    expectedKind: request.kind,
    outcome: new Promise((resolve) => (resolveWake = resolve)),
    detach: () => undefined,
  };
  let reads = 0;
  const ports = {
    runtime: {
      effectSignal: new AbortController().signal,
      attach: () => {
        throw new Error("capacity");
      },
      wakeRequest: () => undefined,
    },
    notifications: { notifyTerminal: () => undefined },
    requests: {
      getParticipantRequest: async () => {
        reads += 1;
        return pendingProjection(request);
      },
    },
    clock: { nowMs: () => request.createdAtMs },
    scheduler: { wake: () => undefined },
    deadlineTimer: { arm: () => ({ cancel: () => undefined }) },
  } as unknown as SessionBlockingRequestPorts;
  const blocked = blockUntilRequestTerminal(
    ports,
    {
      workspaceKey: request.workspaceKey,
      sourceSessionId: request.sourceSessionId,
      fencingToken: token,
      abort: new AbortController().signal,
      deadlineMs: request.deadlineAtMs,
    },
    request,
    registration,
    payload,
    new AbortController(),
  );
  while (reads < 1) await Promise.resolve();
  resolveWake({ outcome: "reconcile" });
  expect(await blocked).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  expect(reads).toBe(2);
});

test("source-pending view rejects otherwise valid terminal metadata", async () => {
  const request = (await requestFixture(token)).request;
  expect(
    await runProjection(request, {
      outcome: "metadata",
      view: "source_pending",
      metadata: {
        ...metadata(request),
        resolutionState: "cancelled",
        resolvedAtMs: request.createdAtMs + 1,
        updatedAtMs: request.createdAtMs + 1,
      },
      terminalized: [],
    }),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});

test("cancellation ownership result remains authoritative when the projection is unavailable", async () => {
  const request = (await requestFixture(token)).request;
  const abort = new AbortController();
  abort.abort("caller");
  for (const [cancelPending, code] of [
    [async () => ({ ok: false, code: "ownership_lost" }), "ownership_lost"],
    [
      async () => {
        throw new Error("cancel store");
      },
      "storage_unavailable",
    ],
  ] as const) {
    const harness = setup(request, async () => null, {
      requests: { getParticipantRequest: async () => null, cancelPending },
    } as never);
    const result = await blockUntilRequestTerminal(
      harness.ports,
      { ...harness.context, abort: abort.signal },
      request,
      harness.registration,
      payload,
      new AbortController(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code },
    });
  }
});
