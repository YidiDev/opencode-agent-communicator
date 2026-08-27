import { describe, expect, test } from "bun:test";
import type { ExportApprovalBinding } from "../../../src/application/session-export-ports";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { invocationExportApproval } from "../../../src/tools/invocation-export-approval";
import { invocationStartApproval } from "../../../src/tools/invocation-start-approval";
import { invocationStopApproval } from "../../../src/tools/invocation-stop-approval";

const parsedWorkspace = validateWorkspaceKey("workspace:approval-edges");
if (!parsedWorkspace.ok) throw new Error("Invalid workspace fixture.");
const workspaceKey = parsedWorkspace.value;
const sourceSessionId = "ses_source" as never;
const targetSessionId = "ses_target" as never;

describe("invocation approval failure boundaries", () => {
  test("export approval rejects pre-aborted and host-rejected asks without leaking errors", async () => {
    const binding: ExportApprovalBinding = {
      workspaceKey,
      sourceSessionId,
      targetSessionId,
      destination: "safe/export.json" as never,
      isSanitized: true,
      shouldOverwrite: false,
    };
    const aborted = new AbortController();
    aborted.abort("cancelled");
    const preAborted = invocationExportApproval({
      sessionID: sourceSessionId,
      abort: aborted.signal,
      ask: async () => undefined,
    });
    expect(await preAborted.requestExportApproval("mode", binding, { abort: aborted.signal })).toBe(
      "rejected",
    );

    const rejected = invocationExportApproval({
      sessionID: sourceSessionId,
      abort: new AbortController().signal,
      ask: async () => {
        throw new Error("host rejected");
      },
    });
    expect(
      await rejected.requestExportApproval("overwrite", binding, {
        abort: new AbortController().signal,
      }),
    ).toBe("rejected");
  });

  test("start approval rejects pre-aborted and host-rejected asks", async () => {
    const binding = {
      workspaceKey,
      sourceSessionId,
      argumentsSha256: "a".repeat(64) as never,
    };
    const aborted = new AbortController();
    aborted.abort("cancelled");
    expect(
      await invocationStartApproval({
        sessionID: sourceSessionId,
        abort: aborted.signal,
        ask: async () => undefined,
      }).requestStartApproval(binding, { abort: aborted.signal }),
    ).toBe("rejected");
    expect(
      await invocationStartApproval({
        sessionID: sourceSessionId,
        abort: new AbortController().signal,
        ask: async () => {
          throw new Error("host rejected");
        },
      }).requestStartApproval(binding, { abort: new AbortController().signal }),
    ).toBe("rejected");
  });

  test("stop approval rejects cancellation and host rejection", async () => {
    const expected = { workspaceKey, sourceSessionId };
    const binding = {
      ...expected,
      targetSessionId,
      reasonSha256: "b".repeat(64) as never,
    };
    const aborted = new AbortController();
    aborted.abort("cancelled");
    expect(
      await invocationStopApproval(
        { sessionID: sourceSessionId, abort: aborted.signal, ask: async () => undefined },
        expected,
      ).requestStopApproval(binding, { abort: aborted.signal }),
    ).toBe("rejected");
    expect(
      await invocationStopApproval(
        {
          sessionID: sourceSessionId,
          abort: new AbortController().signal,
          ask: async () => {
            throw new Error("host rejected");
          },
        },
        expected,
      ).requestStopApproval(binding, { abort: new AbortController().signal }),
    ).toBe("rejected");
  });
});
