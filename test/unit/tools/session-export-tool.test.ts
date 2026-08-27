import { describe, expect, test } from "bun:test";
import { sessionExportPolicyPort } from "../../../src/application/session-export-policy";
import type { SessionExportPorts } from "../../../src/application/session-export-ports";
import { validateFencingToken } from "../../../src/domain/ownership";
import { createSessionExportPolicy } from "../../../src/domain/session-export";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import {
  type StructuralApprovalInput,
  sessionExportArgumentsSchema,
  sessionExportFailureCodes,
  ToolContractFault,
} from "../../../src/tools/contracts";
import { invocationExportApproval } from "../../../src/tools/invocation-export-approval";
import { createSessionExportTool } from "../../../src/tools/session-export";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:export-tool"));
const fencingToken = valid(validateFencingToken(1));

function ports(): Omit<SessionExportPorts, "approval"> {
  return {
    readiness: { fencingToken, assertReady: () => undefined },
    membership: {
      async readCurrentRoots() {
        return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
      },
    },
    policy: sessionExportPolicyPort(createSessionExportPolicy()),
    ownership: {
      acquire: async () => fencingToken,
      isCurrent: async () => true,
    },
    exporter: {
      async writeExport() {
        return { ok: true, byteCount: 42, contentSha256: "c".repeat(64) as never };
      },
    },
  };
}

describe("session_export tool contract", () => {
  test("has strict snake_case schema, defaults, and exhaustive failures", () => {
    expect(sessionExportArgumentsSchema.parse({ destination: "x.json" })).toEqual({
      destination: "x.json",
      sanitize: true,
      overwrite: false,
    });
    for (const value of [
      {},
      { destination: "/x" },
      { destination: "x", sessionId: "ses_target" },
      { destination: "x", session_id: "bad" },
      { destination: "x", sanitize: "true" },
      { destination: "x", extra: true },
    ]) {
      expect(sessionExportArgumentsSchema.safeParse(value).success).toBe(false);
    }
    expect(sessionExportFailureCodes).toEqual([
      "invalid_arguments",
      "caller_not_visible",
      "target_not_visible",
      "approval_rejected",
      "permission_denied",
      "ownership_lost",
      "export_unavailable",
      "unsafe_path",
      "destination_exists",
      "export_limit_exceeded",
      "native_outcome_unknown",
      "storage_unavailable",
    ]);
  });

  test("projects summary without root, absolute path, or transcript JSON", async () => {
    const tool = createSessionExportTool(ports(), {
      workspaceKey,
      invocationDeadlineMs: () => Date.now() + 10_000,
    });
    const output = await tool.execute(
      { destination: "nested/x.json", sanitize: true, overwrite: false },
      { sessionID: "ses_source", abort: new AbortController().signal },
    );
    expect(JSON.parse(output)).toEqual({
      ok: true,
      value: {
        session_id: "ses_source",
        destination: "nested/x.json",
        sanitized: true,
        byte_count: 42,
        content_sha256: "c".repeat(64),
      },
    });
    expect(output).not.toContain("messages");
    expect(output).not.toContain("/tmp");
  });

  test("binds separate mode and overwrite asks to every exact resource", async () => {
    const asks: StructuralApprovalInput[] = [];
    const approval = invocationExportApproval({
      sessionID: "ses_source",
      messageID: "msg_call",
      abort: new AbortController().signal,
      async ask(input) {
        asks.push(input);
      },
    });
    const binding = {
      workspaceKey,
      sourceSessionId: "ses_source" as never,
      targetSessionId: "ses_target" as never,
      destination: "a;$(no)/x.json" as never,
      isSanitized: false,
      shouldOverwrite: true,
    };
    expect(
      await approval.requestExportApproval("mode", binding, {
        abort: new AbortController().signal,
      }),
    ).toBe("approved");
    expect(
      await approval.requestExportApproval("overwrite", binding, {
        abort: new AbortController().signal,
      }),
    ).toBe("approved");
    expect(asks.map((item) => item.permission)).toEqual([
      "session_export",
      "session_export_overwrite",
    ]);
    for (const ask of asks) {
      const serialized = JSON.stringify(ask);
      for (const evidence of [
        "workspace%3Aexport-tool",
        "source=ses_source",
        "target=ses_target",
        "destination=a%3B%24(no)%2Fx.json",
        "sanitize=false",
        "overwrite=true",
        '"invocation_message_id":"msg_call"',
      ]) {
        expect(serialized).toContain(evidence);
      }
    }
    await expect(
      approval.requestExportApproval("overwrite", binding, {
        abort: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ToolContractFault);
  });
});
