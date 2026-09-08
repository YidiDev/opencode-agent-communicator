import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hooks, PluginInput, PluginOptions, ToolDefinition } from "@opencode-ai/plugin";
import {
  createOpenCode118NativeAdapter,
  type OpenCodeNativeAdapter,
} from "../adapters/native/opencode-1-18";
import { createOpenCode118HealthPort } from "../adapters/native/opencode-1-18-health";
import { LinuxBunSqliteStore } from "../adapters/store/sqlite-store";
import { checkHostCompatibility } from "../application/check-host-compatibility";
import { ContextAdmissionRuntime } from "../application/context-admission-runtime";
import {
  type CommunicatorStartupRecoveryLifecycle,
  recoverCommunicatorStartup,
} from "../application/recover-communicator-startup";
import { RequestRuntime } from "../application/request-runtime";
import {
  deliveryRecordsPerWorkspaceHardCeiling,
  pendingRequestsPerWorkspaceHardCeiling,
} from "../domain/safety-ceilings";
import { createChatMessagesTransformBookkeeping } from "./chat-messages-transform";
import { createCommunicatorGeneration } from "./communicator-generation";
import {
  assertGenerationStartupActive,
  createCommunicatorStartupDeadline,
} from "./communicator-generation-errors";
import { CommunicatorGenerationManager } from "./communicator-generation-manager";
import type { CompositionDependencies } from "./composition-dependencies";
import { parseCommunicatorOptions } from "./config";
import { productionGenerationRecoveryDelay } from "./generation-recovery-delay";
import {
  enforceMandatoryApproval,
  enforceMandatoryStopConfiguration,
} from "./mandatory-approval-hook";
import { createProductionExporter } from "./plugin-exporter";
import {
  productionClock,
  productionMonotonicNowMs,
  productionRuntimeIdentity,
  productionSchedulerTimers,
  productionStartupTimers,
} from "./primitives";
import { bridgeManagedTool } from "./tool-bridge";
import { communicatorToolIds } from "./tools";
import type { WorkspaceBinding } from "./workspace";
import { deriveWorkspaceBinding } from "./workspace";

export type { CompositionDependencies } from "./composition-dependencies";
export { productionExportEnvironment } from "./plugin-exporter";

const bundledSkillsPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");

const productionDependencies: CompositionDependencies = Object.freeze({
  parseOptions: parseCommunicatorOptions,
  deriveWorkspace: deriveWorkspaceBinding,
  createHealth: createOpenCode118HealthPort,
  runtimeIdentity: productionRuntimeIdentity,
  createNative: createOpenCode118NativeAdapter,
  checkCompatibility: checkHostCompatibility,
  createStore: (options: ConstructorParameters<typeof LinuxBunSqliteStore>[0]) =>
    new LinuxBunSqliteStore(options),
  createRuntime: (contextRuntime?: ContextAdmissionRuntime) =>
    new RequestRuntime(undefined, undefined, undefined, contextRuntime),
  createContextRuntime: () => new ContextAdmissionRuntime(),
  generationRecoveryDelay: productionGenerationRecoveryDelay,
  generationClock: productionClock,
  generationSchedulerTimers: productionSchedulerTimers,
  generationStartupTimers: productionStartupTimers,
  generationMonotonicNowMs: productionMonotonicNowMs,
  generationStartupCheckpoint: async (
    _phase: "participants" | "exporter" | "advisory",
    abort: AbortSignal,
  ) => {
    assertGenerationStartupActive(abort);
  },
  createAdvisoryLockHooks: ({
    lifecycle,
  }: {
    readonly native: OpenCodeNativeAdapter;
    readonly lifecycle: CommunicatorStartupRecoveryLifecycle;
  }) => ({ wake: { wakeAdvisoryLockExpiry: () => lifecycle.scheduler.wake() } }),
  recoverStartup: recoverCommunicatorStartup,
  recoverContextStartup: failUncertainContextOnStartup,
  createExporter: createProductionExporter,
});

export function registerBundledSkills(config: object): void {
  const current: unknown = Reflect.get(config, "skills");
  if (
    current !== undefined &&
    (typeof current !== "object" || current === null || Array.isArray(current))
  ) {
    throw new TypeError("OpenCode skills configuration is malformed.");
  }
  const pathsValue: unknown = current === undefined ? undefined : Reflect.get(current, "paths");
  if (
    pathsValue !== undefined &&
    (!Array.isArray(pathsValue) || pathsValue.some((path) => typeof path !== "string"))
  ) {
    throw new TypeError("OpenCode skill paths are malformed.");
  }
  const paths = pathsValue === undefined ? [] : [...pathsValue];
  if (!paths.includes(bundledSkillsPath)) paths.push(bundledSkillsPath);
  const skills = current ?? {};
  Reflect.set(skills, "paths", paths);
  Reflect.set(config, "skills", skills);
}

export function registerCommunicatorPrimaryTools(config: object): void {
  const current: unknown = Reflect.get(config, "experimental");
  if (
    current !== undefined &&
    (typeof current !== "object" || current === null || Array.isArray(current))
  ) {
    throw new TypeError("OpenCode experimental configuration is malformed.");
  }
  const primaryToolsValue: unknown =
    current === undefined ? undefined : Reflect.get(current, "primary_tools");
  if (
    primaryToolsValue !== undefined &&
    (!Array.isArray(primaryToolsValue) ||
      primaryToolsValue.some((toolId) => typeof toolId !== "string"))
  ) {
    throw new TypeError("OpenCode primary tool configuration is malformed.");
  }
  const primaryTools = primaryToolsValue === undefined ? [] : [...primaryToolsValue];
  for (const toolId of communicatorToolIds) {
    if (!primaryTools.includes(toolId)) primaryTools.push(toolId);
  }
  const experimental = current ?? {};
  Reflect.set(experimental, "primary_tools", primaryTools);
  Reflect.set(config, "experimental", experimental);
}

