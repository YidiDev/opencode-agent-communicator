import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  assertStaleDeliveryClassification,
  isLegalDeliveryCompletion,
  writeDeliveryCompletion,
} from "../../../../src/adapters/store/delivery-completion";
import { errorCode, safelyClose } from "../../../../src/adapters/store/linux-path-operations";
import { preparePrivateStatePath } from "../../../../src/adapters/store/linux-private-path";
import { RequestDeletionRepository } from "../../../../src/adapters/store/request-deletion-repository";
import {
  getSourceTerminalParticipant,
  projectParticipant,
} from "../../../../src/adapters/store/request-participant-projection";
import { authorizeParticipant } from "../../../../src/adapters/store/request-participant-storage";
import { RequestRepository } from "../../../../src/adapters/store/request-repository";
import type { RequestRow } from "../../../../src/adapters/store/request-rows";
import { RequestSourceTerminalRepository } from "../../../../src/adapters/store/request-source-terminal-repository";
import { StartOperationProvenance } from "../../../../src/adapters/store/start-operation-provenance";
import { StartOperationResolutionRepository } from "../../../../src/adapters/store/start-operation-resolution-repository";
import {
  StoreIntegrityError,
  StoreSecurityError,
} from "../../../../src/adapters/store/store-types";
import { availableResultsPerWorkspaceHardCeiling } from "../../../../src/domain/safety-ceilings";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid coverage fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("store-refactor-coverage"));
const sourceSessionId = valid(validateSessionId("ses_refactorsource"));
const targetSessionId = valid(validateSessionId("ses_refactortarget"));
const requestId = `req_${"1".repeat(32)}`;
const operationId = `op_${"2".repeat(32)}`;

function requestRow(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: requestId,
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    nativeMessageId: `msg_${"3".repeat(32)}`,
    kind: "wait",
    resolutionState: "pending",
    deliveryState: "prepared",
    resultState: "none",
    payloadByteLength: 1,
    payloadSha256: "a".repeat(64),
    createdAtMs: 1,
    updatedAtMs: 1,
    deadlineAtMs: 100,
    submittedAtMs: null,
    deliveryUnknownAtMs: null,
    admittedAtMs: null,
    promotedAtMs: null,
    deliveryFailedAtMs: null,
    admittedSeq: null,
    promotedSeq: null,
    evidenceObservedAtMs: null,
    resolvedAtMs: null,
    resultByteLength: null,
    resultSha256: null,
    resultAvailableAtMs: null,
    resultExpiresAtMs: null,
    resultExpiredAtMs: null,
    acknowledgedAtMs: null,
    ...overrides,
  };
}

describe("store refactor delivery and Linux path coverage", () => {
  test("rejects non-recovery and non-stale delivery completions", () => {
    const context = {
      database: {
        query: () => ({ get: () => ({ claimedToken: 7 }) }),
      },
    } as never;
    expect(() => assertStaleDeliveryClassification(context, { state: "failed" } as never)).toThrow(
      "only stale submission classification",
    );
    expect(() =>
      assertStaleDeliveryClassification(context, {
        state: "admission_unknown",
        workspaceKey,
        deliveryId: `dlv_${"4".repeat(32)}`,
        fencingToken: 7,
      } as never),
    ).toThrow("Only a stale-token submission");
    expect(isLegalDeliveryCompletion("admission_unknown", "failed")).toBeTrue();
  });

  test("detects failed admitted and promoted completion compare-and-swaps", () => {
    const context = { database: { run: () => ({ changes: 0 }) } } as never;
    expect(() =>
      writeDeliveryCompletion(
        context,
        { state: "admitted", nowMs: 2, evidenceObservedAtMs: 1 } as never,
        "submitting",
        2,
      ),
    ).toThrow(StoreIntegrityError);
    expect(() =>
      writeDeliveryCompletion(
        context,
        { state: "promoted", nowMs: 2, evidenceObservedAtMs: 1 } as never,
        "admitted",
        2,
      ),
    ).toThrow(StoreIntegrityError);
  });

  test("handles code-like non-errors and best-effort close failures", () => {
    expect(errorCode({ code: "ENOENT" })).toBeUndefined();
    expect(() => safelyClose({ close: () => void 0 } as never, 1)).not.toThrow();
    expect(() =>
      safelyClose(
        {
          close: () => {
            throw new Error("close failed");
          },
        } as never,
        1,
      ),
    ).not.toThrow();
  });

  test("rejects a non-directory root and an unowned traversal root", () => {
    const syscalls = (isDirectory: boolean, uid: number | undefined) =>
      ({
        open: () => 1,
        close: () => undefined,
        mkdir: () => undefined,
        fstat: () => ({ isDirectory, isFile: false, uid: 1, mode: 0o755 }),
        fchmod: () => undefined,
        statfsType: () => 0n,
        uid: () => uid,
      }) as never;
    expect(() =>
      preparePrivateStatePath("/store-refactor-path", "db.sqlite3", {
        syscalls: syscalls(false, 1),
      }),
    ).toThrow(StoreSecurityError);
    expect(() =>
      preparePrivateStatePath("/store-refactor-path", "db.sqlite3", {
        syscalls: syscalls(true, undefined),
      }),
    ).toThrow("unsafe canonical ancestor");
  });

  test("handles a component creation race reported as already existing", () => {
    let childOpenAttempts = 0;
    const syscalls = {
      open: (path: string) => {
        if (path === "/") return 1;
        childOpenAttempts += 1;
        if (childOpenAttempts === 1) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        throw new Error("raced component cannot be reopened");
      },
      close: () => undefined,
      mkdir: () => {
        throw Object.assign(new Error("raced creation"), { code: "EEXIST" });
      },
      fstat: () => ({ isDirectory: true, isFile: false, uid: 1, mode: 0o755 }),
      fchmod: () => undefined,
      statfsType: () => 0n,
      uid: () => 1,
    } as never;
    expect(() =>
      preparePrivateStatePath("/store-refactor-race", "db.sqlite3", { syscalls }),
    ).toThrow("created state-path component could not be opened safely");
    expect(childOpenAttempts).toBe(2);
  });
});

