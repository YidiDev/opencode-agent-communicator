import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { recoverSessionStarts } from "../../../../src/application/recover-session-starts";
import { validateRequestId } from "../../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../../src/domain/message-payload";
import type { FencingToken } from "../../../../src/domain/ownership";
import {
  canonicalizeSerializeAndDigestPendingRequestPayload,
  serializeVerifiedRequestEnvelope,
} from "../../../../src/domain/request-serialization";
import { digestStartArguments } from "../../../../src/domain/session-start";
import { requestDigestPort } from "../../../support/request-store";
import { ids, limits, openStore, source, workspace } from "./sqlite-session-start-support";

async function prepareLinkedStart(
  store: ReturnType<typeof openStore>,
  fencingToken: Awaited<ReturnType<ReturnType<typeof openStore>["acquire"]>>,
  index: number,
  title?: string,
) {
  const generated = ids(index);
  const requestId = validateRequestId(`req_${generated.operationId.slice(3)}`);
  if (!requestId.ok) throw new Error("invalid fixture request id");
  const payload = await canonicalizeSerializeAndDigestPendingRequestPayload(requestDigestPort, {
    kind: "wait",
    milestone: "recovered",
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
    idempotencyKey: `recovery:terminal:${index}`,
    initialMessage: envelope,
    ...(title === undefined ? {} : { title }),
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

function recoveryPorts(store: ReturnType<typeof openStore>, fencingToken: FencingToken) {
  return {
    fencingToken,
    workspaceKey: workspace,
    requests: store,
    requestStarts: store,
    membership: {
      async readCurrentRoots() {
        return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
      },
    },
    ownership: store,
    digest: requestDigestPort,
    nativeStart: {
      async createRootSession(): Promise<"created"> {
        throw new Error("terminal linked request must not create a session");
      },
      async reconcileRootSession(): Promise<"matching"> {
        throw new Error("terminal linked request must not reconcile a session");
      },
      async updateSessionTitle(): Promise<"updated"> {
        throw new Error("terminal linked request must not update a title");
      },
      async admitInitialMessage(): Promise<"admitted"> {
        throw new Error("terminal linked request must not admit a message");
      },
    },
  } as const;
}

test("real store resumes claim-before-create initial work exactly once", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const generated = ids(950);
    const requestId = validateRequestId(`req_${generated.operationId.slice(3)}`);
    if (!requestId.ok) throw new Error("invalid fixture request id");
    const payload = await canonicalizeSerializeAndDigestPendingRequestPayload(requestDigestPort, {
      kind: "wait",
      milestone: "recovered",
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
      idempotencyKey: "recovery:claim-before-create",
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
          idempotencyArgumentsSha256: "a".repeat(64) as Sha256Digest,
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
    expect(
      await store.claimPrepared({
        fencingToken,
        workspaceKey: workspace,
        requestId: request.id,
      }),
    ).toMatchObject({ ok: true, request: { deliveryState: "submitting" } });

    let creates = 0;
    let admissions = 0;
    await recoverSessionStarts(
      store.starts,
      { nowMs: () => 10_000 },
      {
        fencingToken,
        workspaceKey: workspace,
        requests: store,
        requestStarts: store,
        membership: {
          async readCurrentRoots() {
            return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
          },
        },
        ownership: store,
        digest: requestDigestPort,
        nativeStart: {
          async createRootSession() {
            creates += 1;
            return "created";
          },
          async reconcileRootSession() {
            return "matching";
          },
          async updateSessionTitle() {
            return "updated";
          },
          async admitInitialMessage() {
            admissions += 1;
            return "admitted";
          },
        },
      },
    );
    expect(creates).toBe(1);
    expect(admissions).toBe(1);
    expect(
      await store.getRequestMetadata({
        fencingToken,
        workspaceKey: workspace,
        requestId: request.id,
      }),
    ).toMatchObject({ deliveryState: "admitted" });
  } finally {
    store.close();
  }
});

test("terminal linked request retires an uncreated start without approval semantics", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const fixture = await prepareLinkedStart(store, fencingToken, 951);
    expect(
      await store.cancelPending({
        fencingToken,
        workspaceKey: workspace,
        requestId: fixture.request.id,
        callerSessionId: source,
      }),
    ).toMatchObject({ ok: true, request: { resolutionState: "cancelled" } });

    expect(
      await recoverSessionStarts(
        store.starts,
        { nowMs: () => 10_001 },
        recoveryPorts(store, fencingToken),
      ),
    ).toEqual({
      preparedAwaitingInvocationApproval: 0,
      creationOutcomesUnknown: 0,
      titleOutcomesUnknown: 0,
      admissionsUnknown: 0,
    });
    const linked = await store.readSessionRequestStartByOperation({
      fencingToken,
      workspaceKey: workspace,
      operationId: fixture.generated.operationId,
    });
    expect(linked?.operation).toMatchObject({
      creationState: "request_terminal",
      titleState: "skipped",
      admissionState: "payload_unavailable",
    });
    const database = new Database(store.databasePath, { readonly: true, strict: true });
    expect(
      database
        .query<{ state: string; reason: string }, [string]>(
          `SELECT creation_state AS state, terminal_reason AS reason
           FROM start_operations WHERE id = ?`,
        )
        .get(fixture.generated.operationId),
    ).toEqual({ state: "failed", reason: "request_terminal" });
    expect(
      database
        .query<{ payloads: number; managed: number }, [string]>(
          `SELECT
             (SELECT count(*) FROM start_operation_payloads WHERE operation_id = ?1) AS payloads,
             (SELECT count(*) FROM managed_sessions WHERE operation_id = ?1) AS managed`,
        )
        .get(fixture.generated.operationId),
    ).toEqual({ payloads: 0, managed: 0 });
    database.close(true);
    expect(
      await store.starts.listRecoverable({
        fencingToken,
        workspaceKey: workspace,
        limit: 10,
        excludeClaimedByToken: fencingToken,
      }),
    ).toHaveLength(0);
    expect(
      await store.starts.collectRetention({
        fencingToken,
        workspaceKey: workspace,
        nowMs: 10_000 + limits.terminalRetentionMs + 1,
        terminalRetentionMs: limits.terminalRetentionMs,
        rateRetentionMs: limits.rateWindowMs,
        limit: 10,
      }),
    ).toMatchObject({ ok: true, deletedOperations: 1 });
  } finally {
    store.close();
  }
});

test("terminal linked request erases created continuation work and preserves provenance", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const fixture = await prepareLinkedStart(store, fencingToken, 952, "worker");
    expect(
      await store.starts.claimStep({
        fencingToken,
        workspaceKey: workspace,
        operationId: fixture.generated.operationId,
        step: "creation",
        nowMs: 10_001,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await store.starts.completeCreation({
        fencingToken,
        workspaceKey: workspace,
        operationId: fixture.generated.operationId,
        state: "created",
        nowMs: 10_002,
      }),
    ).toMatchObject({
      ok: true,
      operation: { creationState: "created", titleState: "prepared", admissionState: "prepared" },
    });
    await store.cancelPending({
      fencingToken,
      workspaceKey: workspace,
      requestId: fixture.request.id,
      callerSessionId: source,
    });

    await recoverSessionStarts(
      store.starts,
      { nowMs: () => 10_003 },
      recoveryPorts(store, fencingToken),
    );
    const linked = await store.readSessionRequestStartByOperation({
      fencingToken,
      workspaceKey: workspace,
      operationId: fixture.generated.operationId,
    });
    expect(linked?.operation).toMatchObject({
      creationState: "created",
      titleState: "payload_unavailable",
      admissionState: "payload_unavailable",
    });
    const database = new Database(store.databasePath, { readonly: true, strict: true });
    expect(
      database
        .query<{ payloads: number; provenance: string }, [string]>(
          `SELECT
             (SELECT count(*) FROM start_operation_payloads WHERE operation_id = ?1) AS payloads,
             (SELECT provenance_state FROM managed_sessions WHERE operation_id = ?1) AS provenance`,
        )
        .get(fixture.generated.operationId),
    ).toEqual({ payloads: 0, provenance: "created" });
    database.close(true);
  } finally {
    store.close();
  }
});

test("expired prepared linked request retires its unstarted reservation", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const fixture = await prepareLinkedStart(store, fencingToken, 954);
    const database = new Database(store.databasePath, { strict: true });
    database.run(
      `UPDATE requests SET created_at_ms = 0, updated_at_ms = 0, deadline_at_ms = 10000
       WHERE id = ?`,
      [fixture.request.id],
    );
    database.close(true);
    expect(
      await store.expireDueRequests({ fencingToken, workspaceKey: workspace, limit: 10 }),
    ).toMatchObject({
      ok: true,
      requests: [{ id: fixture.request.id, resolutionState: "deadline_expired" }],
    });

    await recoverSessionStarts(
      store.starts,
      { nowMs: () => 10_001 },
      recoveryPorts(store, fencingToken),
    );
    const linked = await store.readSessionRequestStartByOperation({
      fencingToken,
      workspaceKey: workspace,
      operationId: fixture.generated.operationId,
    });
    expect(linked).toMatchObject({
      request: { resolutionState: "deadline_expired" },
      operation: {
        creationState: "request_terminal",
        admissionState: "payload_unavailable",
      },
    });
    expect(
      await store.starts.isManagedSession({
        fencingToken,
        workspaceKey: workspace,
        sessionId: fixture.generated.sessionId,
      }),
    ).toBe(false);
  } finally {
    store.close();
  }
});