function bridgeContracts(
  manager: CommunicatorGenerationManager,
  workspace: WorkspaceBinding,
): Record<string, ToolDefinition> {
  const definitions: Record<string, ToolDefinition> = {};
  for (const id of communicatorToolIds) definitions[id] = bridgeManagedTool(id, manager, workspace);
  if (Object.keys(definitions).length !== communicatorToolIds.length) {
    throw new Error("Atomic communicator tool registration failed.");
  }
  return Object.freeze(definitions);
}

export async function failUncertainContextOnStartup(
  store: LinuxBunSqliteStore,
  lifecycle: CommunicatorStartupRecoveryLifecycle,
  workspaceKey: WorkspaceBinding["workspaceKey"],
  abort: AbortSignal,
): Promise<void> {
  const batchLimit = 100;
  const recoveryHardCeiling =
    deliveryRecordsPerWorkspaceHardCeiling + pendingRequestsPerWorkspaceHardCeiling;
  let recoveredContextRows = 0;
  while (recoveredContextRows < recoveryHardCeiling) {
    assertGenerationStartupActive(abort);
    const failed = await store.failUncertainContextOnStartup({
      fencingToken: lifecycle.fencingToken,
      workspaceKey,
      limit: batchLimit,
    });
    assertGenerationStartupActive(abort);
    if (failed.length > batchLimit) {
      throw new Error("Context startup recovery returned an oversized batch.");
    }
    recoveredContextRows += failed.length;
    if (recoveredContextRows > recoveryHardCeiling) {
      throw new Error("Context startup recovery did not make bounded progress.");
    }
    if (failed.length < batchLimit && recoveredContextRows < recoveryHardCeiling) return;
  }

  // Message deliveries and context-delivered requests can simultaneously reach their independent
  // ceilings. Probe once more rather than mistaking that exact aggregate boundary for non-progress,
  // but remain finite if the store repeats rows or violates either ceiling.
  assertGenerationStartupActive(abort);
  const residual = await store.failUncertainContextOnStartup({
    fencingToken: lifecycle.fencingToken,
    workspaceKey,
    limit: 1,
  });
  assertGenerationStartupActive(abort);
  if (residual.length !== 0) {
    throw new Error("Context startup recovery did not make bounded progress.");
  }
}

export function createCompositionFactory(
  overrides: Partial<CompositionDependencies> = {},
): (input: PluginInput, options?: PluginOptions) => Promise<Hooks> {
  const dependencies: CompositionDependencies = { ...productionDependencies, ...overrides };
  return async (input, rawOptions) => {
    // No persistent resource exists before strict options, workspace identity, and exact host proof.
    const options = dependencies.parseOptions(rawOptions);
    const workspace = dependencies.deriveWorkspace(input);
    const startupAbort = new AbortController();
    const startupDeadlineMs = createCommunicatorStartupDeadline(
      () => dependencies.generationClock.nowMs(),
      options.startupDeadlineMs,
    );
    const compatible = await dependencies.checkCompatibility(
      dependencies.runtimeIdentity,
      dependencies.createHealth(input),
      { abort: startupAbort.signal, deadlineMs: startupDeadlineMs },
    );
    if (!compatible.ok) throw new Error(compatible.error.message);
    const native: OpenCodeNativeAdapter = dependencies.createNative({
      client: input.client,
      directory: workspace.directory,
      serverUrl: input.serverUrl,
      workspaceKey: workspace.workspaceKey,
      projectId: workspace.projectId,
    });
    const chatBookkeeping = createChatMessagesTransformBookkeeping();
    const build = (deadlineMs: number, abort: AbortSignal) =>
      createCommunicatorGeneration({
        pluginInput: input,
        options,
        workspace,
        native,
        dependencies,
        chatBookkeeping,
        startupDeadlineMs: deadlineMs,
        startupAbort: abort,
      });
    const initial = await build(startupDeadlineMs, startupAbort.signal);
    if (initial.lifecycle.status !== "ready") {
      const diagnostic =
        initial.lifecycle.stopState?.diagnostic ?? "Communicator lifecycle is not ready.";
      try {
        initial.shutdownUnpublished();
        if ((await initial.drainInvocations()) === "timed_out") await initial.settleInvocations();
        await initial.disposeResources();
      } catch {}
      throw new Error(diagnostic);
    }
    const manager = new CommunicatorGenerationManager(
      initial,
      build,
      dependencies.generationRecoveryDelay,
      options.startupDeadlineMs,
    );
    const tools = bridgeContracts(manager, workspace);
    return {
      tool: tools,
      "permission.ask": enforceMandatoryApproval,
      "experimental.chat.messages.transform": (...arguments_) => manager.routeChat(...arguments_),
      config: async (config) => {
        enforceMandatoryStopConfiguration(config);
        registerCommunicatorPrimaryTools(config);
        registerBundledSkills(config);
      },
      event: (...arguments_) => manager.routeEvent(...arguments_),
      dispose: () => manager.dispose(),
    };
  };
}
