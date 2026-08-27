import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { dirname } from "node:path";

import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import { recoverSessionStarts } from "../../../../src/application/recover-session-starts";
import type { Sha256Digest } from "../../../../src/domain/message-payload";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";
import { ids, limits, openStore, source, valid, workspace } from "./sqlite-session-start-support";

test("an exact ambiguous match restores only continuation work backed by retained payload", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    for (const [index, title, erasePayload, expectedTitleState, expectedAdmissionState] of [
      [115, "Recovered worker", false, "prepared", "prepared"],
      [116, undefined, false, "skipped", "prepared"],
      [117, undefined, true, "skipped", "payload_unavailable"],
    ] as const) {
      const generated = ids(index);
      const input = {
        fencingToken,
        workspaceKey: workspace,
        sourceSessionId: source,
        ...generated,
        argumentsSha256: index.toString(16).repeat(64).slice(0, 64) as Sha256Digest,
        arguments: {
          idempotencyKey: `matching-retained:${index}`,
          initialMessage: "private retained admission",
          ...(title === undefined ? {} : { title }),
        },
        limits: { ...limits, managedSessionsPerWorkspace: 4 },
        nowMs: 50_000 + index,
      };
      expect((await store.starts.createOrResume(input)).ok).toBeTrue();
      expect((await store.starts.claimStep({ ...input, step: "creation" })).ok).toBeTrue();
      expect(
        (
          await store.starts.completeCreation({
            ...input,
            state: "outcome_unknown",
            nowMs: 51_000 + index,
          })
        ).ok,
      ).toBeTrue();
      if (erasePayload) {
        const database = new Database(store.databasePath, { strict: true });
        database.run("DELETE FROM start_operation_payloads WHERE operation_id = ?", [
          generated.operationId,
        ]);
        database.close(true);
      }

      expect(
        await store.starts.reconcileUnknownCreation({
          ...input,
          outcome: "matching",
          nowMs: 52_000 + index,
        }),
      ).toMatchObject({
        ok: true,
        operation: {
          creationState: "created",
          titleState: expectedTitleState,
          admissionState: expectedAdmissionState,
        },
      });
    }
  } finally {
    store.close();
  }
});

test("confirmed absence and collision release ambiguous reservations without adoption", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    for (const [index, outcome] of [
      [18, "absent"],
      [19, "collision"],
    ] as const) {
      const generated = ids(index);
      await store.starts.createOrResume({
        fencingToken,
        workspaceKey: workspace,
        sourceSessionId: source,
        ...generated,
        argumentsSha256: index.toString(16).repeat(64).slice(0, 64) as Sha256Digest,
        arguments: { idempotencyKey: `reconcile:${outcome}`, initialMessage: "private" },
        limits,
        nowMs: 40_000 + index,
      });
      await store.starts.claimStep({
        fencingToken,
        workspaceKey: workspace,
        operationId: generated.operationId,
        step: "creation",
        nowMs: 40_100 + index,
      });
      await store.starts.completeCreation({
        fencingToken,
        workspaceKey: workspace,
        operationId: generated.operationId,
        state: "outcome_unknown",
        nowMs: 40_200 + index,
      });
      expect(
        await store.starts.reconcileUnknownCreation({
          fencingToken,
          workspaceKey: workspace,
          operationId: generated.operationId,
          outcome,
          nowMs: 40_300 + index,
        }),
      ).toMatchObject({ ok: true, operation: { creationState: "failed" } });
      expect(
        await store.starts.isManagedSession({
          fencingToken,
          workspaceKey: workspace,
          sessionId: generated.sessionId,
        }),
      ).toBe(false);
    }
  } finally {
    store.close();
  }
});