test("terminal request reconciles ambiguous creation before preserving matching provenance", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const fixture = await prepareLinkedStart(store, fencingToken, 955);
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: fixture.generated.operationId,
      step: "creation",
      nowMs: 10_001,
    });
    await store.starts.completeCreation({
      fencingToken,
      workspaceKey: workspace,
      operationId: fixture.generated.operationId,
      state: "outcome_unknown",
      nowMs: 10_002,
    });
    await store.cancelPending({
      fencingToken,
      workspaceKey: workspace,
      requestId: fixture.request.id,
      callerSessionId: source,
    });
    let reconciliations = 0;
    const ports = recoveryPorts(store, fencingToken);
    await recoverSessionStarts(
      store.starts,
      { nowMs: () => 10_003 },
      {
        ...ports,
        nativeStart: {
          ...ports.nativeStart,
          async reconcileRootSession(): Promise<"matching"> {
            reconciliations += 1;
            return "matching";
          },
        },
      },
    );
    expect(reconciliations).toBe(1);
    const linked = await store.readSessionRequestStartByOperation({
      fencingToken,
      workspaceKey: workspace,
      operationId: fixture.generated.operationId,
    });
    expect(linked?.operation).toMatchObject({
      creationState: "created",
      admissionState: "payload_unavailable",
    });
    expect(
      await store.starts.isManagedSession({
        fencingToken,
        workspaceKey: workspace,
        sessionId: fixture.generated.sessionId,
      }),
    ).toBe(true);
  } finally {
    store.close();
  }
});

