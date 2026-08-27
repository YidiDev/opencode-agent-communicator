import { realpathSync } from "node:fs";
import { type ToolContext, type ToolDefinition, tool } from "@opencode-ai/plugin";
import { type ZodRawShape, z } from "zod";
import { domainFailure } from "../domain/results";
import type { InternalToolContract, StructuralToolContext } from "../tools/contracts";
import type { ActiveInvocationRegistry } from "./active-invocations";
import type { WorkspaceBinding } from "./workspace";

function hostShape(schema: z.ZodType): ZodRawShape {
  if (!(schema instanceof z.ZodObject)) throw new TypeError("Tool arguments must be a Zod object.");
  return schema.shape;
}

function adaptContext(context: ToolContext, abort: AbortSignal): StructuralToolContext {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    abort,
    ask: (input) => context.ask(input),
  };
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
        let matches = false;
        try {
          matches =
            realpathSync(context.directory) === workspace.directory &&
            realpathSync(context.worktree) === workspace.worktree;
        } catch {}
        if (!matches) {
          return JSON.stringify(
            domainFailure(
              "caller_not_visible",
              "Tool context does not match this workspace.",
              false,
            ),
          );
        }
      }
      return invocations.run(context.abort, async (abort) => {
        const parsed = contract.args.safeParse(rawArguments);
        if (!parsed.success) {
          return JSON.stringify(
            domainFailure("invalid_arguments", "Tool arguments failed strict validation.", false, {
              issues: parsed.error.issues.map((issue) => ({
                path: issue.path,
                message: issue.message,
              })),
            }),
          );
        }
        return contract.execute(parsed.data, adaptContext(context, abort));
      });
    },
  });
}
