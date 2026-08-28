import { describe, expect, test } from "bun:test";

import type { SessionStartPorts } from "../../../src/application/session-start-application";
import type { PrepareStartOperationInput } from "../../../src/application/session-start-ports";
import { startSession } from "../../../src/application/start-session";
import { approvePreparedStart } from "../../../src/application/start-session-approval";
import {
  validateManagedSessionId,
  validateNativeMessageId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";
import { OwnershipLostFault, validateFencingToken } from "../../../src/domain/ownership";
import type { StartOperation, ValidatedStartArguments } from "../../../src/domain/session-start";
import { createSessionStartPolicy } from "../../../src/domain/session-start-policy";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = value(validateWorkspaceKey("workspace:start-failures"));
const sourceSessionId = value(validateSessionId("ses_source"));
const token = value(validateFencingToken(2));
const operationId = value(validateStartOperationId(`op_${"1".repeat(32)}`));
const sessionId = value(validateManagedSessionId(`ses_${"2".repeat(32)}`));
const messageId = value(validateNativeMessageId(`msg_${"3".repeat(32)}`));
const arguments_: ValidatedStartArguments = {
  idempotencyKey: "start:failures",
  initialMessage: "work",
};
const operation: StartOperation = {
  id: operationId,
  workspaceKey,
  sourceSessionId,
  idempotencyKey: arguments_.idempotencyKey,
  argumentsSha256: "0".repeat(64) as StartOperation["argumentsSha256"],
  sessionId,
  nativeMessageId: messageId,
  creationState: "prepared",
  titleState: "not_started",
  admissionState: "not_started",
  createdAtMs: 1,
  updatedAtMs: 1,
};

function fixture(): SessionStartPorts {
  return {
    readiness: { fencingToken: token, assertReady() {} },
    membership: {
      async readCurrentRoots() {
        return { sourceVisible: true, targetVisible: true, sourceTitle: "source" };
      },
    },
    approval: { requestStartApproval: async () => "approved" },
    starts: {
      isManagedSession: async () => false,
      createOrResume: async (input: PrepareStartOperationInput) => ({
        ok: true,
        operation: { ...operation, argumentsSha256: input.argumentsSha256 },
      }),
    } as never,
    nativeStart: {
      reconcileRootSession: async () => "unknown",
      createRootSession: async () => "created",
      updateSessionTitle: async () => "updated",
      admitInitialMessage: async () => "admitted",
    },
    ownership: { acquire: async () => token, isCurrent: async () => true },
    clock: { nowMs: () => 1 },
    ids: {
      deliveryId: () => {
        throw new Error("unused");
      },
      requestId: () => {
        throw new Error("unused");
      },
      startOperationId: () => operationId,
      managedSessionId: () => sessionId,
      nativeMessageId: () => messageId,
    },
    digest: { sha256: async () => new Uint8Array(32) },
    policy: createSessionStartPolicy(),
  };
}

const context = () => ({
  workspaceKey,
  sourceSessionId,
  abort: new AbortController().signal,
  deadlineMs: 100,
});
const args = { idempotency_key: "start:failures", initial_message: "work" };

describe("session-start failure boundaries", () => {
  test("denies model overrides and managed-session recursion before durable creation", async () => {
    const model = fixture();
    expect(
      await startSession(model, context(), { ...args, model: "provider/model" }),
    ).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });

    const recursive = fixture();
    recursive.starts.isManagedSession = async () => true;
    expect(await startSession(recursive, context(), args)).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
  });

  test("maps visibility, ownership, and persistence failures without native effects", async () => {
    const hidden = fixture();
    hidden.membership.readCurrentRoots = async () => ({
      sourceVisible: false,
      targetVisible: false,
      sourceTitle: "source",
    });
    expect(await startSession(hidden, context(), args)).toMatchObject({
      ok: false,
      error: { code: "caller_not_visible" },
    });
    hidden.membership.readCurrentRoots = async () => {
      throw new Error("native down");
    };
    expect(await startSession(hidden, context(), args)).toMatchObject({
      ok: false,
      error: { code: "native_unavailable" },
    });

    const missingLifecycleEpoch = fixture();
    expect(
      await startSession(
        { ...missingLifecycleEpoch, readiness: { assertReady() {} } },
        context(),
        args,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });

    const recursionRead = fixture();
    recursionRead.starts.isManagedSession = async () => {
      throw new OwnershipLostFault("lease");
    };
    expect(await startSession(recursionRead, context(), args)).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });

    const persist = fixture();
    persist.starts.createOrResume = async () => {
      throw new Error("disk");
    };
    expect(await startSession(persist, context(), args)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
  });

  test("rejects malformed generated IDs, unrelated records, and pre-aborted work", async () => {
    const malformed = fixture();
    malformed.ids.startOperationId = () => "bad" as never;
    await expect(startSession(malformed, context(), args)).rejects.toThrow("identifiers");

    const unrelated = fixture();
    unrelated.starts.createOrResume = async (input) => ({
      ok: true,
      operation: {
        ...operation,
        argumentsSha256: input.argumentsSha256,
        sourceSessionId: sessionId,
      },
    });
    await expect(startSession(unrelated, context(), args)).rejects.toThrow("unrelated");

    const aborted = new AbortController();
    aborted.abort();
    expect(
      await startSession(fixture(), { ...context(), abort: aborted.signal }, args),
    ).toMatchObject({
      ok: false,
      error: { code: "deadline_expired" },
    });
  });

  test("terminalizes denied or rejected starts and preserves transition failures", async () => {
    for (const [decision, approval, expected] of [
      ["deny", "approved", "permission_denied"],
      ["ask", "rejected", "approval_rejected"],
    ] as const) {
      const ports = { ...fixture(), policy: createSessionStartPolicy({ decision }) };
      ports.approval.requestStartApproval = async () => approval;
      ports.starts.rejectPreparedStart = async (input) => ({
        ok: true,
        operation: { ...operation, creationState: input.state },
      });
      expect(
        await approvePreparedStart(ports, context(), token, {
          operation,
          argumentsSha256: operation.argumentsSha256,
        }),
      ).toMatchObject({ ok: false, error: { code: expected } });
    }

    const invalid = fixture();
    invalid.approval.requestStartApproval = async () => "future" as never;
    await expect(
      approvePreparedStart(invalid, context(), token, {
        operation,
        argumentsSha256: operation.argumentsSha256,
      }),
    ).rejects.toThrow("unknown outcome");

    for (const cause of [new OwnershipLostFault("lease"), new Error("disk")]) {
      const ports = fixture();
      ports.approval.requestStartApproval = async () => "rejected";
      ports.starts.rejectPreparedStart = async () => {
        throw cause;
      };
      expect(
        await approvePreparedStart(ports, context(), token, {
          operation,
          argumentsSha256: operation.argumentsSha256,
        }),
      ).toMatchObject({
        ok: false,
        error: {
          code: cause instanceof OwnershipLostFault ? "ownership_lost" : "storage_unavailable",
        },
      });
    }
  });
});