test("terminal request releases ambiguous creation only after proven native absence", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const fixture = await prepareLinkedStart(store, fencingToken, 957);
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: fixture.generated.operationId,
      step: "creation",
      nowMs: 10_001,
    });
    await store.starts.completeCreation({
      fencingToken,
      workspaceKey: workspace,
      operationId: fixture.generated.operationId,
      state: "outcome_unknown",
      nowMs: 10_002,
    });
    await store.cancelPending({
      fencingToken,
      workspaceKey: workspace,
      requestId: fixture.request.id,
      callerSessionId: source,
    });
    const ports = recoveryPorts(store, fencingToken);
    let reconciliations = 0;
    await recoverSessionStarts(
      store.starts,
      { nowMs: () => 10_003 },
      {
        ...ports,
        nativeStart: {
          ...ports.nativeStart,
          async reconcileRootSession(): Promise<"absent"> {
            reconciliations += 1;
            return "absent";
          },
        },
      },
    );
    expect(reconciliations).toBe(1);
    const linked = await store.readSessionRequestStartByOperation({
      fencingToken,
      workspaceKey: workspace,
      operationId: fixture.generated.operationId,
    });
    expect(linked?.operation.creationState).toBe("request_terminal");
    expect(
      await store.starts.isManagedSession({
        fencingToken,
        workspaceKey: workspace,
        sessionId: fixture.generated.sessionId,
      }),
    ).toBe(false);
  } finally {
    store.close();
  }
});

