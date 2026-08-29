import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runCommunicatorStartupPhases } from "../../../../src/application/communicator-startup-phases";
import { RequestRuntime } from "../../../../src/application/request-runtime";
import { validateRequestId } from "../../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../../src/domain/message-payload";
import {
  canonicalizeSerializeAndDigestPendingRequestPayload,
  serializeVerifiedRequestEnvelope,
} from "../../../../src/domain/request-serialization";
import { digestStartArguments } from "../../../../src/domain/session-start";
import { requestDigestPort } from "../../../support/request-store";
import { ids, limits, openStore, source, workspace } from "./sqlite-session-start-support";

async function prepareClaimedComposite(
  store: ReturnType<typeof openStore>,
  fencingToken: Awaited<ReturnType<ReturnType<typeof openStore>["acquire"]>>,
  index: number,
) {
  const generated = ids(index);
  const requestId = validateRequestId(`req_${generated.operationId.slice(3)}`);
  if (!requestId.ok) throw new Error("invalid fixture request id");
  const payload = await canonicalizeSerializeAndDigestPendingRequestPayload(requestDigestPort, {
    kind: "wait",
    milestone: "terminal startup",
    timeoutSeconds: 1,
  });
  if (!payload.ok) throw new Error(payload.message);
  const request = {
    id: requestId.value,
    workspaceKey: workspace,
    sourceSessionId: source,
    targetSessionId: generated.sessionId,
    nativeMessageId: generated.nativeMessageId,
    deliveryMode: "initial" as const,
    linkedStartOperationId: generated.operationId,
    kind: "wait" as const,
    resolutionState: "pending" as const,
    deliveryState: "prepared" as const,
    resultState: "none" as const,
    payloadByteLength: payload.byteLength,
    payloadSha256: payload.sha256,
    createdAtMs: 10_000,
    updatedAtMs: 10_000,
    deadlineAtMs: 11_000,
  };
  const envelope = await serializeVerifiedRequestEnvelope(
    { ...request, requestId: request.id, payload: payload.value },
    requestDigestPort,
  );
  const startArguments = {
    idempotencyKey: `recovery:terminal-startup:${index}`,
    initialMessage: envelope,
  };
  const argumentsSha256 = await digestStartArguments(requestDigestPort, startArguments);
  const prepared = await store.createOrResumeSessionRequestStart({
    start: {
      fencingToken,
      workspaceKey: workspace,
      sourceSessionId: source,
      ...generated,
      argumentsSha256,
      idempotencyArgumentsSha256: index.toString(16).padStart(64, "0") as Sha256Digest,
      arguments: startArguments,
      limits,
      nowMs: 10_000,
    },
    request: {
      fencingToken,
      creationOperationId: generated.operationId,
      deliveryMode: "initial",
      linkedStartOperationId: generated.operationId,
      request,
      payloadJson: payload.serialized,
      envelopeJson: envelope,
    },
  });
  if (!prepared.ok) throw new Error(`fixture preparation failed: ${prepared.code}`);
  return { generated, request };
}

async function runTerminalStartupTwice(
  store: ReturnType<typeof openStore>,
  fencingToken: Awaited<ReturnType<ReturnType<typeof openStore>["acquire"]>>,
): Promise<{ readonly nativeEffects: number }> {
  let nativeEffects = 0;
  const signal = new AbortController().signal;
  const countEffect = () => {
    nativeEffects += 1;
  };
  const ports = {
    membership: {
      async readCurrentRoots() {
        return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
      },
    },
    deliveries: store,
    nativeQueue: {
      async queueMessage() {
        countEffect();
        return { kind: "unknown" as const };
      },
    },
    requests: store,
    participantPresence: {
      async readParticipantPresence() {
        return "present" as const;
      },
    },
    activity: {
      async observeRequestParticipants() {
        return { sourceVisible: true, targetVisible: true, targetStatus: "idle" as const };
      },
    },
    nativeSteer: {
      async steerRequest() {
        countEffect();
        return { kind: "unknown" as const };
      },
    },
    ownership: store,
    startupBarrier: store,
    clock: { nowMs: () => 11_000 },
    runtime: new RequestRuntime(),
    resultRetention: store,
    requestRetention: store,
    starts: store.starts,
    requestStarts: store,
    nativeStart: {
      async createRootSession() {
        countEffect();
        return "created" as const;
      },
      async reconcileRootSession() {
        countEffect();
        return "matching" as const;
      },
      async updateSessionTitle() {
        countEffect();
        return "updated" as const;
      },
      async admitInitialMessage() {
        countEffect();
        return "admitted" as const;
      },
    },
    digest: requestDigestPort,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const startupBarrier = await store.establish(fencingToken, {
      abort: signal,
      deadlineMs: 20_000,
    });
    const result = await runCommunicatorStartupPhases(
      ports,
      { workspaceKey: workspace, abort: signal, deadlineMs: 20_000, limit: 10 },
      fencingToken,
      startupBarrier,
      signal,
      async () => ({ ok: true as const, value: undefined }),
    );
    expect(result).toMatchObject({ ok: true });
  }
  return { nativeEffects };
}

