import { expect, test } from "bun:test";

import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "../../../src/application/blocking-session-request-boundaries";
import {
  blockUntilRequestTerminal,
  RequestRuntimeShutdownFault,
} from "../../../src/application/blocking-session-request-wait";
import { RequestRuntime } from "../../../src/application/request-runtime";
import type { FencingToken } from "../../../src/domain/ownership";
import type { PendingRequestMetadata } from "../../../src/domain/request-types";
import { requestFixture, requestFixtureForPayload } from "../../support/request-store";

const token = 1 as FencingToken;

function pendingProjection(request: PendingRequestMetadata) {
  return {
    outcome: "metadata" as const,
    view: "source_pending" as const,
    metadata: {
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
    },
    terminalized: [],
  };
}

const approvedPayload = { kind: "wait", milestone: "compiled ✓", timeoutSeconds: 30 } as const;

function harness(
  request: PendingRequestMetadata,
  runtime: RequestRuntime,
  get: () => Promise<unknown>,
  cancel: () => Promise<unknown> = async () => ({ ok: false, code: "storage_unavailable" }),
) {
  const context: SessionBlockingRequestContext = {
    workspaceKey: request.workspaceKey,
    sourceSessionId: request.sourceSessionId,
    fencingToken: token,
    abort: new AbortController().signal,
    deadlineMs: request.deadlineAtMs,
  };
  const ports: SessionBlockingRequestPorts = {
    runtime,
    notifications: runtime,
    requests: { getParticipantRequest: get, cancelPending: cancel },
    clock: { nowMs: () => request.createdAtMs },
    scheduler: { wake: () => undefined },
    deadlineTimer: { arm: () => ({ cancel: () => undefined }) },
    workflowFault: { fault: () => undefined },
  } as unknown as SessionBlockingRequestPorts;
  return { context, ports };
}

test.each(["shutdown", "ownership_lost"] as const)(
  "distinguishes runtime stop outcome %s",
  async (reason) => {
    const request = (await requestFixture(token)).request;
    const runtime = new RequestRuntime();
    const registration = runtime.attachProvisional({
      requestId: request.id,
      expectedKind: request.kind,
      sourceSessionId: request.sourceSessionId,
      workspaceKey: request.workspaceKey,
    });
    runtime.stop(reason);
    const setup = harness(request, runtime, async () => pendingProjection(request));
    const result = blockUntilRequestTerminal(
      setup.ports,
      setup.context,
      request,
      registration,
      approvedPayload,
      new AbortController(),
    );
    if (reason === "shutdown") {
      await expect(result).rejects.toBeInstanceOf(RequestRuntimeShutdownFault);
    } else {
      expect(await result).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
    }
  },
);

test("an aborted waiter fails closed when cancellation output is malformed", async () => {
  const request = (await requestFixture(token)).request;
  const runtime = new RequestRuntime();
  const registration = runtime.attachProvisional({
    requestId: request.id,
    expectedKind: request.kind,
    sourceSessionId: request.sourceSessionId,
    workspaceKey: request.workspaceKey,
  });
  const setup = harness(
    request,
    runtime,
    async () => pendingProjection(request),
    async () => ({ nope: true }),
  );
  const abort = new AbortController();
  abort.abort();
  const result = await blockUntilRequestTerminal(
    setup.ports,
    { ...setup.context, abort: abort.signal },
    request,
    registration,
    approvedPayload,
    new AbortController(),
  );
  expect(result).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});