describe("store refactor request projection and repository coverage", () => {
  test("rejects unsupported projections, missing result rows, and invalid authorization roles", () => {
    expect(() => projectParticipant({ resolutionState: "corrupt" } as never, "source")).toThrow(
      "Unsupported request state",
    );

    const resultContext = {
      database: {
        query: (sql: string) => ({
          get: () => (sql.includes("request_payloads") ? { count: 0 } : undefined),
        }),
      },
    } as never;
    expect(() =>
      getSourceTerminalParticipant(resultContext, {
        ...requestRow({
          resolutionState: "reached",
          resultState: "available",
          payloadSha256: null,
          resolvedAtMs: 2,
          updatedAtMs: 2,
          resultByteLength: 1,
          resultSha256: "b".repeat(64),
          resultAvailableAtMs: 2,
          resultExpiresAtMs: 3,
        }),
        id: requestId,
      } as never),
    ).toThrow("Stored request result failed strict validation");

    const authorizationContext = {
      database: { query: () => ({ get: () => ({ participantRole: "observer" }) }) },
    } as never;
    expect(() =>
      authorizeParticipant(authorizationContext, workspaceKey, requestId, sourceSessionId),
    ).toThrow("authorization was invalid");
  });

  test("rejects a valid stored result paired with the wrong terminal resolution", () => {
    const resultJson = '{"kind":"wait"}';
    const resultSha256 = createHash("sha256").update(resultJson).digest("hex");
    const context = {
      database: {
        query: (sql: string) => ({
          get: () => (sql.includes("request_payloads") ? { count: 0 } : { resultJson }),
        }),
      },
    } as never;
    expect(() =>
      getSourceTerminalParticipant(context, {
        id: requestId,
        workspaceKey,
        sourceSessionId,
        targetSessionId,
        nativeMessageId: `msg_${"3".repeat(32)}`,
        kind: "wait",
        resolutionState: "answered",
        deliveryState: "prepared",
        resultState: "available",
        payloadByteLength: 1,
        createdAtMs: 1,
        updatedAtMs: 2,
        deadlineAtMs: 100,
        resolvedAtMs: 2,
        resultByteLength: resultJson.length,
        resultSha256,
        resultAvailableAtMs: 2,
        resultExpiresAtMs: 3,
      } as never),
    ).toThrow("result correlation was invalid");
  });

  test("fails closed when deleted-source result metadata exceeds its hard bound", () => {
    const repository = new RequestDeletionRepository({} as never, {} as never) as unknown as {
      eraseAvailableSourceResults(
        workspace: string,
        absentJson: string,
        absent: ReadonlySet<string>,
        nowMs: number,
      ): void;
    };
    const rows = new Array(availableResultsPerWorkspaceHardCeiling + 1).fill({});
    Object.assign(repository, {
      context: { database: { query: () => ({ all: () => rows }) } },
    });
    expect(() => repository.eraseAvailableSourceResults(workspaceKey, "[]", new Set(), 1)).toThrow(
      "result metadata exceeded its hard bound",
    );
  });

  test("covers reconciled claim mismatch and invalid private content", () => {
    const submitting = requestRow({
      deliveryState: "submitting",
      submittedAtMs: 2,
      updatedAtMs: 2,
    });
    const run = (token: unknown, envelopeJson: unknown) => {
      const context = {
        workspaceKey,
        database: {
          transaction: (operation: () => unknown) => ({ immediate: operation }),
          query: (sql: string) => ({
            get: () =>
              sql.includes("LEFT JOIN")
                ? {
                    ...submitting,
                    payloadJson: "{}",
                    envelopeJson,
                    retainedContentBytes: 2,
                    creationOperationId: operationId,
                  }
                : { token },
          }),
        },
      } as never;
      return new RequestRepository(context, {
        assertOrdinaryWorkAllowed: () => undefined,
      } as never).reconcilePreparedClaim({ workspaceKey, requestId, fencingToken: 1 } as never);
    };
    expect(run(2, "{}")).toEqual({ outcome: "absent_or_other_claim" });
    expect(() => run(1, "{}")).toThrow("invalid private content");
  });
});

