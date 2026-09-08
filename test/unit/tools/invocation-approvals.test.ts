import { describe, expect, test } from "bun:test";
import type { ExportApprovalBinding } from "../../../src/application/session-export-ports";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { ToolContractFault } from "../../../src/tools/contracts";
import { invocationExportApproval } from "../../../src/tools/invocation-export-approval";
import { invocationStartApproval } from "../../../src/tools/invocation-start-approval";
import { invocationStopApproval } from "../../../src/tools/invocation-stop-approval";

const parsedWorkspace = validateWorkspaceKey("workspace:approval-edges");
if (!parsedWorkspace.ok) throw new Error("Invalid workspace fixture.");
const workspaceKey = parsedWorkspace.value;
const sourceSessionId = "ses_source" as never;
const targetSessionId = "ses_target" as never;
const deadlineMs = 10_000;
const clock = { nowMs: () => 0 };

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
    const preAborted = invocationExportApproval(
      { sessionID: sourceSessionId, abort: aborted.signal, ask: async () => undefined },
      { ...binding, abort: aborted.signal, deadlineMs },
    );
    expect(
      await preAborted.requestExportApproval("mode", binding, {
        abort: aborted.signal,
        deadlineMs,
      }),
    ).toBe("rejected");

    const abort = new AbortController().signal;
    const rejected = invocationExportApproval(
      {
        sessionID: sourceSessionId,
        abort,
        ask: async () => {
          throw new Error("host rejected");
        },
      },
      { ...binding, abort, deadlineMs },
    );
    expect(await rejected.requestExportApproval("mode", binding, { abort, deadlineMs })).toBe(
      "rejected",
    );
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
      await invocationStartApproval(
        { sessionID: sourceSessionId, abort: aborted.signal, ask: async () => undefined },
        { workspaceKey, sourceSessionId, abort: aborted.signal, deadlineMs, clock },
      ).requestStartApproval(binding, { abort: aborted.signal, deadlineMs }),
    ).toBe("rejected");
    const abort = new AbortController().signal;
    expect(
      await invocationStartApproval(
        {
          sessionID: sourceSessionId,
          abort,
          ask: async () => {
            throw new Error("host rejected");
          },
        },
        { workspaceKey, sourceSessionId, abort, deadlineMs, clock },
      ).requestStartApproval(binding, { abort, deadlineMs }),
    ).toBe("rejected");
  });

  test("stop approval rejects cancellation and host rejection", async () => {
    const binding = {
      workspaceKey,
      sourceSessionId,
      targetSessionId,
      reasonSha256: "b".repeat(64) as never,
    };
    const aborted = new AbortController();
    aborted.abort("cancelled");
    expect(
      await invocationStopApproval(
        { sessionID: sourceSessionId, abort: aborted.signal, ask: async () => undefined },
        { workspaceKey, sourceSessionId, targetSessionId, abort: aborted.signal, deadlineMs },
      ).requestStopApproval(binding, { abort: aborted.signal, deadlineMs }),
    ).toBe("rejected");
    const abort = new AbortController().signal;
    expect(
      await invocationStopApproval(
        {
          sessionID: sourceSessionId,
          abort,
          ask: async () => {
            throw new Error("host rejected");
          },
        },
        { workspaceKey, sourceSessionId, targetSessionId, abort, deadlineMs },
      ).requestStopApproval(binding, { abort, deadlineMs }),
    ).toBe("rejected");
  });
});

describe("invocation approval adversarial contracts", () => {
  test("never asks for malformed or invocation-mismatched approval inputs", async () => {
    let asks = 0;
    const abort = new AbortController().signal;
    const context = {
      sessionID: sourceSessionId,
      abort,
      ask: async () => {
        asks += 1;
      },
    };

    const start = invocationStartApproval(context, {
      workspaceKey,
      sourceSessionId,
      abort,
      deadlineMs,
      clock,
    });
    await expect(
      start.requestStartApproval(
        { workspaceKey, sourceSessionId, argumentsSha256: "not-a-digest" as never },
        { abort, deadlineMs },
      ),
    ).rejects.toBeInstanceOf(ToolContractFault);
    await expect(
      start.requestStartApproval(
        { workspaceKey, sourceSessionId, argumentsSha256: "a".repeat(64) as never },
        { abort: new AbortController().signal, deadlineMs },
      ),
    ).rejects.toBeInstanceOf(ToolContractFault);

    const exportBinding: ExportApprovalBinding = {
      workspaceKey,
      sourceSessionId,
      targetSessionId,
      destination: "safe/export.json" as never,
      isSanitized: false,
      shouldOverwrite: true,
    };
    const exportApproval = invocationExportApproval(context, {
      ...exportBinding,
      abort,
      deadlineMs,
    });
    await expect(
      exportApproval.requestExportApproval(
        "mode",
        { ...exportBinding, destination: "../escape" as never },
        { abort, deadlineMs },
      ),
    ).rejects.toBeInstanceOf(ToolContractFault);
    await expect(
      exportApproval.requestExportApproval(
        "mode",
        { ...exportBinding, targetSessionId: sourceSessionId },
        {
          abort,
          deadlineMs,
        },
      ),
    ).rejects.toBeInstanceOf(ToolContractFault);
    await expect(
      exportApproval.requestExportApproval("invalid" as never, exportBinding, {
        abort,
        deadlineMs,
      }),
    ).rejects.toBeInstanceOf(ToolContractFault);
    await expect(
      exportApproval.requestExportApproval("mode", exportBinding, {
        abort: new AbortController().signal,
        deadlineMs,
      }),
    ).rejects.toBeInstanceOf(ToolContractFault);

    const stop = invocationStopApproval(context, {
      workspaceKey,
      sourceSessionId,
      targetSessionId,
      abort,
      deadlineMs,
    });
    await expect(
      stop.requestStopApproval(
        {
          workspaceKey,
          sourceSessionId,
          targetSessionId,
          reasonSha256: "c".repeat(64) as never,
        },
        { abort, deadlineMs: deadlineMs + 1 },
      ),
    ).rejects.toBeInstanceOf(ToolContractFault);
    await expect(
      stop.requestStopApproval(
        {
          workspaceKey,
          sourceSessionId,
          targetSessionId,
          reasonSha256: "c".repeat(64) as never,
        },
        { abort: new AbortController().signal, deadlineMs },
      ),
    ).rejects.toBeInstanceOf(ToolContractFault);
    await expect(
      stop.requestStopApproval(
        {
          workspaceKey,
          sourceSessionId,
          targetSessionId: sourceSessionId,
          reasonSha256: "c".repeat(64) as never,
        },
        { abort, deadlineMs },
      ),
    ).rejects.toBeInstanceOf(ToolContractFault);
    expect(asks).toBe(0);
  });
});