test("malformed and hidden authoritative projections fail closed", async () => {
  for (const projection of [undefined, { outcome: "available_result", metadata: {}, result: {} }]) {
    const request = (await requestFixture(token)).request;
    const runtime = new RequestRuntime();
    const registration = runtime.attachProvisional({
      requestId: request.id,
      expectedKind: request.kind,
      sourceSessionId: request.sourceSessionId,
      workspaceKey: request.workspaceKey,
    });
    const setup = harness(request, runtime, async () => projection);
    expect(
      await blockUntilRequestTerminal(
        setup.ports,
        setup.context,
        request,
        registration,
        approvedPayload,
        new AbortController(),
      ),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  }
});

test("an authoritative terminal remains the winner after cancellation settlement times out", async () => {
  const request = (await requestFixture(token)).request;
  const runtime = new RequestRuntime();
  const registration = runtime.attachProvisional({
    requestId: request.id,
    expectedKind: request.kind,
    sourceSessionId: request.sourceSessionId,
    workspaceKey: request.workspaceKey,
  });
  let terminal = false;
  let cleanupDeadline = (): void => undefined;
  let terminalNotified!: () => void;
  const notificationCompleted = new Promise<void>((resolve) => {
    terminalNotified = resolve;
  });
  const setup = harness(
    request,
    runtime,
    async () => {
      if (!terminal) return pendingProjection(request);
      return {
        outcome: "metadata",
        view: "source_unsuccessful_terminal",
        metadata: {
          ...pendingProjection(request).metadata,
          resolutionState: "cancelled",
          resolvedAtMs: request.createdAtMs + 1,
        },
        terminalized: [],
      };
    },
    () => {
      queueMicrotask(() => {
        terminal = true;
        runtime.notifyTerminal({
          requestId: request.id,
          kind: request.kind,
          resolutionState: "cancelled",
          resolvedAtMs: request.createdAtMs + 1,
        });
        terminalNotified();
      });
      return new Promise(() => undefined);
    },
  );
  const abort = new AbortController();
  abort.abort();
  const blocked = blockUntilRequestTerminal(
    {
      ...setup.ports,
      deadlineTimer: {
        arm: (delayMs, wake) => {
          if (delayMs === 1_000) cleanupDeadline = wake;
          return { cancel: () => undefined };
        },
      },
    },
    { ...setup.context, abort: abort.signal },
    request,
    registration,
    approvedPayload,
    new AbortController(),
  );
  await notificationCompleted;
  cleanupDeadline();
  expect(await blocked).toMatchObject({ ok: false, error: { code: "request_cancelled" } });
});

test("one local deadline timer reconciles terminalization when notification is omitted", async () => {
  const request = (await requestFixture(token)).request;
  const runtime = new RequestRuntime();
  const registration = runtime.attachProvisional({
    requestId: request.id,
    expectedKind: request.kind,
    sourceSessionId: request.sourceSessionId,
    workspaceKey: request.workspaceKey,
  });
  let reads = 0;
  let fire = (): void => undefined;
  let timerArmed!: () => void;
  const armed = new Promise<void>((resolve) => {
    timerArmed = resolve;
  });
  const setup = harness(request, runtime, async () => {
    reads += 1;
    if (reads === 1) return pendingProjection(request);
    return {
      outcome: "metadata",
      view: "source_unsuccessful_terminal",
      metadata: {
        ...pendingProjection(request).metadata,
        resolutionState: "deadline_expired",
        resolvedAtMs: request.deadlineAtMs,
        updatedAtMs: request.deadlineAtMs,
      },
      terminalized: [],
    };
  });
  const ports: SessionBlockingRequestPorts = {
    ...setup.ports,
    deadlineTimer: {
      arm: (_delay: number, wake: () => void) => {
        fire = wake;
        timerArmed();
        return { cancel: () => undefined };
      },
    },
    workflowFault: { fault: () => undefined },
  };
  const blocked = blockUntilRequestTerminal(
    ports,
    setup.context,
    request,
    registration,
    approvedPayload,
    new AbortController(),
  );
  await armed;
  fire();
  expect(await blocked).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
  expect(reads).toBe(2);
});

test("maps an authoritative result-expired projection after a suspended invocation", async () => {
  const request = (await requestFixture(token)).request;
  const runtime = new RequestRuntime();
  const registration = runtime.attachProvisional({
    requestId: request.id,
    expectedKind: request.kind,
    sourceSessionId: request.sourceSessionId,
    workspaceKey: request.workspaceKey,
  });
  const setup = harness(request, runtime, async () => ({
    outcome: "result_expired",
    metadata: {
      ...pendingProjection(request).metadata,
      resolutionState: "reached",
      deliveryState: "admitted",
      submittedAtMs: request.createdAtMs + 1,
      admittedAtMs: request.createdAtMs + 2,
      resultState: "expired",
      resolvedAtMs: request.createdAtMs + 3,
      updatedAtMs: request.createdAtMs + 4,
      resultAvailableAtMs: request.createdAtMs + 3,
      resultExpiresAtMs: request.createdAtMs + 86_400_003,
      resultExpiredAtMs: request.createdAtMs + 86_400_003,
    },
    terminalized: [],
  }));
  expect(
    await blockUntilRequestTerminal(
      setup.ports,
      setup.context,
      request,
      registration,
      approvedPayload,
      new AbortController(),
    ),
  ).toMatchObject({ ok: false, error: { code: "result_expired" } });
});

test.each([
  ["cancelled", "request_cancelled"],
  ["deadline_expired", "deadline_expired"],
  ["delivery_failed", "delivery_failed"],
  ["target_stopped", "target_stopped"],
  ["source_stopped", "source_stopped"],
  ["target_deleted", "target_deleted"],
  ["source_deleted", "source_deleted"],
] as const)("an abort reconciles the committed %s winner", async (state, code) => {
  const request = (await requestFixture(token)).request;
  const runtime = new RequestRuntime();
  const registration = runtime.attachProvisional({
    requestId: request.id,
    expectedKind: request.kind,
    sourceSessionId: request.sourceSessionId,
    workspaceKey: request.workspaceKey,
  });
  let projection: unknown;
  let started = (): void => undefined;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const setup = harness(
    request,
    runtime,
    async () => {
      if (projection !== undefined) return projection;
      started();
      return new Promise(() => undefined);
    },
    async () => {
      projection = {
        outcome: "metadata",
        view: "source_unsuccessful_terminal",
        metadata: {
          ...pendingProjection(request).metadata,
          resolutionState: state,
          resolvedAtMs: request.createdAtMs + 1,
          updatedAtMs: request.createdAtMs + 1,
        },
        terminalized: [],
      };
      return { ok: false, code: "storage_unavailable" };
    },
  );
  const abort = new AbortController();
  const blocked = blockUntilRequestTerminal(
    setup.ports,
    { ...setup.context, abort: abort.signal },
    request,
    registration,
    approvedPayload,
    new AbortController(),
  );
  await firstStarted;
  abort.abort("controlled_race");
  expect(await blocked).toMatchObject({ ok: false, error: { code } });
});

test("a cleanup deadline bounds a post-abort authoritative reread that never settles", async () => {
  const request = (await requestFixture(token)).request;
  const runtime = new RequestRuntime(1);
  const registration = runtime.attachProvisional({
    requestId: request.id,
    expectedKind: request.kind,
    sourceSessionId: request.sourceSessionId,
    workspaceKey: request.workspaceKey,
  });
  let reads = 0;
  let cleanupDeadline = (): void => undefined;
  let firstReadStarted!: () => void;
  let secondReadStarted!: () => void;
  const firstRead = new Promise<void>((resolve) => {
    firstReadStarted = resolve;
  });
  const secondRead = new Promise<void>((resolve) => {
    secondReadStarted = resolve;
  });
  const setup = harness(
    request,
    runtime,
    async () => {
      reads += 1;
      if (reads === 1) firstReadStarted();
      if (reads === 2) secondReadStarted();
      return new Promise(() => undefined);
    },
    async () => ({ ok: false, code: "storage_unavailable" }),
  );
  const abort = new AbortController();
  const blocked = blockUntilRequestTerminal(
    {
      ...setup.ports,
      deadlineTimer: {
        arm: (delayMs, wake) => {
          if (delayMs === 1_000) cleanupDeadline = wake;
          return { cancel: () => undefined };
        },
      },
    },
    { ...setup.context, abort: abort.signal },
    request,
    registration,
    approvedPayload,
    new AbortController(),
  );
  await firstRead;
  abort.abort("caller_cancelled");
  await secondRead;
  cleanupDeadline();
  expect(await blocked).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable", details: { request_id: request.id } },
  });
  expect(reads).toBe(2);
  expect(() =>
    runtime.attach({
      requestId: request.id,
      expectedKind: request.kind,
      sourceSessionId: request.sourceSessionId,
      workspaceKey: request.workspaceKey,
    }),
  ).not.toThrow();
});

