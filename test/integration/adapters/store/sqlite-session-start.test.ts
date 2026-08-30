import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { dirname } from "node:path";

import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import { recoverSessionStarts } from "../../../../src/application/recover-session-starts";
import { validateRequestId } from "../../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../../src/domain/message-payload";
import { ids, limits, openStore, source, workspace } from "./sqlite-session-start-support";

test("rolls back the entire linked start when request preparation fails", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const generated = ids(900);
    const requestId = validateRequestId(`req_${generated.operationId.slice(3)}`);
    if (!requestId.ok) throw new Error("invalid fixture request id");
    const digest = "9".repeat(64) as Sha256Digest;
    expect(
      await store.createOrResumeSessionRequestStart({
        start: {
          fencingToken,
          workspaceKey: workspace,
          sourceSessionId: source,
          ...generated,
          argumentsSha256: digest,
          idempotencyArgumentsSha256: digest,
          arguments: { idempotencyKey: "composite:rollback", initialMessage: "envelope" },
          limits,
          nowMs: 10_000,
        },
        request: {
          fencingToken,
          creationOperationId: generated.operationId,
          deliveryMode: "initial",
          linkedStartOperationId: generated.operationId,
          request: {
            id: requestId.value,
            workspaceKey: workspace,
            sourceSessionId: source,
            targetSessionId: generated.sessionId,
            nativeMessageId: generated.nativeMessageId,
            deliveryMode: "initial",
            linkedStartOperationId: generated.operationId,
            kind: "wait",
            resolutionState: "pending",
            deliveryState: "prepared",
            resultState: "none",
            payloadByteLength: 2,
            payloadSha256: digest,
            createdAtMs: 10_000,
            updatedAtMs: 10_000,
            deadlineAtMs: 20_000,
          },
          payloadJson: "{}",
          envelopeJson: "{}",
        },
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    expect(
      await store.readSessionRequestStart({
        fencingToken,
        workspaceKey: workspace,
        sourceSessionId: source,
        idempotencyKey: "composite:rollback",
        idempotencyArgumentsSha256: digest,
      }),
    ).toEqual({ ok: true, found: false });
  } finally {
    store.close();
  }
});

test("deletion candidates include only created managed provenance", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const prepared = ids(901);
    const unresolved = ids(902);
    for (const [generated, key] of [
      [prepared, "candidate:prepared"],
      [unresolved, "candidate:unresolved"],
    ] as const) {
      expect(
        (
          await store.starts.createOrResume({
            fencingToken,
            workspaceKey: workspace,
            sourceSessionId: source,
            ...generated,
            argumentsSha256: "9".repeat(64) as Sha256Digest,
            arguments: { idempotencyKey: key, initialMessage: "work" },
            limits,
            nowMs: 10_000,
          })
        ).ok,
      ).toBe(true);
    }
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: unresolved.operationId,
      step: "creation",
      nowMs: 10_001,
    });
    await store.starts.completeCreation({
      fencingToken,
      workspaceKey: workspace,
      operationId: unresolved.operationId,
      state: "outcome_unknown",
      nowMs: 10_002,
    });
    expect(
      await store.listParticipantDeletionCandidates({ fencingToken, workspaceKey: workspace }),
    ).toEqual({ ok: true, sessionIds: [] });
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: prepared.operationId,
      step: "creation",
      nowMs: 10_003,
    });
    await store.starts.completeCreation({
      fencingToken,
      workspaceKey: workspace,
      operationId: prepared.operationId,
      state: "created",
      nowMs: 10_004,
    });
    expect(
      await store.listParticipantDeletionCandidates({ fencingToken, workspaceKey: workspace }),
    ).toEqual({ ok: true, sessionIds: [prepared.sessionId] });
    await store.deleteParticipantRequests({
      fencingToken,
      workspaceKey: workspace,
      deletedSessionId: prepared.sessionId,
    });
    expect(
      await store.listParticipantDeletionCandidates({ fencingToken, workspaceKey: workspace }),
    ).toEqual({ ok: true, sessionIds: [] });
  } finally {
    store.close();
  }
});

test("persists source-scoped idempotency before effects and resumes exact original IDs", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const generated = ids(1);
    const input = {
      fencingToken,
      workspaceKey: workspace,
      sourceSessionId: source,
      ...generated,
      argumentsSha256: "a".repeat(64) as Sha256Digest,
      arguments: { idempotencyKey: "start:one", initialMessage: "do work", title: "Worker" },
      limits,
      nowMs: 10_000,
    };
    const first = await store.starts.createOrResume(input);
    expect(first.ok).toBe(true);
    const repeated = await store.starts.createOrResume({ ...input, ...ids(2) });
    expect(repeated.ok).toBe(true);
    if (!first.ok || !repeated.ok) throw new Error("unexpected store failure");
    expect(repeated.operation.id).toBe(first.operation.id);
    expect(repeated.operation.sessionId).toBe(first.operation.sessionId);
    expect(repeated.operation.nativeMessageId).toBe(first.operation.nativeMessageId);
    const conflict = await store.starts.createOrResume({
      ...input,
      ...ids(3),
      argumentsSha256: "b".repeat(64) as Sha256Digest,
    });
    expect(conflict).toEqual({ ok: false, code: "idempotency_conflict" });
  } finally {
    store.close();
  }
});