describe("store refactor request expiry and terminal coverage", () => {
  test("detects missing expiry reads and failed expiry compare-and-swaps", () => {
    const pending = requestRow();
    const missingAfter = new RequestRepository(
      {
        workspaceKey,
        database: {
          run: () => ({ changes: 1 }),
          query: (sql: string) => ({
            get: () => (sql.includes("request_payloads") ? { count: 0 } : undefined),
          }),
        },
      } as never,
      {} as never,
    );
    expect(() =>
      (
        missingAfter as unknown as {
          expireRowsOwned(workspace: string, nowMs: number, rows: RequestRow[]): unknown;
        }
      ).expireRowsOwned(workspaceKey, 100, [pending]),
    ).toThrow("expired request was absent");

    const failedCas = new RequestRepository(
      {
        workspaceKey,
        database: {
          run: (sql: string) => ({ changes: sql.startsWith("UPDATE requests") ? 0 : 1 }),
          query: (sql: string) => ({
            get: () =>
              sql.includes("request_payloads")
                ? { count: 0 }
                : sql.includes("FROM requests")
                  ? pending
                  : undefined,
          }),
        },
      } as never,
      {} as never,
    );
    expect(() => failedCas.expireExactDueOwned(workspaceKey, requestId, 100)).toThrow(
      "request expiry CAS failed",
    );
  });

  test("classifies expiry transaction faults through the public boundary", () => {
    const repository = new RequestRepository(
      {
        workspaceKey,
        maximumPageCount: 1,
        database: {
          query: () => ({ get: () => undefined }),
          transaction: () => {
            throw new Error("transaction failed");
          },
        },
      } as never,
      {} as never,
    );
    expect(
      repository.expireDueRequests({ fencingToken: 1 as never, workspaceKey, limit: 1 }),
    ).toEqual({ ok: false, code: "storage_unavailable" });
  });

  test("covers source acknowledgement time regression and deadline postconditions", () => {
    const available = requestRow({
      resolutionState: "reached",
      resultState: "available",
      payloadSha256: null,
      resolvedAtMs: 2,
      updatedAtMs: 10,
      resultByteLength: 1,
      resultSha256: "b".repeat(64),
      resultAvailableAtMs: 2,
      resultExpiresAtMs: 20,
    });
    const acknowledgement = new RequestSourceTerminalRepository(
      {
        workspaceKey,
        maximumPageCount: 1,
        nowWallMs: () => 5,
        database: {
          transaction: (operation: () => unknown) => ({ immediate: operation }),
          query: (sql: string) => ({
            get: () => (sql.includes("LEFT JOIN") ? available : undefined),
          }),
        },
      } as never,
      { assertOrdinaryWorkAllowed: () => undefined } as never,
    );
    expect(
      acknowledgement.acknowledgeResult({
        fencingToken: 1 as never,
        workspaceKey,
        requestId,
        callerSessionId: sourceSessionId,
      } as never),
    ).toEqual({ ok: false, code: "state_conflict" });

    const invokeExpiry = (updateChanges: number, selected: unknown) => {
      const repository = new RequestSourceTerminalRepository(
        {
          database: {
            run: (sql: string) => ({
              changes: sql.startsWith("UPDATE requests") ? updateChanges : 1,
            }),
            query: (sql: string) => ({
              get: () => (sql.includes("request_payloads") ? { count: 0 } : selected),
            }),
          },
        } as never,
        {} as never,
      ) as unknown as {
        expirePending(request: unknown, nowMs: number): unknown;
      };
      return () => repository.expirePending({ ...requestRow(), id: requestId }, 100);
    };
    expect(invokeExpiry(0, undefined)).toThrow("request deadline CAS failed");
    expect(invokeExpiry(1, undefined)).toThrow("deadline-expired request was absent");
  });

  test("rejects acknowledgement when a terminal request has no result", () => {
    const terminal = requestRow({
      resolutionState: "cancelled",
      payloadSha256: null,
      resolvedAtMs: 2,
      updatedAtMs: 2,
    });
    const repository = new RequestSourceTerminalRepository(
      {
        workspaceKey,
        maximumPageCount: 1,
        database: {
          transaction: (operation: () => unknown) => ({ immediate: operation }),
          query: (sql: string) => ({
            get: () =>
              sql.includes("LEFT JOIN")
                ? terminal
                : sql.includes("request_payloads")
                  ? { count: 0 }
                  : undefined,
          }),
        },
      } as never,
      { assertOrdinaryWorkAllowed: () => undefined } as never,
    );
    expect(
      repository.acknowledgeResult({
        fencingToken: 1,
        workspaceKey,
        requestId,
        callerSessionId: sourceSessionId,
      } as never),
    ).toEqual({ ok: false, code: "state_conflict" });
  });
});