test.each(["wait", "ask"] as const)(
  "an abort returns the committed %s success winner",
  async (kind) => {
    const prepared =
      kind === "wait"
        ? await requestFixture(token)
        : await requestFixtureForPayload(token, {
            kind: "ask",
            questions: [{ prompt: "Ship?", options: ["yes"] }],
            timeoutSeconds: 30,
          });
    const request = prepared.request;
    const runtime = new RequestRuntime();
    const registration = runtime.attachProvisional({
      requestId: request.id,
      expectedKind: request.kind,
      sourceSessionId: request.sourceSessionId,
      workspaceKey: request.workspaceKey,
    });
    let projection: unknown;
    let started = (): void => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const setup = harness(
      request,
      runtime,
      async () => {
        if (projection !== undefined) return projection;
        started();
        return new Promise(() => undefined);
      },
      async () => {
        const resolvedAtMs = request.createdAtMs + 3;
        projection = {
          outcome: "available_result",
          metadata: {
            ...pendingProjection(request).metadata,
            resolutionState: kind === "wait" ? "reached" : "answered",
            deliveryState: "admitted",
            resultState: "available",
            submittedAtMs: request.createdAtMs + 1,
            admittedAtMs: request.createdAtMs + 2,
            resolvedAtMs,
            updatedAtMs: resolvedAtMs,
            resultAvailableAtMs: resolvedAtMs,
            resultExpiresAtMs: resolvedAtMs + 100,
          },
          result:
            kind === "wait"
              ? { kind: "wait", evidence: "signal" }
              : { kind: "ask", answers: [["yes"]] },
          terminalized: [],
        };
        return { ok: false, code: "storage_unavailable" };
      },
    );
    const abort = new AbortController();
    const blocked = blockUntilRequestTerminal(
      setup.ports,
      { ...setup.context, abort: abort.signal },
      request,
      registration,
      kind === "wait"
        ? approvedPayload
        : {
            kind: "ask",
            questions: [{ prompt: "Ship?", options: ["yes"], multiple: false, allowCustom: false }],
            timeoutSeconds: 30,
          },
      new AbortController(),
    );
    await firstStarted;
    abort.abort("controlled_race");
    expect(await blocked).toMatchObject({
      ok: true,
      value: { state: kind === "wait" ? "reached" : "answered" },
    });
  },
);