test("participant deletion retires managed provenance and releases only the active quota", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const one = ids(101);
    const quotaOne = {
      ...limits,
      managedSessionsPerWorkspace: 1,
      unresolvedProvenancePerWorkspace: 1,
    };
    const first = await store.starts.createOrResume({
      fencingToken,
      workspaceKey: workspace,
      sourceSessionId: source,
      ...one,
      argumentsSha256: "a".repeat(64) as Sha256Digest,
      arguments: { idempotencyKey: "retire:one", initialMessage: "first" },
      limits: quotaOne,
      nowMs: 10_000,
    });
    expect(first.ok).toBe(true);
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: one.operationId,
      step: "creation",
      nowMs: 10_001,
    });
    await store.starts.completeCreation({
      fencingToken,
      workspaceKey: workspace,
      operationId: one.operationId,
      state: "created",
      nowMs: 10_002,
    });
    expect(
      await store.starts.createOrResume({
        fencingToken,
        workspaceKey: workspace,
        sourceSessionId: source,
        ...ids(102),
        argumentsSha256: "b".repeat(64) as Sha256Digest,
        arguments: { idempotencyKey: "retire:blocked", initialMessage: "blocked" },
        limits: quotaOne,
        nowMs: 10_003,
      }),
    ).toEqual({ ok: false, code: "quota_exceeded" });
    expect(
      await store.deleteParticipantRequests({
        fencingToken,
        workspaceKey: workspace,
        deletedSessionId: one.sessionId,
      }),
    ).toEqual({ ok: true, terminalized: [] });
    expect(
      await store.deleteParticipantRequests({
        fencingToken,
        workspaceKey: workspace,
        deletedSessionId: one.sessionId,
      }),
    ).toEqual({ ok: true, terminalized: [] });
    const second = await store.starts.createOrResume({
      fencingToken,
      workspaceKey: workspace,
      sourceSessionId: source,
      ...ids(103),
      argumentsSha256: "c".repeat(64) as Sha256Digest,
      arguments: { idempotencyKey: "retire:two", initialMessage: "second" },
      limits: quotaOne,
      nowMs: 10_004,
    });
    expect(second.ok).toBe(true);
    const database = new Database(store.databasePath, { readonly: true, strict: true });
    expect(
      database
        .query<{ state: string }, [string]>(
          "SELECT provenance_state AS state FROM managed_sessions WHERE session_id = ?",
        )
        .get(one.sessionId)?.state,
    ).toBe("deleted");
    expect(
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM managed_sessions").get()
        ?.count,
    ).toBe(2);
    database.close(true);
    const replay = await store.starts.createOrResume({
      fencingToken,
      workspaceKey: workspace,
      sourceSessionId: source,
      ...ids(104),
      argumentsSha256: "a".repeat(64) as Sha256Digest,
      arguments: { idempotencyKey: "retire:one", initialMessage: "first" },
      limits: quotaOne,
      nowMs: 10_005,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.code);
    expect(replay.operation.id).toBe(one.operationId);
  } finally {
    store.close();
  }
});

test("participant deletion rolls back when managed provenance cannot be retired", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const generated = ids(105);
    expect(
      (
        await store.starts.createOrResume({
          fencingToken,
          workspaceKey: workspace,
          sourceSessionId: source,
          ...generated,
          argumentsSha256: "e".repeat(64) as Sha256Digest,
          arguments: { idempotencyKey: "retire:corrupt", initialMessage: "private" },
          limits,
          nowMs: 10_000,
        })
      ).ok,
    ).toBeTrue();
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      step: "creation",
      nowMs: 10_001,
    });
    await store.starts.completeCreation({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      state: "created",
      nowMs: 10_002,
    });
    const database = new Database(store.databasePath, { strict: true });
    database.exec(`CREATE TRIGGER prevent_managed_retirement AFTER UPDATE OF provenance_state
      ON managed_sessions WHEN NEW.provenance_state = 'deleted'
      BEGIN UPDATE managed_sessions SET provenance_state = 'reserved'
        WHERE session_id = NEW.session_id; END;`);
    database.close(true);

    expect(
      await store.deleteParticipantRequests({
        fencingToken,
        workspaceKey: workspace,
        deletedSessionId: generated.sessionId,
      }),
    ).toEqual({ ok: false, code: "storage_unavailable" });
    expect(
      await store.starts.isManagedSession({
        fencingToken,
        workspaceKey: workspace,
        sessionId: generated.sessionId,
      }),
    ).toBeTrue();
  } finally {
    store.close();
  }
});

