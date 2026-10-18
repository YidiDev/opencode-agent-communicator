import { realpathSync } from "node:fs";
import { z } from "zod";
import { domainFailure } from "../domain/results";
import type { InternalToolContract, StructuralToolContext } from "../tools/contracts";
import type { ActiveInvocationRegistry } from "./active-invocations";
import type { CommunicatorToolContracts } from "./communicator-generation";
import type { CommunicatorGenerationManager } from "./communicator-generation-manager";
import type { WorkspaceBinding } from "./workspace";

export interface HostToolContext {
  readonly sessionID: string;
  readonly messageID: string;
  readonly directory?: string;
  readonly worktree?: string;
  readonly abort?: AbortSignal;
  readonly [legacyHostField: string]: unknown;
}

export interface BridgedToolDefinition {
  readonly description: string;
  readonly input: z.ZodType;
  execute(rawArguments: unknown, context: HostToolContext): Promise<string>;
}

function hostShape(schema: z.ZodType): z.ZodType {
  if (!(schema instanceof z.ZodObject)) throw new TypeError("Tool arguments must be a Zod object.");
  return schema;
}

function adaptContext(context: HostToolContext, abort: AbortSignal): StructuralToolContext {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    abort,
  };
}

function workspaceMatches(context: HostToolContext, workspace: WorkspaceBinding): boolean {
  if (context.directory === undefined || context.worktree === undefined) return true;
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
): BridgedToolDefinition {
  return {
    description: contract.description,
    input: hostShape(contract.args),
    async execute(rawArguments, context) {
      if (workspace) {
        if (!workspaceMatches(context, workspace)) return callerNotVisible();
      }
      return invocations.run(context.abort ?? new AbortController().signal, async (abort) => {
        const parsed = invalidArguments(contract, rawArguments);
        if (typeof parsed === "string") return parsed;
        return contract.execute(parsed.data, adaptContext(context, abort));
      });
    },
  };
}

export function bridgeManagedTool(
  id: keyof CommunicatorToolContracts,
  manager: CommunicatorGenerationManager,
  workspace: WorkspaceBinding,
): BridgedToolDefinition {
  const descriptor = manager.descriptor(id);
  return {
    description: descriptor.description,
    input: hostShape(descriptor.args),
    async execute(rawArguments, context) {
      if (!workspaceMatches(context, workspace)) return callerNotVisible();
      return manager.invoke(
        id,
        context.abort ?? new AbortController().signal,
        async (contract, adapted) => {
          const parsed = invalidArguments(contract, rawArguments);
          if (typeof parsed === "string") return parsed;
          return contract.execute(parsed.data, adapted);
        },
        {
          sessionID: context.sessionID,
          messageID: context.messageID,
        },
      );
    },
  };
}
