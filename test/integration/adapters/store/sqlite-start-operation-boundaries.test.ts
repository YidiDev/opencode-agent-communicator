import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  hydrateStartOperation,
  type StartOperationRow,
} from "../../../../src/adapters/store/start-operation-rows";
import { StoreIntegrityError } from "../../../../src/adapters/store/store-types";
import type { StartLimits } from "../../../../src/application/session-start-ports";
import {
  validateManagedSessionId,
  validateNativeMessageId,
  validateStartOperationId,
} from "../../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../../src/domain/message-payload";
import type { FencingToken } from "../../../../src/domain/ownership";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestTemporaryRoot,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspace = valid(validateWorkspaceKey("start-boundaries"));
const foreign = valid(validateWorkspaceKey("start-boundaries-foreign"));
const source = valid(validateSessionId("ses_startsource"));
const limits: StartLimits = {
  managedSessionsPerWorkspace: 20,
  unresolvedProvenancePerWorkspace: 4,
  operationsPerWorkspace: 4_096,
  payloadBytesPerWorkspace: 8 * 1_024 * 1_024,
  startsPerSourceWindow: 20,
  startsPerWorkspaceWindow: 20,
  rateWindowMs: 60_000,
  terminalRetentionMs: 86_400_000,
};

function ids(seed: number) {
  const value = seed.toString(16).padStart(32, "0");
  return {
    operationId: valid(validateStartOperationId(`op_${value}`)),
    sessionId: valid(validateManagedSessionId(`ses_${value}`)),
    nativeMessageId: valid(validateNativeMessageId(`msg_${value}`)),
  };
}

function prepare(token: FencingToken, seed: number) {
  return {
    fencingToken: token,
    workspaceKey: workspace,
    sourceSessionId: source,
    ...ids(seed),
    argumentsSha256: seed.toString(16).repeat(64).slice(0, 64) as Sha256Digest,
    arguments: {
      idempotencyKey: `boundary:${seed}`,
      initialMessage: "perform bounded work",
      title: "Bounded worker",
      agent: "build",
      model: "provider/model",
    },
    limits,
    nowMs: 10_000 + seed,
  };
}

function openStartStore(stateDirectory?: string) {
  return openRequestStore({
    stateDirectory: stateDirectory ?? `${requestTemporaryRoot("start-boundaries-")}/state`,
    workspaceKey: workspace,
    ownerId: "start-boundary-owner",
    nowWallMs: () => 10_000,
    nowMonotonicMs: () => 10_000,
  });
}