describe("store refactor start-operation coverage", () => {
  const input = { workspaceKey, operationId, fencingToken: 1, nowMs: 5 };

  test("requires reservations and created operation records for provenance changes", () => {
    const absentReservation = new StartOperationProvenance(
      { database: { run: () => ({ changes: 0 }) } } as never,
      {} as never,
    );
    expect(() => absentReservation.markUnresolved(input as never)).toThrow("reservation is absent");

    const absentOperation = new StartOperationProvenance(
      {} as never,
      {
        select: () => undefined,
      } as never,
    );
    expect(() => absentOperation.confirm(input as never)).toThrow(
      "Created start operation is absent",
    );
  });

  test("classifies missing reconciliation output and transaction failures", async () => {
    let selects = 0;
    const reconciliation = new StartOperationResolutionRepository(
      {
        workspaceKey,
        database: {
          run: () => ({ changes: 1 }),
          transaction: (operation: () => unknown) => ({ immediate: operation }),
        },
      } as never,
      { assertCurrent: () => undefined } as never,
      {
        select: () => (selects++ === 0 ? { creationState: "outcome_unknown" } : undefined),
        payload: () => undefined,
      } as never,
    );
    expect(
      await reconciliation.reconcileUnknownCreation({ ...input, outcome: "absent" } as never),
    ).toEqual({
      ok: false,
      code: "storage_unavailable",
    });

    const transactionFailure = new StartOperationResolutionRepository(
      {
        workspaceKey,
        database: {
          transaction: () => {
            throw new Error("transaction failed");
          },
        },
      } as never,
      {} as never,
      {} as never,
    );
    expect(await transactionFailure.releasePreparedReservation(input as never)).toEqual({
      ok: false,
      code: "storage_unavailable",
    });
  });

  test("handles rejected-start compare-and-swap and post-read failures", async () => {
    const reject = async (changes: number, reread: unknown) => {
      let selects = 0;
      const repository = new StartOperationResolutionRepository(
        {
          workspaceKey,
          database: {
            run: (sql: string) => ({
              changes: sql.startsWith("UPDATE start_operations") ? changes : 1,
            }),
            transaction: (operation: () => unknown) => ({ immediate: operation }),
          },
        } as never,
        { assertCurrent: () => undefined } as never,
        {
          select: () => (selects++ === 0 ? { creationState: "prepared" } : reread),
        } as never,
      );
      return repository.rejectPreparedStart({ ...input, state: "policy_denied" } as never);
    };
    expect(await reject(0, undefined)).toEqual({ ok: false, code: "state_conflict" });
    expect(await reject(1, undefined)).toEqual({ ok: false, code: "storage_unavailable" });
  });
});