test("matching reconciliation cannot exceed the operation's configured managed-session quota", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const quotaOne = {
      ...limits,
      managedSessionsPerWorkspace: 1,
      startsPerSourceWindow: 10,
      startsPerWorkspaceWindow: 10,
    };
    const ambiguous = ids(118);
    const counted = ids(119);
    const prepare = (
      generated: ReturnType<typeof ids>,
      key: string,
      digestCharacter: string,
      nowMs: number,
    ) =>
      store.starts.createOrResume({
        fencingToken,
        workspaceKey: workspace,
        sourceSessionId: source,
        ...generated,
        argumentsSha256: digestCharacter.repeat(64) as Sha256Digest,
        arguments: { idempotencyKey: key, initialMessage: "work" },
        limits: quotaOne,
        nowMs,
      });

    expect((await prepare(ambiguous, "reconcile-quota-ambiguous", "a", 60_000)).ok).toBeTrue();
    expect(
      (
        await store.starts.claimStep({
          fencingToken,
          workspaceKey: workspace,
          operationId: ambiguous.operationId,
          step: "creation",
          nowMs: 60_001,
        })
      ).ok,
    ).toBeTrue();
    expect(
      (
        await store.starts.completeCreation({
          fencingToken,
          workspaceKey: workspace,
          operationId: ambiguous.operationId,
          state: "outcome_unknown",
          nowMs: 60_002,
        })
      ).ok,
    ).toBeTrue();

    expect((await prepare(counted, "reconcile-quota-counted", "b", 60_003)).ok).toBeTrue();
    expect(
      (
        await store.starts.claimStep({
          fencingToken,
          workspaceKey: workspace,
          operationId: counted.operationId,
          step: "creation",
          nowMs: 60_004,
        })
      ).ok,
    ).toBeTrue();
    expect(
      (
        await store.starts.completeCreation({
          fencingToken,
          workspaceKey: workspace,
          operationId: counted.operationId,
          state: "created",
          nowMs: 60_005,
        })
      ).ok,
    ).toBeTrue();

    expect(
      await store.starts.reconcileUnknownCreation({
        fencingToken,
        workspaceKey: workspace,
        operationId: ambiguous.operationId,
        outcome: "matching",
        nowMs: 60_006,
      }),
    ).toEqual({ ok: false, code: "quota_exceeded" });
    const database = new Database(store.databasePath, { readonly: true, strict: true });
    expect(
      database
        .query<
          { creationState: string; managedSessionLimit: number; provenanceState: string },
          [string]
        >(
          `SELECT o.creation_state AS creationState,
             o.managed_session_limit AS managedSessionLimit,
             m.provenance_state AS provenanceState
           FROM start_operations AS o JOIN managed_sessions AS m ON m.operation_id = o.id
           WHERE o.id = ?`,
        )
        .get(ambiguous.operationId),
    ).toEqual({
      creationState: "outcome_unknown",
      managedSessionLimit: 1,
      provenanceState: "unresolved",
    });
    database.close(true);
  } finally {
    store.close();
  }
});

test("restores a claim only for its owner and permits the prepared step to be reclaimed", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const generated = ids(10);
    await store.starts.createOrResume({
      fencingToken,
      workspaceKey: workspace,
      sourceSessionId: source,
      ...generated,
      argumentsSha256: "a".repeat(64) as Sha256Digest,
      arguments: { idempotencyKey: "restore", initialMessage: "do work" },
      limits,
      nowMs: 10_000,
    });
    expect(
      (
        await store.starts.claimStep({
          fencingToken,
          workspaceKey: workspace,
          operationId: generated.operationId,
          step: "creation",
          nowMs: 10_001,
        })
      ).ok,
    ).toBe(true);
    const restored = await store.starts.restorePreparedClaim({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      step: "creation",
      nowMs: 10_002,
    });
    expect(restored.ok && restored.operation.creationState).toBe("prepared");
    expect(
      (
        await store.starts.claimStep({
          fencingToken,
          workspaceKey: workspace,
          operationId: generated.operationId,
          step: "creation",
          nowMs: 10_003,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await store.starts.restorePreparedClaim({
          fencingToken,
          workspaceKey: valid(validateWorkspaceKey("workspace:foreign")),
          operationId: generated.operationId,
          step: "creation",
          nowMs: 10_004,
        })
      ).ok,
    ).toBe(false);
  } finally {
    store.close();
  }
});

test("releases only a prepared reservation and re-reserves it on an idempotent resume", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const generated = ids(11);
    const input = {
      fencingToken,
      workspaceKey: workspace,
      sourceSessionId: source,
      ...generated,
      argumentsSha256: "b".repeat(64) as Sha256Digest,
      arguments: { idempotencyKey: "release", initialMessage: "do work" },
      limits,
      nowMs: 10_000,
    };
    await store.starts.createOrResume(input);
    const released = await store.starts.releasePreparedReservation({
      fencingToken,
      workspaceKey: workspace,
      operationId: generated.operationId,
      nowMs: 10_001,
    });
    expect(released.ok).toBe(true);
    expect(
      await store.starts.isManagedSession({
        fencingToken,
        workspaceKey: workspace,
        sessionId: generated.sessionId,
      }),
    ).toBe(false);
    expect((await store.starts.createOrResume({ ...input, nowMs: 10_002 })).ok).toBe(true);
    expect(
      await store.starts.isManagedSession({
        fencingToken,
        workspaceKey: workspace,
        sessionId: generated.sessionId,
      }),
    ).toBe(true);
    expect(
      (
        await store.starts.releasePreparedReservation({
          fencingToken,
          workspaceKey: valid(validateWorkspaceKey("workspace:foreign")),
          operationId: generated.operationId,
          nowMs: 10_003,
        })
      ).ok,
    ).toBe(false);
  } finally {
    store.close();
  }
});

