import { describe, expect, test } from "bun:test";

import { encodeRequestListCursor } from "../../../src/application/request-list-cursor";
import {
  validateManagedSessionId,
  validateNativeMessageId,
  validateRequestId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";
import type { FencingToken } from "../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { ToolContractFault } from "../../../src/tools/contracts";
import {
  requestToolFailureCodes,
  sessionAskArgumentsSchema,
  sessionBlockingRequestFailureCodes,
  sessionRequestAckArgumentsSchema,
  sessionRequestAckFailureCodes,
  sessionRequestCancelArgumentsSchema,
  sessionRequestCancelFailureCodes,
  sessionRequestGetArgumentsSchema,
  sessionRequestGetFailureCodes,
  sessionRequestListArgumentsSchema,
  sessionRequestListFailureCodes,
  sessionRequestSendArgumentsSchema,
  sessionRespondArgumentsSchema,
  sessionRespondFailureCodes,
  sessionSignalArgumentsSchema,
  sessionSignalFailureCodes,
  sessionWaitArgumentsSchema,
} from "../../../src/tools/request-contracts";
import { requestToolContext, requestToolIdentity } from "../../../src/tools/request-tool-context";
import { createSessionRequestSendTool } from "../../../src/tools/session-request-send";
import { serializeSessionRequestStartResult } from "../../../src/tools/session-request-start";

function workspace() {
  const value = validateWorkspaceKey("request-tools");
  if (!value.ok) throw new Error("invalid fixture");
  return value.value;
}

const requestId = `req_${"a".repeat(32)}`;
const context = { sessionID: "ses_source", abort: new AbortController().signal };

describe("request tool argument contracts", () => {
  test("describes request-send as active-only without idle wake-up", () => {
    const tool = createSessionRequestSendTool(
      {} as never,
      {
        workspaceKey: workspace(),
        fencingToken: 1 as FencingToken,
        invocationDeadlineMs: () => 1,
      },
      { message: "allow", ask: "allow", wait: "allow" },
    );
    expect(tool.description).toContain("visible active root");
    expect(tool.description).toContain("never wakes an idle target");
  });

  test("accepts canonical strict request arguments", () => {
    expect(
      sessionRequestSendArgumentsSchema.safeParse({
        session_id: "ses_target",
        content: "Review the patch.",
        request: { kind: "wait", milestone: "reviewed", timeout_seconds: 30 },
      }).success,
    ).toBe(true);
    expect(
      sessionAskArgumentsSchema.safeParse({
        session_id: "ses_target",
        questions: [
          {
            prompt: "Choose",
            options: ["one", "two"],
            multiple: true,
            allow_custom: false,
          },
        ],
        timeout_seconds: 30,
      }).success,
    ).toBe(true);
    expect(
      sessionRespondArgumentsSchema.safeParse({ request_id: requestId, answers: [["one"]] })
        .success,
    ).toBe(true);
    expect(sessionRespondArgumentsSchema.shape.answers.description).toContain('[["pass"]]');
    expect(
      sessionWaitArgumentsSchema.safeParse({
        session_id: "ses_target",
        milestone: "compiled",
        timeout_seconds: 1,
      }).success,
    ).toBe(true);
    expect(
      sessionSignalArgumentsSchema.safeParse({ request_id: requestId, evidence: "artifact" })
        .success,
    ).toBe(true);
    expect(sessionRequestListArgumentsSchema.safeParse({ role: "all", limit: 100 }).success).toBe(
      true,
    );
    for (const schema of [
      sessionRequestGetArgumentsSchema,
      sessionRequestAckArgumentsSchema,
      sessionRequestCancelArgumentsSchema,
    ]) {
      expect(schema.safeParse({ request_id: requestId }).success).toBe(true);
    }
  });

  test("rejects unknown keys, unsafe text, malformed IDs, and exceeded bounds", () => {
    const ask = {
      session_id: "ses_target",
      questions: [{ prompt: "Choose", options: ["one"], allow_custom: false }],
      timeout_seconds: 30,
    };
    expect(sessionAskArgumentsSchema.safeParse({ ...ask, extra: true }).success).toBe(false);
    expect(
      sessionAskArgumentsSchema.safeParse({
        ...ask,
        questions: [{ prompt: "unsafe\u0000", options: ["one"], allow_custom: false }],
      }).success,
    ).toBe(false);
    expect(
      sessionAskArgumentsSchema.safeParse({
        ...ask,
        questions: [{ prompt: "Choose", options: [], allow_custom: false }],
      }).success,
    ).toBe(false);
    expect(sessionAskArgumentsSchema.safeParse({ ...ask, timeout_seconds: 3601 }).success).toBe(
      false,
    );
    expect(
      sessionRespondArgumentsSchema.safeParse({ request_id: "bad", answers: [[]] }).success,
    ).toBe(false);
    expect(
      sessionRespondArgumentsSchema.safeParse({ request_id: requestId, answers: ["pass"] }).success,
    ).toBe(false);
    expect(
      sessionRespondArgumentsSchema.safeParse({
        request_id: requestId,
        answers: [["duplicate", "duplicate"]],
      }).success,
    ).toBe(false);
    expect(
      sessionWaitArgumentsSchema.safeParse({
        session_id: "ses_target",
        milestone: "",
        timeout_seconds: 1,
      }).success,
    ).toBe(false);
    expect(
      sessionSignalArgumentsSchema.safeParse({ request_id: requestId, evidence: "x".repeat(4097) })
        .success,
    ).toBe(false);
    expect(sessionRequestListArgumentsSchema.safeParse({ role: "foreign" }).success).toBe(false);
    expect(sessionRequestListArgumentsSchema.safeParse({ cursor: 1 }).success).toBe(false);
    expect(sessionRequestListArgumentsSchema.safeParse({ cursor: "bad" }).success).toBe(false);
    expect(sessionRequestListArgumentsSchema.safeParse({ limit: 101 }).success).toBe(false);
    const validatedRequestId = validateRequestId(requestId);
    if (!validatedRequestId.ok) throw new Error("invalid fixture");
    const cursor = encodeRequestListCursor("inbox", {
      createdAtMs: 1,
      requestId: validatedRequestId.value,
    });
    expect(sessionRequestListArgumentsSchema.safeParse({ role: "inbox", cursor }).success).toBe(
      true,
    );
    expect(sessionRequestListArgumentsSchema.safeParse({ role: "outbox", cursor }).success).toBe(
      false,
    );
  });
});

describe("request tool failure contracts", () => {
  test("declares exact blocking and query failure surfaces", () => {
    expect(Object.keys(requestToolFailureCodes)).toEqual([
      "session_ask",
      "session_request_send",
      "session_respond",
      "session_wait",
      "session_signal",
      "session_request_list",
      "session_request_get",
      "session_request_ack",
      "session_request_cancel",
    ]);
    expect(sessionBlockingRequestFailureCodes).toEqual([
      "invalid_arguments",
      "caller_not_visible",
      "target_not_visible",
      "permission_denied",
      "approval_rejected",
      "target_idle",
      "target_status_unknown",
      "target_stopped",
      "source_stopped",
      "target_deleted",
      "source_deleted",
      "quota_exceeded",
      "rate_limited",
      "request_cancelled",
      "deadline_expired",
      "deadlock_detected",
      "result_expired",
      "native_unavailable",
      "delivery_failed",
      "ownership_lost",
      "storage_unavailable",
    ]);
    expect(sessionRequestListFailureCodes).toEqual([
      "invalid_arguments",
      "caller_not_visible",
      "deadline_expired",
      "native_unavailable",
      "ownership_lost",
      "storage_unavailable",
    ]);
    expect(sessionRequestGetFailureCodes).toEqual([
      "invalid_arguments",
      "not_found_or_unauthorized",
      "caller_not_visible",
      "deadline_expired",
      "result_expired",
      "native_unavailable",
      "ownership_lost",
      "storage_unavailable",
    ]);
    expect(sessionRequestAckFailureCodes).toEqual([
      "invalid_arguments",
      "not_found_or_unauthorized",
      "caller_not_visible",
      "deadline_expired",
      "quota_exceeded",
      "rate_limited",
      "state_conflict",
      "native_unavailable",
      "ownership_lost",
      "storage_unavailable",
    ]);
    expect(sessionRequestCancelFailureCodes).toEqual([
      "invalid_arguments",
      "not_found_or_unauthorized",
      "caller_not_visible",
      "quota_exceeded",
      "rate_limited",
      "state_conflict",
      "request_not_pending",
      "deadline_expired",
      "delivery_failed",
      "target_stopped",
      "source_stopped",
      "target_deleted",
      "source_deleted",
      "native_unavailable",
      "ownership_lost",
      "storage_unavailable",
    ]);
    expect(sessionRespondFailureCodes).toEqual([
      "invalid_arguments",
      "not_found_or_unauthorized",
      "caller_not_visible",
      "quota_exceeded",
      "rate_limited",
      "state_conflict",
      "request_not_pending",
      "request_cancelled",
      "deadline_expired",
      "delivery_failed",
      "target_stopped",
      "source_stopped",
      "target_deleted",
      "source_deleted",
      "native_unavailable",
      "ownership_lost",
      "storage_unavailable",
    ]);
    expect(sessionSignalFailureCodes).toEqual(sessionRespondFailureCodes);
  });
});

describe("request-start result contracts", () => {
  test("request-start rejects undeclared codes and malformed composite failure details", () => {
    const expected = {
      workspaceKey: workspace(),
      sourceSessionId: "ses_source",
      idempotencyKey: "request-start",
    };
    expect(() =>
      serializeSessionRequestStartResult(
        {
          ok: false,
          error: { code: "not_found_or_unauthorized", message: "undeclared", retryable: false },
        } as never,
        expected,
      ),
    ).toThrow(ToolContractFault);
    for (const details of [
      { operation: {}, request: {} },
      { operation: {}, request: {}, extra: true },
      { operation: {} },
    ]) {
      expect(() =>
        serializeSessionRequestStartResult(
          {
            ok: false,
            error: {
              code: "native_outcome_unknown",
              message: "malformed",
              retryable: false,
              details,
            },
          } as never,
          expected,
        ),
      ).toThrow(ToolContractFault);
    }
  });

  test("request-start rejects forged successful composite bindings and shapes", () => {
    const operationId = validateStartOperationId(`op_${"1".repeat(32)}`);
    const managedSessionId = validateManagedSessionId(`ses_${"2".repeat(32)}`);
    const nativeMessageId = validateNativeMessageId(`msg_${"3".repeat(32)}`);
    const linkedRequestId = validateRequestId(`req_${"1".repeat(32)}`);
    if (!operationId.ok || !managedSessionId.ok || !nativeMessageId.ok || !linkedRequestId.ok) {
      throw new Error("invalid fixture");
    }
    const expected = {
      workspaceKey: workspace(),
      sourceSessionId: "ses_source",
      idempotencyKey: "request-start",
    };
    const operation = {
      id: operationId.value,
      workspaceKey: expected.workspaceKey,
      sourceSessionId: "ses_source" as never,
      idempotencyKey: expected.idempotencyKey,
      argumentsSha256: "a".repeat(64) as never,
      sessionId: managedSessionId.value,
      nativeMessageId: nativeMessageId.value,
      creationState: "prepared" as const,
      titleState: "not_started" as const,
      admissionState: "not_started" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const request = {
      id: linkedRequestId.value,
      workspaceKey: expected.workspaceKey,
      sourceSessionId: operation.sourceSessionId,
      targetSessionId: managedSessionId.value,
      nativeMessageId: nativeMessageId.value,
      deliveryMode: "initial" as const,
      linkedStartOperationId: operationId.value,
      payloadByteLength: 1,
      payloadSha256: "b".repeat(64) as never,
      kind: "wait" as const,
      resolutionState: "pending" as const,
      deliveryState: "prepared" as const,
      resultState: "none" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
      deadlineAtMs: 2,
    };
    expect(
      JSON.parse(
        serializeSessionRequestStartResult({ ok: true, value: { operation, request } }, expected),
      ),
    ).toMatchObject({
      ok: true,
      value: { request: { target_session_id: managedSessionId.value } },
    });
    expect(
      JSON.parse(
        serializeSessionRequestStartResult(
          {
            ok: false,
            error: {
              code: "native_outcome_unknown",
              message: "The native start outcome remains unknown.",
              retryable: false,
              details: { operation, request },
            },
          },
          expected,
        ),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "native_outcome_unknown",
        details: {
          operation: { operation_id: operationId.value },
          request: { request_id: linkedRequestId.value },
        },
      },
    });
    for (const value of [
      { operation: { ...operation, workspaceKey: validWorkspace("workspace:forged") }, request },
      { operation, request: { ...request, targetSessionId: operation.sourceSessionId } },
      { operation, request: { ...request, workspaceKey: validWorkspace("workspace:forged") } },
      { operation, request: { ...request, extra: true } },
      { operation, request, extra: true },
    ]) {
      expect(() =>
        serializeSessionRequestStartResult({ ok: true, value } as never, expected),
      ).toThrow(ToolContractFault);
    }
    expect(() =>
      serializeSessionRequestStartResult(
        {
          ok: false,
          error: {
            code: "native_outcome_unknown",
            message: "partial",
            retryable: false,
            details: {
              operation,
              request: { ...request, workspaceKey: validWorkspace("workspace:forged") },
            },
          },
        } as never,
        expected,
      ),
    ).toThrow(ToolContractFault);
  });
});

function validWorkspace(value: string) {
  const validation = validateWorkspaceKey(value);
  if (!validation.ok) throw new Error("invalid fixture");
  return validation.value;
}

describe("request tool context adaptation", () => {
  test("validates read-only identity without requiring mutation deadline control", () => {
    const result = requestToolIdentity(
      {
        workspaceKey: workspace(),
        fencingToken: 1 as FencingToken,
      },
      context,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { callerSessionId: "ses_source", fencingToken: 1 },
    });
  });

  test("builds controlled application context and fails closed on deadline faults", () => {
    const base = {
      workspaceKey: workspace(),
      fencingToken: 2 as FencingToken,
      invocationDeadlineMs: () => 12_345,
    };
    expect(requestToolContext(base, context)).toMatchObject({
      ok: true,
      value: {
        sourceSessionId: "ses_source",
        callerSessionId: "ses_source",
        fencingToken: 2,
        deadlineMs: 12_345,
      },
    });
    for (const invocationDeadlineMs of [
      () => Number.NaN,
      () => -1,
      () => {
        throw new Error("private");
      },
    ]) {
      expect(() => requestToolContext({ ...base, invocationDeadlineMs }, context)).toThrow(
        "Application returned an undeclared tool outcome.",
      );
    }
    expect(requestToolContext(base, { ...context, sessionID: "foreign" })).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
  });
});
