import { describe, expect, test } from "bun:test";
import { SanitizedContextExportAdapter } from "../../../../src/adapters/export/sanitized-context-export-adapter";

describe("sanitized current-context exporter", () => {
  test("writes only the versioned projection and summary digest", async () => {
    let captured = "";
    let installed = false;
    const root = {
      createTemporary() {
        return {
          descriptor: 1,
          write(bytes: Uint8Array) {
            captured += new TextDecoder().decode(bytes);
          },
          install() {
            installed = true;
          },
          discard() {},
        };
      },
      close() {},
    };
    const native = {
      async readMessagePage() {
        return {
          messages: [
            {
              type: "assistant" as const,
              messageId: "msg_a",
              state: "completed" as const,
              parts: [],
            },
            { type: "user" as const, messageId: "msg_u" },
          ],
          examinedMessageIds: ["msg_a", "msg_u"],
          examinedMessageCount: 2,
          projectedTextByteCount: 0,
          rawResponseByteCount: 2,
          examinedPartCount: 0,
          previousCursor: null,
          nextCursor: null,
        };
      },
      async readMessage() {
        throw new Error("not used");
      },
    };
    const adapter = new SanitizedContextExportAdapter(root as never, native, {
      maximumOutputBytes: 65_536,
    });
    const result = await adapter.writeExport({
      sessionId: "ses_target" as never,
      sourceSessionId: "ses_source" as never,
      workspaceKey: "wrk_test" as never,
      destination: "context.json" as never,
      isSanitized: true,
      shouldOverwrite: false,
      abort: new AbortController().signal,
      deadlineMs: Date.now() + 10_000,
      fencingToken: 1 as never,
      guard: { check: async () => "current" },
    });
    expect(result).toMatchObject({ ok: true, byteCount: captured.length });
    expect(installed).toBeTrue();
    expect(JSON.parse(captured)).toMatchObject({
      version: 1,
      kind: "opencode-sanitized-current-context",
      history_complete: false,
      communicator: { source_session_id: "ses_source", target_session_id: "ses_target" },
    });
    expect(captured).not.toContain("workspace");
  });

  test("rejects unsanitized input without reading context", async () => {
    let reads = 0;
    const adapter = new SanitizedContextExportAdapter({} as never, {
      async readMessagePage() {
        reads += 1;
        throw new Error("must not read");
      },
      async readMessage() {
        throw new Error("must not read");
      },
    });
    expect(
      await adapter.writeExport({
        sessionId: "ses_target" as never,
        sourceSessionId: "ses_source" as never,
        workspaceKey: "wrk_test" as never,
        destination: "context.json" as never,
        isSanitized: false,
        shouldOverwrite: false,
        abort: new AbortController().signal,
        deadlineMs: Date.now() + 10_000,
        fencingToken: 1 as never,
        guard: { check: async () => "current" },
      }),
    ).toMatchObject({ ok: false });
    expect(reads).toBe(0);
  });
});
