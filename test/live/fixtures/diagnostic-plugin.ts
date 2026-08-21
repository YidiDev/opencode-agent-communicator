import { appendFile } from "node:fs/promises";

import { type Plugin, tool } from "@opencode-ai/plugin";

let instanceSequence = 0;

function evidencePath(options: Record<string, unknown>): string {
  const path = options.evidencePath;
  if (typeof path !== "string" || path.length === 0) throw new Error("evidencePath is required");
  return path;
}

async function appendEvidence(path: string, evidence: Record<string, unknown>): Promise<void> {
  await appendFile(path, `${JSON.stringify(evidence)}\n`, { encoding: "utf8", mode: 0o600 });
}

export const diagnosticPlugin: Plugin = async (input, options = {}) => {
  const path = evidencePath(options);
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
    tool: {
      diagnostic_context: tool({
        description: "Capture the exact live ToolContext surface for compatibility testing.",
        args: {},
        async execute(_arguments, context) {
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
          };
          await appendEvidence(path, evidence);
          return JSON.stringify(evidence);
        },
      }),
    },
    async dispose(): Promise<void> {
      await appendEvidence(path, { event: "disposed", pid: process.pid, instanceID });
    },
  };
};