describe("start operation public rejection behavior", () => {
  test("rejects foreign workspaces consistently and validates recovery limits", async () => {
    const store = openStartStore();
    const token = await store.acquire();
    const input = prepare(token, 1);
    expect(await store.starts.createOrResume({ ...input, workspaceKey: foreign })).toEqual({
      ok: false,
      code: "state_conflict",
    });
    expect(
      await store.starts.isManagedSession({
        fencingToken: token,
        workspaceKey: foreign,
        sessionId: input.sessionId,
      }),
    ).toBeFalse();
    for (const operation of [
      () => store.starts.claimStep({ ...input, workspaceKey: foreign, step: "creation" as const }),
      () =>
        store.starts.restorePreparedClaim({
          ...input,
          workspaceKey: foreign,
          step: "creation" as const,
        }),
      () =>
        store.starts.classifyStaleSubmitting({
          ...input,
          workspaceKey: foreign,
          step: "creation" as const,
        }),
      () =>
        store.starts.reconcileUnknownCreation({
          ...input,
          workspaceKey: foreign,
          outcome: "matching" as const,
        }),
      () => store.starts.releasePreparedReservation({ ...input, workspaceKey: foreign }),
      () =>
        store.starts.rejectPreparedStart({
          ...input,
          workspaceKey: foreign,
          state: "policy_denied" as const,
        }),
      () =>
        store.starts.completeCreation({
          ...input,
          workspaceKey: foreign,
          state: "failed" as const,
        }),
    ]) {
      expect(await operation()).toEqual({ ok: false, code: "state_conflict" });
    }
    await expect(
      store.starts.listRecoverable({
        fencingToken: token,
        workspaceKey: workspace,
        excludeClaimedByToken: token,
        limit: 0,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(
      await store.starts.collectRetention({
        fencingToken: token,
        workspaceKey: foreign,
        nowMs: 1,
        terminalRetentionMs: 1,
        rateRetentionMs: 1,
        limit: 1,
      }),
    ).toEqual({ ok: false, code: "state_conflict" });
    store.close();
  });

  test("returns state conflicts for absent or inapplicable transitions", async () => {
    const store = openStartStore();
    const token = await store.acquire();
    const input = prepare(token, 2);
    for (const result of [
      await store.starts.restorePreparedClaim({ ...input, step: "creation" }),
      await store.starts.classifyStaleSubmitting({ ...input, step: "creation" }),
      await store.starts.reconcileUnknownCreation({ ...input, outcome: "matching" }),
      await store.starts.releasePreparedReservation(input),
      await store.starts.rejectPreparedStart({ ...input, state: "approval_rejected" }),
      await store.starts.completeCreation({ ...input, state: "failed" }),
    ]) {
      expect(result).toEqual({ ok: false, code: "state_conflict" });
    }
    store.close();
  });

  test("rejects restoration of a prepared claim through a stale ownership fence", async () => {
    const store = openStartStore();
    const token = await store.acquire();
    const input = prepare(token, 25);
    expect((await store.starts.createOrResume(input)).ok).toBeTrue();
    expect((await store.starts.claimStep({ ...input, step: "creation" })).ok).toBeTrue();

    expect(
      await store.starts.restorePreparedClaim({
        ...input,
        fencingToken: (token + 1) as FencingToken,
        step: "creation",
      }),
    ).toEqual({ ok: false, code: "ownership_lost" });
    store.close();
  });

  test("classifies stale ownership and source/workspace rate admission without effects", async () => {
    const store = openStartStore();
    const token = await store.acquire();
    expect(
      await store.starts.createOrResume({
        ...prepare((token + 1) as FencingToken, 3),
      }),
    ).toEqual({ ok: false, code: "ownership_lost" });

    const sourceLimited = { ...prepare(token, 4), limits: { ...limits, startsPerSourceWindow: 1 } };
    expect((await store.starts.createOrResume(sourceLimited)).ok).toBeTrue();
    expect(
      await store.starts.createOrResume({
        ...prepare(token, 5),
        limits: sourceLimited.limits,
      }),
    ).toEqual({ ok: false, code: "rate_limited" });
    store.close();

    const workspaceStore = openStartStore();
    const workspaceToken = await workspaceStore.acquire();
    const workspaceLimits = { ...limits, startsPerSourceWindow: 10, startsPerWorkspaceWindow: 1 };
    expect(
      (
        await workspaceStore.starts.createOrResume({
          ...prepare(workspaceToken, 6),
          limits: workspaceLimits,
        })
      ).ok,
    ).toBeTrue();
    expect(
      await workspaceStore.starts.createOrResume({
        ...prepare(workspaceToken, 7),
        sourceSessionId: valid(validateSessionId("ses_otherstartsource")),
        limits: workspaceLimits,
      }),
    ).toEqual({ ok: false, code: "rate_limited" });
    workspaceStore.close();
  });

  test("enforces configured operation and retained payload byte quotas atomically", async () => {
    const store = openStartStore();
    const token = await store.acquire();
    const payloadLimited = {
      ...limits,
      payloadBytesPerWorkspace: new TextEncoder().encode(
        "perform bounded workBounded workerbuildprovider/model",
      ).length,
    };
    expect(
      (await store.starts.createOrResume({ ...prepare(token, 8), limits: payloadLimited })).ok,
    ).toBeTrue();
    expect(
      await store.starts.createOrResume({ ...prepare(token, 9), limits: payloadLimited }),
    ).toEqual({ ok: false, code: "quota_exceeded" });
    store.close();

    const operationStore = openStartStore();
    const operationToken = await operationStore.acquire();
    const operationLimited = { ...limits, operationsPerWorkspace: 1 };
    expect(
      (
        await operationStore.starts.createOrResume({
          ...prepare(operationToken, 8),
          limits: operationLimited,
        })
      ).ok,
    ).toBeTrue();
    expect(
      await operationStore.starts.createOrResume({
        ...prepare(operationToken, 9),
        limits: operationLimited,
      }),
    ).toEqual({ ok: false, code: "quota_exceeded" });
    operationStore.close();
  });
});

describe("start operation managed-session quota snapshots", () => {
  test("recreates reservations against the operation's immutable managed-session quota", async () => {
    const raisedStore = openStartStore();
    const raisedToken = await raisedStore.acquire();
    const originalLowLimits = { ...limits, managedSessionsPerWorkspace: 1 };
    const raisedLimits = { ...limits, managedSessionsPerWorkspace: 2 };
    const lowSnapshot = { ...prepare(raisedToken, 26), limits: originalLowLimits };
    expect((await raisedStore.starts.createOrResume(lowSnapshot)).ok).toBeTrue();
    expect(
      (
        await raisedStore.starts.releasePreparedReservation({
          fencingToken: raisedToken,
          workspaceKey: workspace,
          operationId: lowSnapshot.operationId,
          nowMs: lowSnapshot.nowMs + 1,
        })
      ).ok,
    ).toBeTrue();
    expect(
      (
        await raisedStore.starts.createOrResume({
          ...prepare(raisedToken, 27),
          limits: raisedLimits,
        })
      ).ok,
    ).toBeTrue();
    expect(
      await raisedStore.starts.createOrResume({
        ...lowSnapshot,
        limits: raisedLimits,
        nowMs: lowSnapshot.nowMs + 2,
      }),
    ).toEqual({ ok: false, code: "quota_exceeded" });
    raisedStore.close();

    const loweredStore = openStartStore();
    const loweredToken = await loweredStore.acquire();
    const originalHighLimits = { ...limits, managedSessionsPerWorkspace: 2 };
    const loweredLimits = { ...limits, managedSessionsPerWorkspace: 1 };
    const highSnapshot = { ...prepare(loweredToken, 28), limits: originalHighLimits };
    expect((await loweredStore.starts.createOrResume(highSnapshot)).ok).toBeTrue();
    expect(
      (
        await loweredStore.starts.releasePreparedReservation({
          fencingToken: loweredToken,
          workspaceKey: workspace,
          operationId: highSnapshot.operationId,
          nowMs: highSnapshot.nowMs + 1,
        })
      ).ok,
    ).toBeTrue();
    expect(
      (
        await loweredStore.starts.createOrResume({
          ...prepare(loweredToken, 29),
          limits: loweredLimits,
        })
      ).ok,
    ).toBeTrue();
    expect(
      (
        await loweredStore.starts.createOrResume({
          ...highSnapshot,
          limits: loweredLimits,
          nowMs: highSnapshot.nowMs + 2,
        })
      ).ok,
    ).toBeTrue();
    loweredStore.close();
  });
});

describe("start operation unknown provenance quotas", () => {
  test("refuses a second creation claim while the unknown-outcome capacity is occupied", async () => {
    const store = openStartStore();
    const token = await store.acquire();
    const bounded = {
      ...limits,
      managedSessionsPerWorkspace: 2,
      unresolvedProvenancePerWorkspace: 1,
    };
    const first = { ...prepare(token, 21), limits: bounded };
    const second = { ...prepare(token, 22), limits: bounded };
    expect((await store.starts.createOrResume(first)).ok).toBeTrue();
    expect((await store.starts.createOrResume(second)).ok).toBeTrue();
    expect((await store.starts.claimStep({ ...first, step: "creation" })).ok).toBeTrue();
    expect(await store.starts.claimStep({ ...second, step: "creation" })).toEqual({
      ok: false,
      code: "unresolved_provenance_quota_exceeded",
    });
    store.close();
  });

  test("does not recreate a lost prepared reservation while unknown provenance is at quota", async () => {
    const store = openStartStore();
    const token = await store.acquire();
    const bounded = {
      ...limits,
      managedSessionsPerWorkspace: 3,
      unresolvedProvenancePerWorkspace: 1,
    };
    const resumable = { ...prepare(token, 23), limits: bounded };
    const ambiguous = { ...prepare(token, 24), limits: bounded };
    expect((await store.starts.createOrResume(resumable)).ok).toBeTrue();
    const database = new Database(store.databasePath, { strict: true });
    database.run("DELETE FROM managed_sessions WHERE operation_id = ?", [resumable.operationId]);
    database.close(true);
    expect((await store.starts.createOrResume(ambiguous)).ok).toBeTrue();
    expect((await store.starts.claimStep({ ...ambiguous, step: "creation" })).ok).toBeTrue();
    expect(
      (
        await store.starts.completeCreation({
          ...ambiguous,
          state: "outcome_unknown",
          nowMs: ambiguous.nowMs + 1,
        })
      ).ok,
    ).toBeTrue();

    expect(await store.starts.createOrResume(resumable)).toEqual({
      ok: false,
      code: "unresolved_provenance_quota_exceeded",
    });
    expect(
      await store.starts.isManagedSession({
        fencingToken: token,
        workspaceKey: workspace,
        sessionId: resumable.sessionId,
      }),
    ).toBeFalse();
    store.close();
  });
});

describe("start operation corruption and recovery boundaries", () => {
  test("rolls back a claim whose private payload disappeared", async () => {
    const store = openStartStore();
    const token = await store.acquire();
    const input = prepare(token, 10);
    await store.starts.createOrResume(input);
    const database = new Database(store.databasePath, { strict: true });
    database.run("DELETE FROM start_operation_payloads WHERE operation_id = ?", [
      input.operationId,
    ]);
    database.close(true);
    expect(await store.starts.claimStep({ ...input, step: "creation" })).toEqual({
      ok: false,
      code: "storage_unavailable",
    });
    store.close();
  });

  test("rolls back when insertion or completion becomes unobservable", async () => {
    const insertionStore = openStartStore();
    const insertionToken = await insertionStore.acquire();
    const insertionDatabase = new Database(insertionStore.databasePath, { strict: true });
    insertionDatabase.exec(`CREATE TRIGGER hide_start_insert AFTER INSERT ON start_operations
      BEGIN DELETE FROM start_operations WHERE id = NEW.id; END;`);
    insertionDatabase.close(true);
    expect(await insertionStore.starts.createOrResume(prepare(insertionToken, 11))).toEqual({
      ok: false,
      code: "storage_unavailable",
    });
    insertionStore.close();

    const completionStore = openStartStore();
    const completionToken = await completionStore.acquire();
    const input = prepare(completionToken, 12);
    await completionStore.starts.createOrResume(input);
    await completionStore.starts.claimStep({ ...input, step: "creation" });
    const completionDatabase = new Database(completionStore.databasePath, { strict: true });
    completionDatabase.exec(`CREATE TRIGGER hide_start_completion AFTER UPDATE OF creation_state ON start_operations
      WHEN NEW.creation_state = 'failed' BEGIN DELETE FROM start_operations WHERE id = NEW.id; END;`);
    completionDatabase.close(true);
    expect(
      await completionStore.starts.completeCreation({ ...input, state: "failed", nowMs: 20_000 }),
    ).toEqual({ ok: false, code: "state_conflict" });
    completionStore.close();
  });

  test("requires the reserved managed-session provenance before committing creation", async () => {
    const store = openStartStore();
    const token = await store.acquire();
    const input = prepare(token, 13);
    await store.starts.createOrResume(input);
    await store.starts.claimStep({ ...input, step: "creation" });
    const database = new Database(store.databasePath, { strict: true });
    database.run("DELETE FROM managed_sessions WHERE operation_id = ?", [input.operationId]);
    database.close(true);
    expect(
      await store.starts.completeCreation({ ...input, state: "created", nowMs: 20_000 }),
    ).toEqual({ ok: false, code: "storage_unavailable" });
    store.close();
  });

  test("failed creation erases its private payload and releases the reserved session", async () => {
    const store = openStartStore();
    const token = await store.acquire();
    const input = prepare(token, 26);
    expect((await store.starts.createOrResume(input)).ok).toBeTrue();
    expect((await store.starts.claimStep({ ...input, step: "creation" })).ok).toBeTrue();

    expect(
      await store.starts.completeCreation({ ...input, state: "failed", nowMs: 20_000 }),
    ).toMatchObject({ ok: true, operation: { creationState: "failed" } });
    expect(
      await store.starts.isManagedSession({
        fencingToken: token,
        workspaceKey: workspace,
        sessionId: input.sessionId,
      }),
    ).toBeFalse();
    const inspection = new Database(store.databasePath, { readonly: true, strict: true });
    expect(
      inspection
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM start_operation_payloads WHERE operation_id = ?",
        )
        .get(input.operationId)?.count,
    ).toBe(0);
    inspection.close(true);
    store.close();
  });

  test("classifies stale title and admission claims with step-specific payload retention", async () => {
    for (const step of ["title", "admission"] as const) {
      const store = openStartStore();
      const token = await store.acquire();
      const input = prepare(token, step === "title" ? 14 : 15);
      await store.starts.createOrResume(input);
      await store.starts.claimStep({ ...input, step: "creation" });
      await store.starts.completeCreation({ ...input, state: "created", nowMs: 20_000 });
      await store.starts.claimStep({ ...input, step, nowMs: 20_001 });
      const database = new Database(store.databasePath, { strict: true });
      database.run("UPDATE start_operations SET claimed_fencing_token = ? WHERE id = ?", [
        Number(token) + 1,
        input.operationId,
      ]);
      database.close(true);
      const classified = await store.starts.classifyStaleSubmitting({
        ...input,
        step,
        nowMs: 20_002,
      });
      expect(classified).toMatchObject({
        ok: true,
        operation:
          step === "title"
            ? { titleState: "outcome_unknown" }
            : { admissionState: "admission_unknown" },
      });
      const inspection = new Database(store.databasePath, { readonly: true, strict: true });
      expect(
        inspection
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM start_operation_payloads WHERE operation_id = ?",
          )
          .get(input.operationId)?.count,
      ).toBe(step === "title" ? 1 : 0);
      inspection.close(true);
      store.close();
    }
  });
});

test("start row hydration rejects every persisted trust dimension", () => {
  const generated = ids(20);
  const row: StartOperationRow = {
    id: generated.operationId,
    workspaceKey: workspace,
    sourceSessionId: source,
    idempotencyKey: "hydrate",
    argumentsSha256: "a".repeat(64),
    sessionId: generated.sessionId,
    nativeMessageId: generated.nativeMessageId,
    creationState: "prepared",
    titleState: "not_started",
    admissionState: "not_started",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  expect(hydrateStartOperation(row)).toMatchObject({ id: generated.operationId });
  for (const override of [
    { id: "bad" },
    { workspaceKey: "bad workspace" },
    { sourceSessionId: "bad" },
    { sessionId: "bad" },
    { nativeMessageId: "bad" },
    { idempotencyKey: 1 },
    { argumentsSha256: "bad" },
    { creationState: "bad" },
    { titleState: "bad" },
    { admissionState: "bad" },
    { createdAtMs: 1.5 },
    { updatedAtMs: 1.5 },
  ]) {
    expect(() => hydrateStartOperation({ ...row, ...override })).toThrow(StoreIntegrityError);
  }
});