test("terminal request preserves stale admission ambiguity and never retries it", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const fixture = await prepareLinkedStart(store, fencingToken, 956);
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: fixture.generated.operationId,
      step: "creation",
      nowMs: 10_001,
    });
    await store.starts.completeCreation({
      fencingToken,
      workspaceKey: workspace,
      operationId: fixture.generated.operationId,
      state: "created",
      nowMs: 10_002,
    });
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: fixture.generated.operationId,
      step: "admission",
      nowMs: 10_003,
    });
    const database = new Database(store.databasePath, { strict: true });
    database.run("UPDATE start_operations SET claimed_fencing_token = ? WHERE id = ?", [
      fencingToken + 1,
      fixture.generated.operationId,
    ]);
    database.close(true);
    await store.cancelPending({
      fencingToken,
      workspaceKey: workspace,
      requestId: fixture.request.id,
      callerSessionId: source,
    });

    await recoverSessionStarts(
      store.starts,
      { nowMs: () => 10_004 },
      recoveryPorts(store, fencingToken),
    );
    const linked = await store.readSessionRequestStartByOperation({
      fencingToken,
      workspaceKey: workspace,
      operationId: fixture.generated.operationId,
    });
    expect(linked?.operation).toMatchObject({
      creationState: "created",
      admissionState: "admission_unknown",
    });
    expect(
      await store.starts.listRecoverable({
        fencingToken,
        workspaceKey: workspace,
        limit: 10,
        excludeClaimedByToken: fencingToken,
      }),
    ).toHaveLength(0);
  } finally {
    store.close();
  }
});

test("terminal linked request cleanup rolls back if its durable state transition fails", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const fixture = await prepareLinkedStart(store, fencingToken, 953);
    await store.cancelPending({
      fencingToken,
      workspaceKey: workspace,
      requestId: fixture.request.id,
      callerSessionId: source,
    });
    const fault = new Database(store.databasePath, { strict: true });
    fault.exec(`CREATE TRIGGER fail_terminal_start BEFORE UPDATE OF terminal_reason ON start_operations
      WHEN NEW.terminal_reason = 'request_terminal' BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    fault.close(true);

    await expect(
      recoverSessionStarts(
        store.starts,
        { nowMs: () => 10_001 },
        recoveryPorts(store, fencingToken),
      ),
    ).rejects.toThrow();
    const database = new Database(store.databasePath, { readonly: true, strict: true });
    expect(
      database
        .query<{ state: string; payloads: number; managed: number }, [string]>(
          `SELECT creation_state AS state,
             (SELECT count(*) FROM start_operation_payloads WHERE operation_id = ?1) AS payloads,
             (SELECT count(*) FROM managed_sessions WHERE operation_id = ?1) AS managed
           FROM start_operations WHERE id = ?1`,
        )
        .get(fixture.generated.operationId),
    ).toEqual({ state: "prepared", payloads: 1, managed: 1 });
    database.close(true);
  } finally {
    store.close();
  }
});
