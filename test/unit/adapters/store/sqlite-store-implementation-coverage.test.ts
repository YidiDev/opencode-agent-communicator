import { describe, expect, test } from "bun:test";

import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store-implementation";

const workspaceKey = "sqlite-store-coverage";
const otherWorkspaceKey = "sqlite-store-other";
const sourceSessionId = `ses_${"1".repeat(32)}`;
const targetSessionId = `ses_${"2".repeat(32)}`;
const nativeMessageId = `msg_${"3".repeat(32)}`;
const operationId = `op_${"4".repeat(32)}`;
const replayOperationId = `op_${"5".repeat(32)}`;

function operation(id = operationId) {
  return {
    id,
    workspaceKey,
    sourceSessionId,
    idempotencyKey: "coverage-key",
    argumentsSha256: "a".repeat(64),
    sessionId: targetSessionId,
    nativeMessageId,
    creationState: "prepared",
    titleState: "not_started",
    admissionState: "not_started",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function operationRow(id = operationId) {
  return operation(id);
}

function linkedRequest(id = operationId) {
  return { id: `req_${id.slice(3)}`, linkedStartOperationId: id, resolutionState: "pending" };
}

type HarnessOptions = {
  readonly row?: unknown;
  readonly request?: unknown;
  readonly startResult?: unknown;
  readonly preparedRequestResult?: unknown;
  readonly transactionFailure?: unknown;
};

function harness(options: HarnessOptions = {}) {
  const accessCalls: string[] = [];
  const ownershipInputs: unknown[] = [];
  const queryArguments: unknown[][] = [];
  const store = Object.create(LinuxBunSqliteStore.prototype) as LinuxBunSqliteStore;
  const startResult = options.startResult ?? { ok: true, operation: operation() };
  const preparedRequestResult = options.preparedRequestResult ?? {
    ok: true,
    request: linkedRequest(),
  };
  const transaction = (callback: () => unknown) => ({
    immediate: () => {
      if (options.transactionFailure !== undefined) throw options.transactionFailure;
      return callback();
    },
  });
  Object.assign(store as object, {
    isClosed: false,
    context: {
      workspaceKey,
      database: {
        query: () => ({
          get: (...args: unknown[]) => {
            queryArguments.push(args);
            return options.row;
          },
        }),
        transaction,
      },
    },
    access: {
      inspect: (callback: () => unknown) => {
        accessCalls.push("inspect");
        return callback();
      },
      mutate: (callback: () => unknown) => {
        accessCalls.push("mutate");
        return callback();
      },
      close: () => accessCalls.push("close"),
    },
    ownershipRepository: {
      assertOrdinaryWorkAllowed: (input: unknown) => ownershipInputs.push(input),
      assertCurrent: (input: unknown) => ownershipInputs.push(input),
    },
    requestRepository: {
      getRequestMetadata: () => options.request,
      getRequestMetadataForRecovery: () => options.request,
      createPreparedInTransaction: () => preparedRequestResult,
    },
    startRepository: {
      createOrResumeInTransaction: () => startResult,
    },
  });
  return { store, accessCalls, ownershipInputs, queryArguments };
}

function compositeInput(overrides: Record<string, unknown> = {}) {
  return {
    start: {
      operationId,
      fencingToken: 7,
      workspaceKey,
      sourceSessionId,
      sessionId: targetSessionId,
      nativeMessageId,
      argumentsSha256: "a".repeat(64),
      idempotencyArgumentsSha256: "b".repeat(64),
    },
    request: {
      creationOperationId: operationId,
      deliveryMode: "initial",
      linkedStartOperationId: operationId,
      request: { workspaceKey, sourceSessionId, targetSessionId, nativeMessageId },
    },
    ...overrides,
  };
}

describe("SQLite store composite start/request coverage", () => {
  test("reads by operation through inspected, ownership-checked access", async () => {
    const absentWorkspace = harness();
    expect(
      await absentWorkspace.store.readSessionRequestStartByOperation({
        fencingToken: 7,
        workspaceKey: otherWorkspaceKey,
        operationId,
      } as never),
    ).toBeUndefined();
    expect(absentWorkspace.queryArguments).toEqual([]);

    const absentRow = harness();
    expect(
      await absentRow.store.readSessionRequestStartByOperation({
        fencingToken: 8,
        workspaceKey,
        operationId,
      } as never),
    ).toBeUndefined();

    const unlinked = harness({
      row: operationRow(),
      request: { linkedStartOperationId: replayOperationId },
    });
    expect(
      await unlinked.store.readSessionRequestStartByOperation({
        fencingToken: 9,
        workspaceKey,
        operationId,
      } as never),
    ).toBeUndefined();

    const linked = harness({ row: operationRow(), request: linkedRequest() });
    expect(
      (await linked.store.readSessionRequestStartByOperation({
        fencingToken: 10,
        workspaceKey,
        operationId,
      } as never)) as unknown,
    ).toEqual({ operation: operation(), request: linkedRequest() });
    expect(linked.accessCalls).toEqual(["mutate"]);
    expect(linked.ownershipInputs).toEqual([10]);
    expect(linked.queryArguments).toEqual([[workspaceKey, operationId]]);
  });

  test("classifies lookup absence, digest conflicts, and broken or valid links", async () => {
    const input = {
      fencingToken: 7,
      workspaceKey,
      sourceSessionId,
      idempotencyKey: "coverage-key",
      idempotencyArgumentsSha256: "b".repeat(64),
    } as const;
    expect(
      await harness().store.readSessionRequestStart({
        ...input,
        workspaceKey: otherWorkspaceKey,
      } as never),
    ).toEqual({ ok: false, code: "state_conflict" });
    expect(await harness().store.readSessionRequestStart(input as never)).toEqual({
      ok: true,
      found: false,
    });
    expect(
      await harness({
        row: { ...operationRow(), idempotencyDigest: "c".repeat(64) },
      }).store.readSessionRequestStart(input as never),
    ).toEqual({ ok: false, code: "idempotency_conflict" });
    expect(
      await harness({
        row: { ...operationRow(), idempotencyDigest: "b".repeat(64) },
      }).store.readSessionRequestStart(input as never),
    ).toEqual({ ok: false, code: "state_conflict" });
    expect(
      (await harness({
        row: { ...operationRow(), idempotencyDigest: "b".repeat(64) },
        request: linkedRequest(),
      }).store.readSessionRequestStart(input as never)) as unknown,
    ).toEqual({ ok: true, found: true, operation: operation(), request: linkedRequest() });
  });

  test("rejects inconsistent composite arguments before opening a transaction", async () => {
    const fixture = harness();
    const input = compositeInput();
    (input.request.request as { nativeMessageId: string }).nativeMessageId =
      `msg_${"9".repeat(32)}`;
    expect(await fixture.store.createOrResumeSessionRequestStart(input as never)).toEqual({
      ok: false,
      code: "state_conflict",
    });
    expect(fixture.accessCalls).toEqual(["mutate"]);
  });

  test("maps repository rejections and rethrows unrelated transaction failures", async () => {
    expect(
      await harness({
        startResult: { ok: false, code: "idempotency_conflict" },
      }).store.createOrResumeSessionRequestStart(compositeInput() as never),
    ).toEqual({ ok: false, code: "idempotency_conflict" });
    expect(
      await harness({
        preparedRequestResult: { ok: false, code: "state_conflict" },
      }).store.createOrResumeSessionRequestStart(compositeInput() as never),
    ).toEqual({ ok: false, code: "state_conflict" });

    const failure = new Error("transaction failure");
    await expect(
      harness({ transactionFailure: failure }).store.createOrResumeSessionRequestStart(
        compositeInput() as never,
      ),
    ).rejects.toBe(failure);
  });

  test("returns exact preparations and idempotent replays with their linked requests", async () => {
    expect(
      (await harness().store.createOrResumeSessionRequestStart(
        compositeInput() as never,
      )) as unknown,
    ).toEqual({
      ok: true,
      operation: operation(),
      request: linkedRequest(),
      idempotencyArgumentsSha256: "b".repeat(64),
    });

    const withoutOptionalDigest = compositeInput();
    delete (withoutOptionalDigest.start as { idempotencyArgumentsSha256?: string })
      .idempotencyArgumentsSha256;
    expect(
      await harness().store.createOrResumeSessionRequestStart(withoutOptionalDigest as never),
    ).toMatchObject({ ok: true, idempotencyArgumentsSha256: "a".repeat(64) });

    const replay = harness({
      startResult: { ok: true, operation: operation(replayOperationId) },
      request: linkedRequest(replayOperationId),
    });
    expect(
      await replay.store.createOrResumeSessionRequestStart(compositeInput() as never),
    ).toMatchObject({
      ok: true,
      operation: operation(replayOperationId),
      request: linkedRequest(replayOperationId),
    });
    expect(
      await harness({
        startResult: { ok: true, operation: operation(replayOperationId) },
      }).store.createOrResumeSessionRequestStart(compositeInput() as never),
    ).toEqual({ ok: false, code: "state_conflict" });
  });
});

describe("SQLite store facade routing coverage", () => {
  test("routes inspect and mutate methods to their dedicated repositories", async () => {
    const accessCalls: string[] = [];
    const repositoryCalls: string[] = [];
    const store = Object.create(LinuxBunSqliteStore.prototype) as LinuxBunSqliteStore;
    const repository = (name: string) =>
      new Proxy(
        {},
        {
          get: (_target, method: string) => (input?: unknown) => {
            repositoryCalls.push(`${name}.${method}:${input === argument}`);
            return `${name}.${method}`;
          },
        },
      );
    Object.assign(store as object, {
      isClosed: false,
      access: {
        inspect: (callback: () => unknown) => {
          accessCalls.push("inspect");
          return callback();
        },
        mutate: (callback: () => unknown) => {
          accessCalls.push("mutate");
          return callback();
        },
        close: () => accessCalls.push("close"),
      },
      advisoryLockRepository: repository("locks"),
      deliveryRepository: repository("delivery"),
      deliveryQueryRepository: repository("deliveryQuery"),
      requestRepository: repository("request"),
      requestDeliveryRepository: repository("requestDelivery"),
      requestDeletionRepository: repository("requestDeletion"),
      requestQueryRepository: repository("requestQuery"),
      requestParticipantQueryRepository: repository("participantQuery"),
      requestRetentionRepository: repository("requestRetention"),
      requestTerminalRepository: repository("requestTerminal"),
      requestResultRetentionRepository: repository("resultRetention"),
      requestStopRepository: repository("requestStop"),
      maintenanceRepository: repository("maintenance"),
    });
    const argument = { marker: true };
    const routes: Array<["inspect" | "mutate", string, string]> = [
      ["mutate", "publish", "locks.publish"],
      ["inspect", "list", "locks.list"],
      ["mutate", "renew", "locks.renew"],
      ["mutate", "release", "locks.release"],
      ["mutate", "cleanupExpired", "locks.cleanupExpired"],
      ["inspect", "readNextExpiry", "locks.readNextExpiry"],
      ["inspect", "reconcilePreparedCreation", "request.reconcilePreparedCreation"],
      ["inspect", "getRequestMetadata", "request.getRequestMetadata"],
      ["mutate", "cancelPrepared", "delivery.cancelPrepared"],
      ["inspect", "reconcilePreparedClaim", "request.reconcilePreparedClaim"],
      ["mutate", "completeDelivery", "requestDelivery.completeDelivery"],
      ["mutate", "expireDueRequests", "request.expireDueRequests"],
      ["inspect", "readNextPendingDeadline", "requestQuery.readNextPendingDeadline"],
      ["inspect", "listRecoverableRequests", "requestQuery.listRecoverable"],
      ["inspect", "listForParticipant", "participantQuery.list"],
      ["inspect", "getParticipantRequest", "participantQuery.get"],
      ["mutate", "collectRequestRetention", "requestRetention.collect"],
      ["mutate", "answerAsk", "requestTerminal.answerAsk"],
      ["mutate", "signalWait", "requestTerminal.signalWait"],
      ["mutate", "cancelPending", "requestTerminal.cancelPending"],
      ["mutate", "acknowledgeResult", "requestTerminal.acknowledgeResult"],
      ["mutate", "expireAvailableResults", "resultRetention.expireAvailable"],
      ["mutate", "stopPendingRequests", "requestStop.stopPendingRequests"],
      ["mutate", "deleteParticipantRequests", "requestDeletion.deleteParticipantRequests"],
      ["mutate", "deleteAbsentParticipantRequests", "requestDeletion.deleteAbsent"],
      [
        "inspect",
        "listParticipantDeletionCandidates",
        "requestDeletion.listParticipantDeletionCandidates",
      ],
      ["mutate", "completeSubmission", "delivery.completeSubmission"],
      ["inspect", "listRecoverable", "deliveryQuery.listRecoverable"],
      ["inspect", "getForParticipant", "deliveryQuery.getForParticipant"],
      ["mutate", "garbageCollectMetadata", "maintenance.garbageCollectDeliveryMetadata"],
    ];
    for (const [access, method, expected] of routes) {
      const route = (store as unknown as Record<string, (input: unknown) => unknown>)[method];
      expect(await route?.call(store, argument)).toBe(expected);
      expect(accessCalls.at(-1)).toBe(access);
    }
    expect((await store.readStorageDiagnostics()) as unknown).toBe(
      "maintenance.readStorageDiagnostics",
    );
    expect(accessCalls.at(-1)).toBe("mutate");
    expect(
      repositoryCalls.every(
        (call) => call.endsWith(":true") || call === "maintenance.readStorageDiagnostics:false",
      ),
    ).toBeTrue();
  });

  test("routes overloads by discriminator and fails closed after close", async () => {
    const fixture = harness();
    Object.assign(fixture.store as object, {
      deliveryRepository: {
        createPrepared: () => "delivery-create",
        claimPrepared: () => "delivery-claim",
      },
      requestRepository: {
        createPrepared: () => "request-create",
        claimPrepared: () => "request-claim",
      },
    });
    expect((await fixture.store.createPrepared({ delivery: true } as never)) as unknown).toBe(
      "delivery-create",
    );
    expect((await fixture.store.createPrepared({ request: true } as never)) as unknown).toBe(
      "request-create",
    );
    expect(
      (await fixture.store.claimPrepared({ deliveryId: "delivery" } as never)) as unknown,
    ).toBe("delivery-claim");
    expect((await fixture.store.claimPrepared({ requestId: "request" } as never)) as unknown).toBe(
      "request-claim",
    );

    fixture.store.close();
    fixture.store.close();
    expect(fixture.accessCalls.filter((call) => call === "close")).toHaveLength(1);
    await expect(fixture.store.cleanupExpired({} as never)).rejects.toThrow("store is closed");
  });
});
