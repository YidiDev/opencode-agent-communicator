import { describe, expect, test } from "bun:test";
import { sessionExportPolicyPort } from "../../../src/application/session-export-policy";
import type { SessionExportPorts } from "../../../src/application/session-export-ports";
import { validateFencingToken } from "../../../src/domain/ownership";
import { createSessionExportPolicy } from "../../../src/domain/session-export";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import {
  sessionExportArgumentsSchema,
  sessionExportFailureCodes,
} from "../../../src/tools/contracts";
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
      { destination: "x", sanitize: false },
      { destination: "x", extra: true },
    ]) {
      expect(sessionExportArgumentsSchema.safeParse(value).success).toBe(false);
    }
    expect(sessionExportFailureCodes).toEqual([
      "invalid_arguments",
      "caller_not_visible",
      "target_not_visible",
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

  test("rejects an unsanitized request before any export effect", async () => {
    let exports = 0;
    const configured = ports();
    const tool = createSessionExportTool(
      {
        ...configured,
        exporter: {
          async writeExport() {
            exports += 1;
            return { ok: true, byteCount: 1, contentSha256: "c".repeat(64) as never };
          },
        },
      },
      { workspaceKey, invocationDeadlineMs: () => Date.now() + 10_000 },
    );
    const output = await tool.execute(
      { destination: "x.json", sanitize: false as true, overwrite: false },
      { sessionID: "ses_source", abort: new AbortController().signal },
    );

    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(exports).toBe(0);
  });
});
