import { expect, test } from "bun:test";
import {
  validateManagedSessionId,
  validateNativeMessageId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import {
  sessionStartArgumentsSchema,
  sessionStartFailureCodes,
  ToolContractFault,
} from "../../../src/tools/contracts";
import { invocationStartApproval } from "../../../src/tools/invocation-start-approval";
import { publicStartOperation } from "../../../src/tools/public-values";
import { serializeSessionStartResult } from "../../../src/tools/session-start";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

test("publishes a strict snake_case start contract and exhaustive expected failures", () => {
  expect(
    sessionStartArgumentsSchema.safeParse({ idempotency_key: "one", initial_message: "go" })
      .success,
  ).toBe(true);
  expect(
    sessionStartArgumentsSchema.safeParse({ idempotencyKey: "one", initial_message: "go" }).success,
  ).toBe(false);
  expect(
    sessionStartArgumentsSchema.safeParse({
      idempotency_key: "one",
      initial_message: "go",
      extra: true,
    }).success,
  ).toBe(false);
  expect(sessionStartFailureCodes).toContain("idempotency_conflict");
  expect(sessionStartFailureCodes).toContain("native_outcome_unknown");
  expect(sessionStartFailureCodes).toContain("start_payload_unavailable");
  expect(sessionStartFailureCodes).toContain("unresolved_provenance_quota_exceeded");
  expect(sessionStartFailureCodes).toContain("admission_unknown");
});

test("binds default approval to the exact invocation digest and allows only one request", async () => {
  const approvals: unknown[] = [];
  const abort = new AbortController().signal;
  const workspaceKey = valid(validateWorkspaceKey("workspace:test"));
  const sourceSessionId = valid(validateSessionId("ses_source"));
  const deadlineMs = 10_000;
  const approval = invocationStartApproval(
    {
      sessionID: "ses_source",
      messageID: "msg_invocation",
      abort,
      async ask(input) {
        approvals.push(input);
      },
    },
    { workspaceKey, sourceSessionId, abort, deadlineMs, clock: { nowMs: () => 0 } },
  );
  const binding = {
    workspaceKey,
    sourceSessionId,
    argumentsSha256: "a".repeat(64) as Sha256Digest,
  };
  expect(await approval.requestStartApproval(binding, { abort, deadlineMs })).toBe("approved");
  expect(approvals).toHaveLength(1);
  expect(JSON.stringify(approvals[0])).toContain("arguments_sha256");
  expect(approval.requestStartApproval(binding, { abort, deadlineMs })).rejects.toThrow();
});

test("projects only summary metadata with snake_case keys", () => {
  const summary = publicStartOperation({
    id: valid(validateStartOperationId(`op_${"1".repeat(32)}`)),
    workspaceKey: valid(validateWorkspaceKey("workspace:test")),
    sourceSessionId: valid(validateSessionId("ses_source")),
    idempotencyKey: "one",
    argumentsSha256: "a".repeat(64) as Sha256Digest,
    sessionId: valid(validateManagedSessionId(`ses_${"2".repeat(32)}`)),
    nativeMessageId: valid(validateNativeMessageId(`msg_${"3".repeat(32)}`)),
    creationState: "created",
    titleState: "failed",
    admissionState: "admitted",
    createdAtMs: 1,
    updatedAtMs: 2,
  });
  expect(summary).toMatchObject({
    creation_state: "created",
    title_state: "failed",
    admission_state: "admitted",
  });
  expect(summary).not.toHaveProperty("initial_message");
  expect(summary).not.toHaveProperty("workspaceKey");
});

test("rejects forged, cross-workspace, and extra-key start operation results", () => {
  const expected = {
    workspaceKey: valid(validateWorkspaceKey("workspace:test")),
    sourceSessionId: "ses_source",
    idempotencyKey: "one",
  };
  const operation = {
    id: valid(validateStartOperationId(`op_${"1".repeat(32)}`)),
    workspaceKey: expected.workspaceKey,
    sourceSessionId: valid(validateSessionId(expected.sourceSessionId)),
    idempotencyKey: expected.idempotencyKey,
    argumentsSha256: "a".repeat(64) as Sha256Digest,
    sessionId: valid(validateManagedSessionId(`ses_${"2".repeat(32)}`)),
    nativeMessageId: valid(validateNativeMessageId(`msg_${"3".repeat(32)}`)),
    creationState: "created" as const,
    titleState: "skipped" as const,
    admissionState: "admitted" as const,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
  expect(
    JSON.parse(serializeSessionStartResult({ ok: true, value: operation }, expected)),
  ).toMatchObject({
    ok: true,
    value: { idempotency_key: "one" },
  });
  for (const forged of [
    { ...operation, workspaceKey: valid(validateWorkspaceKey("workspace:other")) },
    { ...operation, sourceSessionId: valid(validateSessionId("ses_other")) },
    { ...operation, idempotencyKey: "other" },
    { ...operation, extra: true },
  ]) {
    expect(() =>
      serializeSessionStartResult({ ok: true, value: forged } as never, expected),
    ).toThrow(ToolContractFault);
    expect(() =>
      serializeSessionStartResult(
        {
          ok: false,
          error: {
            code: "native_outcome_unknown",
            message: "partial",
            retryable: false,
            details: { operation: forged },
          },
        } as never,
        expected,
      ),
    ).toThrow(ToolContractFault);
  }
});