test("full startup creates and admits a prepared composite once while its target is initially absent", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const generated = ids(951);
    const requestId = validateRequestId(`req_${generated.operationId.slice(3)}`);
    if (!requestId.ok) throw new Error("invalid fixture request id");
    const payload = await canonicalizeSerializeAndDigestPendingRequestPayload(requestDigestPort, {
      kind: "wait",
      milestone: "startup",
      timeoutSeconds: 30,
    });
    if (!payload.ok) throw new Error(payload.message);
    const request = {
      id: requestId.value,
      workspaceKey: workspace,
      sourceSessionId: source,
      targetSessionId: generated.sessionId,
      nativeMessageId: generated.nativeMessageId,
      deliveryMode: "initial" as const,
      linkedStartOperationId: generated.operationId,
      kind: "wait" as const,
      resolutionState: "pending" as const,
      deliveryState: "prepared" as const,
      resultState: "none" as const,
      payloadByteLength: payload.byteLength,
      payloadSha256: payload.sha256,
      createdAtMs: 10_000,
      updatedAtMs: 10_000,
      deadlineAtMs: 40_000,
    };
    const envelope = await serializeVerifiedRequestEnvelope(
      { ...request, requestId: request.id, payload: payload.value },
      requestDigestPort,
    );
    const startArguments = {
      idempotencyKey: "recovery:full-startup",
      initialMessage: envelope,
    };
    const argumentsSha256 = await digestStartArguments(requestDigestPort, startArguments);
    expect(
      await store.createOrResumeSessionRequestStart({
        start: {
          fencingToken,
          workspaceKey: workspace,
          sourceSessionId: source,
          ...generated,
          argumentsSha256,
          idempotencyArgumentsSha256: "b".repeat(64) as Sha256Digest,
          arguments: startArguments,
          limits,
          nowMs: 10_000,
        },
        request: {
          fencingToken,
          creationOperationId: generated.operationId,
          deliveryMode: "initial",
          linkedStartOperationId: generated.operationId,
          request,
          payloadJson: payload.serialized,
          envelopeJson: envelope,
        },
      }),
    ).toMatchObject({ ok: true });

    let creates = 0;
    let admissions = 0;
    let targetCreated = false;
    const presenceChecks: string[] = [];
    const signal = new AbortController().signal;
    const clock = { nowMs: () => 10_000 };
    const nativeStart = {
      async createRootSession() {
        expect(targetCreated).toBe(false);
        expect(presenceChecks).toEqual([source]);
        creates += 1;
        targetCreated = true;
        return "created" as const;
      },
      async reconcileRootSession() {
        return "matching" as const;
      },
      async updateSessionTitle() {
        return "updated" as const;
      },
      async admitInitialMessage() {
        admissions += 1;
        return "admitted" as const;
      },
    };
    const ports = {
      membership: {
        async readCurrentRoots() {
          return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
        },
      },
      deliveries: store,
      nativeQueue: {
        async queueMessage() {
          return { kind: "unknown" as const };
        },
      },
      requests: store,
      participantPresence: {
        async readParticipantPresence(sessionId: string) {
          presenceChecks.push(sessionId);
          return sessionId === generated.sessionId && !targetCreated
            ? ("absent" as const)
            : ("present" as const);
        },
      },
      activity: {
        async observeRequestParticipants() {
          return { sourceVisible: true, targetVisible: true, targetStatus: "idle" as const };
        },
      },
      nativeSteer: {
        async steerRequest() {
          return { kind: "unknown" as const };
        },
      },
      ownership: store,
      startupBarrier: store,
      clock,
      runtime: new RequestRuntime(),
      resultRetention: store,
      requestRetention: store,
      starts: store.starts,
      requestStarts: store,
      nativeStart,
      digest: requestDigestPort,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const startupBarrier = await store.establish(fencingToken, {
        abort: signal,
        deadlineMs: 40_000,
      });
      const result = await runCommunicatorStartupPhases(
        ports,
        { workspaceKey: workspace, abort: signal, deadlineMs: 40_000, limit: 10 },
        fencingToken,
        startupBarrier,
        signal,
        async () =>
          (await store.isCurrent(fencingToken))
            ? { ok: true as const, value: undefined }
            : { ok: false as const, error: { code: "ownership_lost" as const } as never },
      );
      expect(result.ok).toBe(true);
    }

    expect(presenceChecks[0]).toBe(source);
    expect(creates).toBe(1);
    expect(admissions).toBe(1);
    expect(
      await store.getRequestMetadata({
        fencingToken,
        workspaceKey: workspace,
        requestId: request.id,
      }),
    ).toMatchObject({ resolutionState: "pending", deliveryState: "admitted" });
  } finally {
    store.close();
  }
});

