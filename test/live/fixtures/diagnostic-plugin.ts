import { appendFile } from "node:fs/promises";

import { type Plugin, tool } from "@opencode-ai/plugin";
import {
  enforceMandatoryApproval,
  enforceMandatoryStopConfiguration,
} from "../../../src/composition/mandatory-approval-hook";

let instanceSequence = 0;

function evidencePath(options: Record<string, unknown>): string {
  const path = options.evidencePath;
  if (typeof path !== "string" || path.length === 0) throw new Error("evidencePath is required");
  return path;
}

function configuredPath(options: Record<string, unknown>, key: string): string {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
  return value;
}

async function appendEvidence(path: string, evidence: Record<string, unknown>): Promise<void> {
  await appendFile(path, `${JSON.stringify(evidence)}\n`, { encoding: "utf8", mode: 0o600 });
}

export const diagnosticPlugin: Plugin = async (input, options = {}) => {
  const path = evidencePath(options);
  const skillPath = configuredPath(options, "skillPath");
  instanceSequence += 1;
  const instanceID = instanceSequence;
  await appendEvidence(path, {
    event: "initialized",
    pid: process.pid,
    instanceID,
    directory: input.directory,
    worktree: input.worktree,
  });

  return {
    async config(config): Promise<void> {
      enforceMandatoryStopConfiguration(config);
      const target = config as typeof config & { skills?: { paths?: string[] } };
      target.skills ??= {};
      target.skills.paths ??= [];
      target.skills.paths.push(skillPath);
      await appendEvidence(path, { event: "config-hook", pid: process.pid, instanceID, skillPath });
    },
    async "permission.ask"(input, output): Promise<void> {
      await enforceMandatoryApproval(input, output);
      await appendEvidence(path, {
        event: "permission-hook",
        pid: process.pid,
        instanceID,
        input,
        status: output.status,
      });
    },
    tool: {
      diagnostic_context: tool({
        description: "Capture the exact live ToolContext surface for compatibility testing.",
        args: {},
        async execute(arguments_, context) {
          context.metadata({ title: "Live diagnostic", metadata: { captured: true } });
          const evidence = {
            event: "executed",
            pid: process.pid,
            instanceID,
            sessionID: context.sessionID,
            messageID: context.messageID,
            agent: context.agent,
            directory: context.directory,
            worktree: context.worktree,
            abortSignalPresent:
              typeof context.abort.aborted === "boolean" &&
              typeof context.abort.addEventListener === "function",
            metadataAvailable: typeof context.metadata === "function",
            askAvailable: typeof context.ask === "function",
            rawArguments: arguments_,
          };
          await appendEvidence(path, evidence);
          return JSON.stringify(evidence);
        },
      }),
      diagnostic_approval: tool({
        description: "Exercise ToolContext.ask with an exact deterministic request.",
        args: { mode: tool.schema.enum(["allow", "deny", "ask", "stop"]) },
        async execute(arguments_, context) {
          const mode = arguments_.mode;
          const request = {
            permission: mode === "stop" ? "session_stop" : `live_${mode}`,
            patterns: [`resource:${mode}:primary`, `resource:${mode}:secondary`],
            always: [`resource:${mode}:*`],
            metadata: { proof: "phase0", mode, nested: { ordinal: 21 } },
          };
          await appendEvidence(path, {
            event: "ask-entered",
            pid: process.pid,
            instanceID,
            mode,
            sessionID: context.sessionID,
            messageID: context.messageID,
            request,
          });
          try {
            const asking = context.ask(request);
            await appendEvidence(path, {
              event: "ask-invoked",
              pid: process.pid,
              instanceID,
              mode,
              sessionID: context.sessionID,
            });
            await asking;
          } catch (error: unknown) {
            await appendEvidence(path, {
              event: "ask-rejected",
              pid: process.pid,
              instanceID,
              mode,
              name: error instanceof Error ? error.name : typeof error,
              message: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
          const output = `ask-${mode}-completed`;
          await appendEvidence(path, {
            event: "ask-resolved",
            pid: process.pid,
            instanceID,
            mode,
            output,
          });
          return output;
        },
      }),
      diagnostic_cancellation: tool({
        description: "Wait until ToolContext.abort is actively signalled.",
        args: {},
        async execute(_arguments, context) {
          await appendEvidence(path, {
            event: "cancellation-entered",
            pid: process.pid,
            instanceID,
            sessionID: context.sessionID,
            messageID: context.messageID,
            aborted: context.abort.aborted,
          });
          await new Promise<void>((resolve) => {
            if (context.abort.aborted) resolve();
            else context.abort.addEventListener("abort", () => resolve(), { once: true });
          });
          const output = "tool-observed-abort";
          await appendEvidence(path, {
            event: "cancellation-observed",
            pid: process.pid,
            instanceID,
            aborted: context.abort.aborted,
            output,
          });
          return output;
        },
      }),
    },
    async dispose(): Promise<void> {
      await appendEvidence(path, { event: "disposed", pid: process.pid, instanceID });
    },
  };
};