test("atomically terminalizes approval rejection without payload and resumes deterministically", async () => {
  const store = openStore();
  const databasePath = store.databasePath;
  const input = {
    fencingToken: await store.acquire(),
    workspaceKey: workspace,
    sourceSessionId: source,
    ...ids(12),
    argumentsSha256: "c".repeat(64) as Sha256Digest,
    arguments: { idempotencyKey: "rejected", initialMessage: "sensitive rejection payload" },
    limits,
    nowMs: 10_000,
  };
  try {
    expect((await store.starts.createOrResume(input)).ok).toBeTrue();
    const bypass = new Database(databasePath, { strict: true });
    try {
      expect(() =>
        bypass.run(
          "UPDATE start_operations SET creation_state = 'approval_rejected' WHERE id = ?",
          [input.operationId],
        ),
      ).toThrow();
    } finally {
      bypass.close(true);
    }
    const rejected = await store.starts.rejectPreparedStart({
      fencingToken: input.fencingToken,
      workspaceKey: workspace,
      operationId: input.operationId,
      state: "approval_rejected",
      nowMs: 10_001,
    });
    expect(rejected).toMatchObject({
      ok: true,
      operation: { creationState: "approval_rejected" },
    });
    expect(await store.starts.createOrResume({ ...input, ...ids(13), nowMs: 10_002 })).toEqual(
      rejected,
    );
    expect(
      await store.starts.createOrResume({
        ...input,
        ...ids(14),
        argumentsSha256: "d".repeat(64) as Sha256Digest,
      }),
    ).toEqual({ ok: false, code: "idempotency_conflict" });
    const terminalBypass = new Database(databasePath, { strict: true });
    try {
      expect(() =>
        terminalBypass.run(
          `INSERT INTO start_operation_payloads(operation_id, initial_message, title, agent, model)
           VALUES (?, 'secret', NULL, NULL, NULL)`,
          [input.operationId],
        ),
      ).toThrow();
      expect(() =>
        terminalBypass.run(
          `INSERT INTO managed_sessions(session_id, workspace_key, source_session_id,
             operation_id, provenance_state, created_at_ms)
           VALUES (?, ?, ?, ?, 'reserved', ?)`,
          [input.sessionId, workspace, source, input.operationId, 10_002],
        ),
      ).toThrow();
    } finally {
      terminalBypass.close(true);
    }
  } finally {
    store.close();
  }
  const restarted = new LinuxBunSqliteStore({
    stateDirectory: dirname(databasePath),
    workspaceKey: workspace,
    ownerId: "rejected-start-recovery",
    nowWallMs: () => 10_003,
    nowMonotonicMs: () => 10_003,
  });
  try {
    const restartedToken = await restarted.acquire();
    expect(
      await recoverSessionStarts(
        restarted.starts,
        { nowMs: () => 10_003 },
        { fencingToken: restartedToken, workspaceKey: workspace },
      ),
    ).toEqual({
      preparedAwaitingInvocationApproval: 0,
      creationOutcomesUnknown: 0,
      titleOutcomesUnknown: 0,
      admissionsUnknown: 0,
    });
  } finally {
    restarted.close();
  }
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    expect(
      database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM start_operation_payloads")
        .get()?.count,
    ).toBe(0);
    expect(
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM managed_sessions").get()
        ?.count,
    ).toBe(0);
  } finally {
    database.close(true);
  }
});

test("age-bounded GC prevents 1024 denied keys from permanently exhausting start records", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const bounded = {
      ...limits,
      managedSessionsPerWorkspace: 1_024,
      operationsPerWorkspace: 1_024,
      startsPerSourceWindow: 1_000,
      startsPerWorkspaceWindow: 1_000,
      rateWindowMs: 1,
      terminalRetentionMs: 10,
    };
    for (let index = 100; index < 1_124; index += 1) {
      const nowMs = 20_000 + index * 2;
      const generated = ids(index);
      const created = await store.starts.createOrResume({
        fencingToken,
        workspaceKey: workspace,
        sourceSessionId: source,
        ...generated,
        argumentsSha256: index.toString(16).padStart(64, "0") as Sha256Digest,
        arguments: { idempotencyKey: `denied:${index}`, initialMessage: "erase me" },
        limits: bounded,
        nowMs,
      });
      expect(created.ok).toBeTrue();
      expect(
        (
          await store.starts.rejectPreparedStart({
            fencingToken,
            workspaceKey: workspace,
            operationId: generated.operationId,
            state: "policy_denied",
            nowMs: nowMs + 1,
          })
        ).ok,
      ).toBeTrue();
    }
    expect(
      (
        await store.starts.createOrResume({
          fencingToken,
          workspaceKey: workspace,
          sourceSessionId: source,
          ...ids(1_200),
          argumentsSha256: "e".repeat(64) as Sha256Digest,
          arguments: { idempotencyKey: "admitted-after-gc", initialMessage: "work" },
          limits: bounded,
          nowMs: 30_000,
        })
      ).ok,
    ).toBeTrue();
    const retained = await store.starts.collectRetention({
      fencingToken,
      workspaceKey: workspace,
      nowMs: 40_000,
      terminalRetentionMs: bounded.terminalRetentionMs,
      rateRetentionMs: bounded.rateWindowMs,
      limit: 1_000,
    });
    expect(retained).toMatchObject({ ok: true, deletedOperations: 0 });
    expect(
      (
        await store.starts.createOrResume({
          fencingToken,
          workspaceKey: workspace,
          sourceSessionId: source,
          ...ids(1_200),
          argumentsSha256: "e".repeat(64) as Sha256Digest,
          arguments: { idempotencyKey: "admitted-after-gc", initialMessage: "work" },
          limits: bounded,
          nowMs: 40_001,
        })
      ).ok,
    ).toBeTrue();
  } finally {
    store.close();
  }
}, 60_000);