for (const [terminalKind, creationCompleted, index] of [
  ["cancelled", false, 961],
  ["deadline_expired", false, 962],
  ["cancelled", true, 963],
  ["deadline_expired", true, 964],
] as const) {
  test(`full startup classifies stale ${terminalKind} initial delivery after ${
    creationCompleted ? "created" : "prepared"
  } correlation without retry`, async () => {
    let nowMs = 10_000;
    const store = openStore(() => nowMs);
    try {
      const fencingToken = await store.acquire();
      const fixture = await prepareClaimedComposite(store, fencingToken, index);
      if (creationCompleted) {
        expect(
          await store.starts.claimStep({
            fencingToken,
            workspaceKey: workspace,
            operationId: fixture.generated.operationId,
            step: "creation",
            nowMs,
          }),
        ).toMatchObject({ ok: true });
        expect(
          await store.starts.completeCreation({
            fencingToken,
            workspaceKey: workspace,
            operationId: fixture.generated.operationId,
            state: "created",
            nowMs,
          }),
        ).toMatchObject({ ok: true });
      }
      expect(
        await store.claimPrepared({
          fencingToken,
          workspaceKey: workspace,
          requestId: fixture.request.id,
        }),
      ).toMatchObject({ ok: true, request: { deliveryState: "submitting" } });
      if (terminalKind === "cancelled") {
        expect(
          await store.cancelPending({
            fencingToken,
            workspaceKey: workspace,
            requestId: fixture.request.id,
            callerSessionId: source,
          }),
        ).toMatchObject({ ok: true, request: { resolutionState: "cancelled" } });
      } else {
        nowMs = 11_000;
        expect(
          await store.expireDueRequests({ fencingToken, workspaceKey: workspace, limit: 10 }),
        ).toMatchObject({
          ok: true,
          requests: [{ id: fixture.request.id, resolutionState: "deadline_expired" }],
        });
      }
      const database = new Database(store.databasePath, { strict: true });
      database.run("UPDATE requests SET claimed_fencing_token = ? WHERE id = ?", [
        Number(fencingToken) + 1,
        fixture.request.id,
      ]);
      database.close(true);

      const startup = await runTerminalStartupTwice(store, fencingToken);
      expect(startup.nativeEffects).toBe(0);
      expect(
        await store.getRequestMetadata({
          fencingToken,
          workspaceKey: workspace,
          requestId: fixture.request.id,
        }),
      ).toMatchObject({
        resolutionState: terminalKind,
        deliveryState: "delivery_failed",
      });
      const linked = await store.readSessionRequestStartByOperation({
        fencingToken,
        workspaceKey: workspace,
        operationId: fixture.generated.operationId,
      });
      expect(linked?.operation).toMatchObject(
        creationCompleted
          ? { creationState: "created", admissionState: "payload_unavailable" }
          : { creationState: "request_terminal", admissionState: "payload_unavailable" },
      );
    } finally {
      store.close();
    }
  });
}