test("keeps creation, title, and admission as independent fenced state machines", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const generated = ids(4);
    const created = await store.starts.createOrResume({
      fencingToken,
      workspaceKey: workspace,
      sourceSessionId: source,
      ...generated,
      argumentsSha256: "c".repeat(64) as Sha256Digest,
      arguments: { idempotencyKey: "states", initialMessage: "do work", title: "Worker" },
      limits,
      nowMs: 10_000,
    });
    if (!created.ok) throw new Error("unexpected store failure");
    expect(created.operation).toMatchObject({
      creationState: "prepared",
      titleState: "not_started",
      admissionState: "not_started",
    });
    expect(
      (
        await store.starts.claimStep({
          fencingToken,
          workspaceKey: workspace,
          operationId: generated.operationId,
          step: "title",
          nowMs: 10_001,
        })
      ).ok,
    ).toBe(false);
    const creation = await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      step: "creation",
      nowMs: 10_001,
    });
    expect(creation.ok).toBe(true);
    const creationComplete = await store.starts.completeCreation({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      state: "created",
      nowMs: 10_002,
    });
    if (!creationComplete.ok) throw new Error("unexpected completion failure");
    expect(creationComplete.operation).toMatchObject({
      titleState: "prepared",
      admissionState: "prepared",
    });
    expect(
      await store.starts.isManagedSession({
        fencingToken,
        workspaceKey: workspace,
        sessionId: generated.sessionId,
      }),
    ).toBe(true);
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      step: "title",
      nowMs: 10_003,
    });
    const title = await store.starts.completeTitle({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      state: "failed",
      nowMs: 10_004,
    });
    expect(title.ok && title.operation.titleState).toBe("failed");
    const admission = await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      step: "admission",
      nowMs: 10_005,
    });
    expect(admission.ok).toBe(true);
  } finally {
    store.close();
  }
});

test("isolates ambiguous provenance from the ordinary managed quota", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const prepare = (index: number) =>
      store.starts.createOrResume({
        fencingToken,
        workspaceKey: workspace,
        sourceSessionId: source,
        ...ids(index),
        argumentsSha256: index.toString(16).repeat(64).slice(0, 64) as Sha256Digest,
        arguments: { idempotencyKey: `quota:${index}`, initialMessage: "do work" },
        limits,
        nowMs: 10_000 + index,
      });
    const concurrent = await Promise.all([prepare(6), prepare(7), prepare(8)]);
    expect(concurrent.filter((result) => result.ok)).toHaveLength(2);
    expect(concurrent.filter((result) => !result.ok)).toEqual([
      { ok: false, code: "quota_exceeded" },
    ]);
    expect(
      await store.starts.isManagedSession({
        fencingToken,
        workspaceKey: workspace,
        sessionId: ids(6).sessionId,
      }),
    ).toBe(true);
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: ids(6).operationId,
      step: "creation",
      nowMs: 10_010,
    });
    expect(
      (
        await store.starts.completeCreation({
          fencingToken,
          workspaceKey: workspace,
          operationId: ids(6).operationId,
          state: "outcome_unknown",
          nowMs: 10_011,
        })
      ).ok,
    ).toBe(true);
    expect((await prepare(8)).ok).toBe(true);
  } finally {
    store.close();
  }
});

test("reports the configured unresolved provenance quota separately", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const bounded = {
      ...limits,
      managedSessionsPerWorkspace: 20,
      unresolvedProvenancePerWorkspace: 1,
    };
    const first = await store.starts.createOrResume({
      fencingToken,
      workspaceKey: workspace,
      sourceSessionId: source,
      ...ids(16),
      argumentsSha256: "a".repeat(64) as Sha256Digest,
      arguments: { idempotencyKey: "unresolved:1", initialMessage: "work" },
      limits: bounded,
      nowMs: 30_000,
    });
    expect(first.ok).toBe(true);
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: ids(16).operationId,
      step: "creation",
      nowMs: 30_001,
    });
    await store.starts.completeCreation({
      fencingToken,
      workspaceKey: workspace,
      operationId: ids(16).operationId,
      state: "outcome_unknown",
      nowMs: 30_002,
    });
    expect(
      await store.starts.createOrResume({
        fencingToken,
        workspaceKey: workspace,
        sourceSessionId: source,
        ...ids(17),
        argumentsSha256: "b".repeat(64) as Sha256Digest,
        arguments: { idempotencyKey: "unresolved:2", initialMessage: "work" },
        limits: bounded,
        nowMs: 30_003,
      }),
    ).toEqual({ ok: false, code: "unresolved_provenance_quota_exceeded" });
  } finally {
    store.close();
  }
});

