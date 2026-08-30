import { describe, expect, test } from "bun:test";

import { encodeRequestListCursor } from "../../../src/application/request-list-cursor";
import { validateRequestId } from "../../../src/domain/generated-ids";
import type { FencingToken } from "../../../src/domain/ownership";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
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

function workspace() {
  const value = validateWorkspaceKey("request-tools");
  if (!value.ok) throw new Error("invalid fixture");
  return value.value;
}

const requestId = `req_${"a".repeat(32)}`;
const context = { sessionID: "ses_source", abort: new AbortController().signal };

describe("request tool argument contracts", () => {
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
