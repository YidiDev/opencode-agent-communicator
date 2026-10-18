import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ActiveInvocationRegistry } from "../../../src/composition/active-invocations";
import { bridgeTool } from "../../../src/composition/tool-bridge";

function context(abort = new AbortController().signal) {
  return {
    sessionID: "ses_0123456789abcdef0123456789abcdef",
    messageID: "msg",
    agent: "build",
    directory: "/workspace",
    worktree: "/workspace",
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

describe("OpenCode tool bridge", () => {
  test("preserves strictness, refinements, and defaults before application execution", async () => {
    let executions = 0;
    const contract = {
      description: "bridge fixture",
      args: z
        .object({
          value: z
            .number()
            .int()
            .superRefine((value, issue) => {
              if (value % 2 !== 0) issue.addIssue({ code: "custom", message: "must be even" });
            }),
          enabled: z.boolean().default(true),
        })
        .strict(),
      async execute(arguments_: { value: number; enabled: boolean }) {
        executions += 1;
        return JSON.stringify(arguments_);
      },
    };
    const bridged = bridgeTool(contract, new ActiveInvocationRegistry());
    expect(await bridged.execute({ value: 2 }, context())).toBe('{"value":2,"enabled":true}');
    const refined = JSON.parse(String(await bridged.execute({ value: 3 }, context())));
    const unknown = JSON.parse(String(await bridged.execute({ value: 2, extra: true }, context())));
    expect(refined.error.code).toBe("invalid_arguments");
    expect(unknown.error.code).toBe("invalid_arguments");
    expect(executions).toBe(1);
  });

  test("rejects a mismatched host ToolContext before argument parsing or execution", async () => {
    let executions = 0;
    const contract = {
      description: "bound fixture",
      args: z.object({ value: z.number() }).strict(),
      async execute() {
        executions += 1;
        return "unexpected";
      },
    };
    const bridged = bridgeTool(contract, new ActiveInvocationRegistry(), {
      workspaceKey: "workspace" as never,
      projectId: "project",
      directory: "/",
      worktree: "/",
    });
    const result = JSON.parse(
      String(
        await bridged.execute(
          { invalid_before_schema: true },
          { ...context(), directory: "/tmp", worktree: "/tmp" },
        ),
      ),
    );
    expect(result.error.code).toBe("caller_not_visible");
    expect(executions).toBe(0);
  });

  test("rejects non-object host schemas at construction", () => {
    expect(() =>
      bridgeTool(
        { description: "invalid", args: z.string(), execute: async () => "unexpected" },
        new ActiveInvocationRegistry(),
      ),
    ).toThrow("Zod object");
  });

  test("forwards identity and cancellation without the retired v1 approval callback", async () => {
    const caller = new AbortController();
    let asked = false;
    const bridged = bridgeTool(
      {
        description: "context fixture",
        args: z.object({}).strict(),
        async execute(_arguments, received) {
          expect(received.sessionID).toBe("ses_0123456789abcdef0123456789abcdef");
          expect(received.messageID).toBe("msg");
          expect(received.abort).not.toBe(caller.signal);
          expect(received.ask).toBeUndefined();
          return "adapted";
        },
      },
      new ActiveInvocationRegistry(),
      { workspaceKey: "workspace" as never, projectId: "project", directory: "/", worktree: "/" },
    );
    const result = await bridged.execute(
      {},
      {
        ...context(caller.signal),
        directory: "/",
        worktree: "/",
        ask: async () => {
          asked = true;
        },
      },
    );
    expect(result).toBe("adapted");
    expect(asked).toBe(false);
  });
});