test("erases start payload after terminal admission while retaining created provenance", async () => {
  const store = openStore();
  const databasePath = store.databasePath;
  try {
    const fencingToken = await store.acquire();
    const generated = ids(9);
    await store.starts.createOrResume({
      fencingToken,
      workspaceKey: workspace,
      sourceSessionId: source,
      ...generated,
      argumentsSha256: "9".repeat(64) as Sha256Digest,
      arguments: { idempotencyKey: "cleanup", initialMessage: "sensitive payload" },
      limits,
      nowMs: 10_000,
    });
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      step: "creation",
      nowMs: 10_001,
    });
    await store.starts.completeCreation({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      state: "created",
      nowMs: 10_002,
    });
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      step: "admission",
      nowMs: 10_003,
    });
    await store.starts.completeAdmission({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      state: "admitted",
      nowMs: 10_004,
    });
  } finally {
    store.close();
  }
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    expect(
      database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM start_operation_payloads")
        .get()?.count,
    ).toBe(0);
    expect(
      database
        .query<{ state: string }, []>("SELECT provenance_state AS state FROM managed_sessions")
        .get()?.state,
    ).toBe("created");
  } finally {
    database.close(true);
  }
});

test("startup recovery marks submitting boundaries unknown and never invokes native effects", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const generated = ids(5);
    await store.starts.createOrResume({
      fencingToken,
      workspaceKey: workspace,
      sourceSessionId: source,
      ...generated,
      argumentsSha256: "d".repeat(64) as Sha256Digest,
      arguments: { idempotencyKey: "recover", initialMessage: "do work" },
      limits,
      nowMs: 10_000,
    });
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      step: "creation",
      nowMs: 10_001,
    });
    const stateDirectory = dirname(store.databasePath);
    store.close();
    const restarted = new LinuxBunSqliteStore({
      stateDirectory,
      workspaceKey: workspace,
      ownerId: "start-recovery-test",
      nowWallMs: () => 10_000,
      nowMonotonicMs: () => 10_000,
    });
    const restartedToken = await restarted.acquire();
    const summary = await recoverSessionStarts(
      restarted.starts,
      { nowMs: () => 10_002 },
      { fencingToken: restartedToken, workspaceKey: workspace },
    );
    expect(summary).toEqual({
      preparedAwaitingInvocationApproval: 0,
      creationOutcomesUnknown: 1,
      titleOutcomesUnknown: 0,
      admissionsUnknown: 0,
    });
    const recoverable = await restarted.starts.listRecoverable({
      fencingToken: restartedToken,
      workspaceKey: workspace,
      limit: 10,
      excludeClaimedByToken: restartedToken,
    });
    expect(recoverable).toHaveLength(1);
    expect(recoverable[0]?.creationState).toBe("outcome_unknown");
    const inspection = new Database(restarted.databasePath, { readonly: true, strict: true });
    expect(
      inspection
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM start_operation_payloads WHERE operation_id = ?",
        )
        .get(generated.operationId)?.count,
    ).toBe(1);
    inspection.close(true);
    restarted.close();
  } finally {
    store.close();
  }
});

test("reconciles an exact match after payload erasure without inventing continuation work", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const generated = ids(15);
    await store.starts.createOrResume({
      fencingToken,
      workspaceKey: workspace,
      sourceSessionId: source,
      ...generated,
      argumentsSha256: "e".repeat(64) as Sha256Digest,
      arguments: {
        idempotencyKey: "reconcile-erased",
        initialMessage: "private",
        title: "worker",
        agent: "build",
        model: "provider/model",
      },
      limits,
      nowMs: 20_000,
    });
    await store.starts.claimStep({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      step: "creation",
      nowMs: 20_001,
    });
    await store.starts.completeCreation({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      state: "outcome_unknown",
      nowMs: 20_002,
    });
    const corruption = new Database(store.databasePath, { strict: true });
    corruption.run("DELETE FROM start_operation_payloads WHERE operation_id = ?", [
      generated.operationId,
    ]);
    corruption.close(true);
    const reconciled = await store.starts.reconcileUnknownCreation({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      outcome: "matching",
      nowMs: 20_003,
    });
    expect(reconciled).toMatchObject({
      ok: true,
      operation: {
        creationState: "created",
        titleState: "payload_unavailable",
        admissionState: "payload_unavailable",
        requestedAgent: "build",
        requestedModel: "provider/model",
      },
    });
  } finally {
    store.close();
  }
});
