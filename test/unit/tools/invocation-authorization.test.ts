import { describe, expect, test } from "bun:test";
import { productionSha256 } from "../../../src/composition/primitives";
import { digestMessageContent } from "../../../src/domain/message-payload";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import {
  invocationMessageAuthorization,
  invocationRequestAuthorization,
} from "../../../src/tools/invocation-authorization";

const session = validateSessionId("ses_0123456789abcdef0123456789abcdef");
const target = validateSessionId("ses_fedcba9876543210fedcba9876543210");
const workspace = validateWorkspaceKey("workspace");
if (!session.ok || !target.ok || !workspace.ok) throw new Error("Invalid fixture identity.");

describe("invocation authorization", () => {
  test("implements allow and deny without asking", async () => {
    let asks = 0;
    const context = {
      sessionID: session.value,
      abort: new AbortController().signal,
      ask: async () => {
        asks += 1;
      },
    };
    const binding = {
      workspaceKey: workspace.value,
      sourceSessionId: session.value,
      targetSessionId: target.value,
      operation: "message" as const,
      contentSha256: await digestMessageContent(productionSha256, new TextEncoder().encode("zero")),
      contentByteLength: 4,
    };
    expect(
      await invocationMessageAuthorization("allow", context).authorizeMessage(binding, {
        abort: context.abort,
      }),
    ).toEqual({ kind: "allow" });
    expect(
      await invocationMessageAuthorization("deny", context).authorizeMessage(binding, {
        abort: context.abort,
      }),
    ).toEqual({ kind: "deny" });
    expect(asks).toBe(0);
  });

  test("keeps concurrent ask capabilities isolated to their exact ToolContext", async () => {
    const resources: string[][] = [[], []];
    const contexts = resources.map((captured, index) => ({
      sessionID: session.value,
      messageID: `message-${index}`,
      abort: new AbortController().signal,
      ask: async (input: { readonly patterns: string[] }) => {
        captured.push(input.patterns[0] ?? "");
      },
    }));
    const binding = {
      workspaceKey: workspace.value,
      sourceSessionId: session.value,
      targetSessionId: target.value,
      operation: "message" as const,
      contentSha256: await digestMessageContent(
        productionSha256,
        new TextEncoder().encode("seven"),
      ),
      contentByteLength: 7,
    };
    await Promise.all(
      contexts.map((context) =>
        invocationMessageAuthorization("ask", context).authorizeMessage(binding, {
          abort: context.abort,
          deadlineMs: 123,
        }),
      ),
    );
    expect(resources[0]).toHaveLength(1);
    expect(resources[1]).toHaveLength(1);
    expect(resources[0]?.[0]).toContain("deadline_ms=123");
    expect(resources[1]?.[0]).toContain("content_bytes=7");
  });

  test("fails closed when approval is unavailable, aborted, or rejected by the host", async () => {
    const binding = {
      workspaceKey: workspace.value,
      sourceSessionId: session.value,
      targetSessionId: target.value,
      operation: "message" as const,
      contentSha256: "a".repeat(64) as never,
      contentByteLength: 1,
    };
    const unavailable = { sessionID: session.value, abort: new AbortController().signal };
    expect(
      await invocationMessageAuthorization("ask", unavailable).authorizeMessage(binding, {
        abort: unavailable.abort,
      }),
    ).toEqual({ kind: "approval_rejected" });

    const aborted = new AbortController();
    aborted.abort("cancelled");
    expect(
      await invocationMessageAuthorization("ask", {
        ...unavailable,
        ask: async () => undefined,
      }).authorizeMessage(binding, { abort: aborted.signal }),
    ).toEqual({ kind: "approval_rejected" });

    expect(
      await invocationMessageAuthorization("ask", {
        ...unavailable,
        ask: async () => {
          throw new Error("host rejected");
        },
      }).authorizeMessage(binding, { abort: unavailable.abort }),
    ).toEqual({ kind: "approval_rejected" });
  });

  test("applies the operation-specific request policy and binds request evidence", async () => {
    const approvals: Array<{ patterns: string[]; metadata?: Record<string, unknown> }> = [];
    const authorization = invocationRequestAuthorization(
      { ask: "ask", wait: "deny" },
      {
        sessionID: session.value,
        abort: new AbortController().signal,
        async ask(input) {
          approvals.push(input as never);
        },
      },
    );
    const binding = {
      workspaceKey: workspace.value,
      sourceSessionId: session.value,
      targetSessionId: target.value,
      operation: "ask" as const,
      payloadSha256: "b".repeat(64) as never,
      payloadByteLength: 7,
      timeoutSeconds: 8,
      createdAtMs: 9,
      deadlineAtMs: 10,
    };
    expect(
      await authorization.authorizeRequest(binding, {
        abort: new AbortController().signal,
      }),
    ).toEqual({ kind: "allow" });
    expect(approvals[0]?.patterns[0]).toContain("invocation_deadline_ms=none");
    expect(approvals[0]?.metadata?.invocation_deadline_ms).toBeNull();
    expect(
      await authorization.authorizeRequest(
        { ...binding, operation: "wait" },
        { abort: new AbortController().signal },
      ),
    ).toEqual({ kind: "deny" });
  });
});
