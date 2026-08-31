import { realpathSync } from "node:fs";
import { type ToolContext, type ToolDefinition, tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { domainFailure } from "../domain/results";
import type { InternalToolContract, StructuralToolContext } from "../tools/contracts";
import type { ActiveInvocationRegistry } from "./active-invocations";
import type { CommunicatorToolContracts } from "./communicator-generation";
import type { CommunicatorGenerationManager } from "./communicator-generation-manager";
import type { WorkspaceBinding } from "./workspace";

function hostShape(schema: z.ZodType): Parameters<typeof tool>[0]["args"] {
  if (!(schema instanceof z.ZodObject)) throw new TypeError("Tool arguments must be a Zod object.");
  // OpenCode pins an older Zod 4 minor whose schemas remain runtime-compatible but nominally differ.
  return schema.shape as unknown as Parameters<typeof tool>[0]["args"];
}

function adaptContext(context: ToolContext, abort: AbortSignal): StructuralToolContext {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    abort,
    ask: (input) => context.ask(input),
  };
}

function workspaceMatches(context: ToolContext, workspace: WorkspaceBinding): boolean {
  try {
    return (
      realpathSync(context.directory) === workspace.directory &&
      realpathSync(context.worktree) === workspace.worktree
    );
  } catch {
    return false;
  }
}

function callerNotVisible(): string {
  return JSON.stringify(
    domainFailure("caller_not_visible", "Tool context does not match this workspace.", false),
  );
}

function invalidArguments(contract: InternalToolContract<unknown>, rawArguments: unknown) {
  const parsed = contract.args.safeParse(rawArguments);
  if (parsed.success) return parsed;
  return JSON.stringify(
    domainFailure("invalid_arguments", "Tool arguments failed strict validation.", false, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    }),
  );
}

export function bridgeTool(
  contract: InternalToolContract<unknown>,
  invocations: ActiveInvocationRegistry,
  workspace?: WorkspaceBinding,
): ToolDefinition {
  return tool({
    description: contract.description,
    args: hostShape(contract.args),
    async execute(rawArguments, context) {
      if (workspace) {
        if (!workspaceMatches(context, workspace)) return callerNotVisible();
      }
      return invocations.run(context.abort, async (abort) => {
        const parsed = invalidArguments(contract, rawArguments);
        if (typeof parsed === "string") return parsed;
        return contract.execute(parsed.data, adaptContext(context, abort));
      });
    },
  });
}

export function bridgeManagedTool(
  id: keyof CommunicatorToolContracts,
  manager: CommunicatorGenerationManager,
  workspace: WorkspaceBinding,
): ToolDefinition {
  const descriptor = manager.descriptor(id);
  return tool({
    description: descriptor.description,
    args: hostShape(descriptor.args),
    async execute(rawArguments, context) {
      if (!workspaceMatches(context, workspace)) return callerNotVisible();
      return manager.invoke(
        id,
        context.abort,
        async (contract, adapted) => {
          const parsed = invalidArguments(contract, rawArguments);
          if (typeof parsed === "string") return parsed;
          return contract.execute(parsed.data, adapted);
        },
        {
          sessionID: context.sessionID,
          messageID: context.messageID,
          ask: (input) => context.ask(input),
        },
      );
    },
  });
}
