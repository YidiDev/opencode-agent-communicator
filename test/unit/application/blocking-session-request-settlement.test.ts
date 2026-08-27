import { expect, test } from "bun:test";

import { claimAndAdmitBlockingRequest } from "../../../src/application/blocking-session-request-admission";
import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "../../../src/application/blocking-session-request-boundaries";
import { persistPreparedBlockingRequest } from "../../../src/application/blocking-session-request-creation-settlement";
import { RequestRuntime } from "../../../src/application/request-runtime";
import type { FencingToken } from "../../../src/domain/ownership";
import { OwnershipLostFault } from "../../../src/domain/ownership";
import type { PendingRequestMetadata } from "../../../src/domain/request-types";
import { requestFixture } from "../../support/request-store";

const token = 1 as FencingToken;

async function setup() {
  const prepared = await requestFixture(token, 10);
  const context: SessionBlockingRequestContext = {
    workspaceKey: prepared.request.workspaceKey,
    sourceSessionId: prepared.request.sourceSessionId,
    fencingToken: token,
    abort: new AbortController().signal,
    deadlineMs: 100,
  };
  return { prepared, context };
}

function basePorts(overrides: Record<string, unknown>): SessionBlockingRequestPorts {
  const runtime = new RequestRuntime();
  return {
    requests: {},
    ownership: { isCurrent: async () => true },
    nativeSteer: { steerRequest: async () => ({ kind: "unknown" }) },
    notifications: runtime,
    runtime,
    clock: { nowMs: () => 10 },
    deadlineTimer: { arm: () => ({ cancel: () => undefined }) },
    scheduler: { wake: () => undefined },
    workflowFault: { fault: () => undefined },
    ...overrides,
  } as unknown as SessionBlockingRequestPorts;
}

test("prepared creation maps every settled store rejection without reconciliation", async () => {
  const { prepared, context } = await setup();
  for (const [code, expected] of [
    ["ownership_lost", "ownership_lost"],
    ["quota_exceeded", "quota_exceeded"],
    ["rate_limited", "rate_limited"],
    ["deadlock_detected", "deadlock_detected"],
    ["state_conflict", "storage_unavailable"],
  ] as const) {
    const result = await persistPreparedBlockingRequest(
      basePorts({ requests: { createPrepared: async () => ({ ok: false, code }) } }),
      context,
      {
        fencingToken: token,
        creationOperationId: prepared.creationOperationId,
        request: prepared.request,
        payloadJson: prepared.payloadJson,
        envelopeJson: prepared.envelopeJson,
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: expected } });
  }
});

test("ambiguous prepared creation reconciles matching, absent retry, and conflict outcomes", async () => {
  const { prepared, context } = await setup();
  const input = {
    fencingToken: token,
    creationOperationId: prepared.creationOperationId,
    request: prepared.request,
    payloadJson: prepared.payloadJson,
    envelopeJson: prepared.envelopeJson,
  };
  for (const reconciliation of [
    { outcome: "matching", request: prepared.request },
    { outcome: "conflict" },
    { outcome: "matching", request: { ...prepared.request, targetSessionId: "ses_other" } },
  ]) {
    const result = await persistPreparedBlockingRequest(
      basePorts({
        requests: {
          createPrepared: async () => ({ ok: true }),
          reconcilePreparedCreation: async () => reconciliation,
        },
      }),
      context,
      input,
    );
    expect(result.ok).toBe(
      reconciliation.outcome === "matching" && reconciliation.request === prepared.request,
    );
  }
  let creates = 0;
  const retried = await persistPreparedBlockingRequest(
    basePorts({
      requests: {
        createPrepared: async () => {
          creates += 1;
          return creates === 1 ? ({ bad: true } as never) : { ok: true, request: prepared.request };
        },
        reconcilePreparedCreation: async () => ({ outcome: "absent" }),
      },
    }),
    context,
    input,
  );
  expect(retried).toMatchObject({ ok: true });
  expect(creates).toBe(2);
});

test("creation reconciliation is bounded against malformed clocks and rejected ports", async () => {
  const { prepared, context } = await setup();
  const input = {
    fencingToken: token,
    creationOperationId: prepared.creationOperationId,
    request: prepared.request,
    payloadJson: prepared.payloadJson,
    envelopeJson: prepared.envelopeJson,
  };
  for (const ports of [
    basePorts({ clock: { nowMs: () => -1 }, requests: { createPrepared: async () => ({}) } }),
    basePorts({
      deadlineTimer: {
        arm: () => {
          throw new Error("timer");
        },
      },
      requests: { createPrepared: async () => ({}), reconcilePreparedCreation: async () => ({}) },
    }),
    basePorts({
      requests: {
        createPrepared: async () => {
          throw new OwnershipLostFault("stale");
        },
        reconcilePreparedCreation: async () => {
          throw new Error("store");
        },
      },
    }),
  ]) {
    expect(await persistPreparedBlockingRequest(ports, context, input)).toMatchObject({
      ok: false,
    });
  }
});

test("claim admission rejects malformed failures, claims, and non-submitting shapes", async () => {
  const { prepared, context } = await setup();
  const { payloadSha256: _payloadSha256, ...terminalBase } = prepared.request;
  const terminal = {
    ...terminalBase,
    resolutionState: "cancelled",
    resolvedAtMs: 11,
    updatedAtMs: 11,
  };
  const cases: Array<{ raw: unknown; code?: string; ok?: boolean }> = [
    { raw: { ok: false, code: "ownership_lost" }, code: "ownership_lost" },
    { raw: { ok: false, code: "quota_exceeded" }, code: "quota_exceeded" },
    { raw: { ok: false, code: "future" }, code: "storage_unavailable" },
    { raw: { ok: false, code: "quota_exceeded", extra: true }, code: "storage_unavailable" },
    { raw: { ok: true }, code: "storage_unavailable" },
    {
      raw: { ok: true, request: { ...prepared.request, id: "req_bad" } },
      code: "storage_unavailable",
    },
    { raw: { ok: true, request: prepared.request }, ok: true },
    {
      raw: { ok: true, request: prepared.request, envelopeJson: "unexpected" },
      code: "storage_unavailable",
    },
    { raw: { ok: true, request: terminal }, ok: true },
  ];
  for (const item of cases) {
    const result = await claimAndAdmitBlockingRequest(
      basePorts({ requests: { claimPrepared: async () => item.raw } }),
      context,
      prepared.request as PendingRequestMetadata,
      new AbortController(),
    );
    expect(result).toMatchObject(
      item.ok ? { ok: true } : { ok: false, error: { code: item.code } },
    );
  }
});
