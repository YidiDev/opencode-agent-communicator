import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hooks, PluginInput, PluginOptions, ToolDefinition } from "@opencode-ai/plugin";
import {
  createOpenCode118NativeAdapter,
  type OpenCodeNativeAdapter,
} from "../adapters/native/opencode-1-18";
import { createOpenCode118HealthPort } from "../adapters/native/opencode-1-18-health";
import { LinuxBunSqliteStore } from "../adapters/store/sqlite-store";
import { ActiveSessionAdvisoryLockNotifier } from "../application/advisory-lock-active-session-notifier";
import type {
  AdvisoryLockPostCommitNotificationPort,
  AdvisoryLockWakePort,
} from "../application/advisory-lock-use-cases";
import { checkHostCompatibility } from "../application/check-host-compatibility";
import { ParticipantDeletionLifecycle } from "../application/participant-deletion-lifecycle";
import { ParticipantOperationGate } from "../application/participant-operation-gate";
import { ParticipantStopLifecycle } from "../application/participant-stop-lifecycle";
import {
  type CommunicatorStartupRecoveryLifecycle,
  recoverCommunicatorStartup,
} from "../application/recover-communicator-startup";
import { RequestRuntime } from "../application/request-runtime";
import type { SessionExportAdapterPort } from "../application/session-export-ports";
import { createGeneratedIdFactory } from "../domain/generated-ids";
import type { HostHealthPort, RuntimeIdentityPort } from "../domain/host";
import { ActiveInvocationRegistry } from "./active-invocations";
import { type CommunicatorOptions, parseCommunicatorOptions } from "./config";
import {
  enforceMandatoryApproval,
  enforceMandatoryStopConfiguration,
} from "./mandatory-approval-hook";
import { createCompositionDisposer } from "./plugin-disposal";
import { createProductionExporter } from "./plugin-exporter";
import {
  productionClock,
  productionEntropy,
  productionMonotonicNowMs,
  productionRuntimeIdentity,
  productionSchedulerTimers,
  productionSha256,
  productionStartupTimers,
} from "./primitives";
import { bridgeTool } from "./tool-bridge";
import { communicatorToolIds, configuredStartPolicy, constructToolContracts } from "./tools";
import { unavailableSessionExporter } from "./unavailable-exporter";
import type { WorkspaceBinding } from "./workspace";
import { deriveWorkspaceBinding } from "./workspace";

export { productionExportEnvironment } from "./plugin-exporter";

const bundledSkillsPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");

export interface CompositionDependencies {
  readonly parseOptions: typeof parseCommunicatorOptions;
  readonly deriveWorkspace: typeof deriveWorkspaceBinding;
  readonly createHealth: (input: PluginInput) => HostHealthPort;
  readonly runtimeIdentity: RuntimeIdentityPort;
  readonly createNative: typeof createOpenCode118NativeAdapter;
  readonly checkCompatibility: typeof checkHostCompatibility;
  readonly createStore: (
    options: ConstructorParameters<typeof LinuxBunSqliteStore>[0],
  ) => LinuxBunSqliteStore;
  readonly createRuntime: () => RequestRuntime;
  readonly createAdvisoryLockHooks: (input: {
    readonly native: OpenCodeNativeAdapter;
    readonly lifecycle: CommunicatorStartupRecoveryLifecycle;
  }) => {
    readonly wake: AdvisoryLockWakePort;
    readonly notifications: AdvisoryLockPostCommitNotificationPort;
    readonly dispose?: () => void;
    readonly drain?: () => Promise<void>;
  };
  readonly recoverStartup: typeof recoverCommunicatorStartup;
  readonly createExporter: (
    options: CommunicatorOptions,
    input: PluginInput,
  ) => {
    readonly adapter: SessionExportAdapterPort;
    readonly drain?: () => Promise<void>;
    readonly dispose?: () => void;
  };
}

const productionDependencies: CompositionDependencies = Object.freeze({
  parseOptions: parseCommunicatorOptions,
  deriveWorkspace: deriveWorkspaceBinding,
  createHealth: createOpenCode118HealthPort,
  runtimeIdentity: productionRuntimeIdentity,
  createNative: createOpenCode118NativeAdapter,
  checkCompatibility: checkHostCompatibility,
  createStore: (options: ConstructorParameters<typeof LinuxBunSqliteStore>[0]) =>
    new LinuxBunSqliteStore(options),
  createRuntime: () => new RequestRuntime(),
  createAdvisoryLockHooks: ({
    native,
    lifecycle,
  }: {
    readonly native: OpenCodeNativeAdapter;
    readonly lifecycle: CommunicatorStartupRecoveryLifecycle;
  }) => {
    const notifier = new ActiveSessionAdvisoryLockNotifier({
      roots: native,
      steer: native,
      ids: createGeneratedIdFactory(productionEntropy),
      timers: productionSchedulerTimers,
    });
    return {
      wake: { wakeAdvisoryLockExpiry: () => lifecycle.scheduler.wake() },
      notifications: notifier,
      dispose: () => notifier.dispose(),
      drain: () => notifier.drain(),
    };
  },
  recoverStartup: recoverCommunicatorStartup,
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

function bridgeContracts(
  contracts: ReturnType<typeof constructToolContracts>,
  invocations: ActiveInvocationRegistry,
  workspace: WorkspaceBinding,
): Record<string, ToolDefinition> {
  const definitions: Record<string, ToolDefinition> = {};
  for (const id of communicatorToolIds)
    definitions[id] = bridgeTool(contracts[id], invocations, workspace);
  if (Object.keys(definitions).length !== communicatorToolIds.length) {
    throw new Error("Atomic communicator tool registration failed.");
  }
  return Object.freeze(definitions);
}

export function createCompositionFactory(
  overrides: Partial<CompositionDependencies> = {},
): (input: PluginInput, options?: PluginOptions) => Promise<Hooks> {
  const dependencies: CompositionDependencies = { ...productionDependencies, ...overrides };
  return async (input, rawOptions) => {
    let store: LinuxBunSqliteStore | undefined;
    let runtime: RequestRuntime | undefined;
    let lifecycle: CommunicatorStartupRecoveryLifecycle | undefined;
    let deletion: ParticipantDeletionLifecycle | undefined;
    let participantStop: ParticipantStopLifecycle | undefined;
    let participantOperations: ParticipantOperationGate | undefined;
    let exporterDrain: (() => Promise<void>) | undefined;
    let exporterDispose: (() => void) | undefined;
    let advisoryLockDispose: (() => void) | undefined;
    let advisoryLockDrain: (() => Promise<void>) | undefined;
    const invocations = new ActiveInvocationRegistry();
    const dispose = createCompositionDisposer({
      lifecycle: () => lifecycle,
      deletion: () => deletion,
      participantStop: () => participantStop,
      participantOperations: () => participantOperations,
      runtime: () => runtime,
      invocations,
      exporterDrain: () => exporterDrain,
      exporterDispose: () => exporterDispose,
      advisoryLockDispose: () => advisoryLockDispose,
      advisoryLockDrain: () => advisoryLockDrain,
      store: () => store,
    });
    try {
      // No persistent resource exists before strict options, workspace identity, and exact host proof.
      const options = dependencies.parseOptions(rawOptions);
      const workspace = dependencies.deriveWorkspace(input);
      const workspaceKey = workspace.workspaceKey;
      const startupAbort = new AbortController();
      const startupDeadlineMs = productionClock.nowMs() + options.startupDeadlineMs;
      // The health adapter uses the build-time 1.18 SDK across the supported patch line. Identity is
      // checked before that call; both checks complete before any persistent resource is opened.
      const compatible = await dependencies.checkCompatibility(
        dependencies.runtimeIdentity,
        dependencies.createHealth(input),
        {
          abort: startupAbort.signal,
          deadlineMs: startupDeadlineMs,
        },
      );
      if (!compatible.ok) throw new Error(compatible.error.message);
      const native: OpenCodeNativeAdapter = dependencies.createNative({
        client: input.client,
        directory: workspace.directory,
        serverUrl: input.serverUrl,
        workspaceKey,
      });
      runtime = dependencies.createRuntime();
      store = dependencies.createStore({
        stateDirectory: options.stateDirectory,
        // Linux private-path filenames are capped at 64 characters; retain a 208-bit digest.
        databaseFileName: `${workspaceKey.slice(0, 56)}.sqlite3`,
        workspaceKey,
        nowWallMs: () => productionClock.nowMs(),
      });
      const recovered = await dependencies.recoverStartup(
        {
          membership: native,
          deliveries: store,
          nativeQueue: native,
          requests: store,
          locks: store,
          participantPresence: native,
          activity: native,
          nativeSteer: native,
          ownership: store,
          startupBarrier: store,
          clock: productionClock,
          runtime,
          resultRetention: store,
          requestRetention: store,
          starts: store.starts,
          requestStarts: store,
          nativeStart: native,
          digest: productionSha256,
          startLimits: configuredStartPolicy(options).limits,
        },
        {
          workspaceKey,
          abort: startupAbort.signal,
          deadlineMs: startupDeadlineMs,
          limit: 100,
          timers: productionSchedulerTimers,
          startupTimers: productionStartupTimers,
          nowMonotonicMs: productionMonotonicNowMs,
        },
      );
      if (!recovered.ok) throw new Error(recovered.error.message);
      lifecycle = recovered.value;
      participantOperations = new ParticipantOperationGate();
      deletion = new ParticipantDeletionLifecycle({
        requests: store,
        presence: native,
        notifications: runtime,
        lifecycle,
        workspaceKey,
        directory: workspace.directory,
        projectId: workspace.projectId,
      });
      participantStop = new ParticipantStopLifecycle({
        requests: store,
        activity: native,
        operations: participantOperations,
        notifications: runtime,
        lifecycle,
        workspaceKey,
      });
      let exporter: ReturnType<CompositionDependencies["createExporter"]>;
      try {
        exporter = dependencies.createExporter(options, {
          ...input,
          directory: workspace.directory,
          worktree: workspace.worktree,
        });
      } catch {
        console.warn("Session export is unavailable because secure initialization failed.");
        exporter = { adapter: unavailableSessionExporter };
      }
      exporterDrain = exporter.drain;
      exporterDispose = exporter.dispose;
      const advisoryLockHooks = dependencies.createAdvisoryLockHooks({ native, lifecycle });
      advisoryLockDispose = advisoryLockHooks.dispose;
      advisoryLockDrain = advisoryLockHooks.drain;
      const contracts = constructToolContracts({
        options,
        workspaceKey,
        native,
        store,
        runtime,
        lifecycle,
        participantOperations,
        exporter: exporter.adapter,
        advisoryLockWake: advisoryLockHooks.wake,
        advisoryLockNotifications: advisoryLockHooks.notifications,
      });
      const tools = bridgeContracts(contracts, invocations, workspace);
      return {
        tool: tools,
        "permission.ask": enforceMandatoryApproval,
        config: async (config) => {
          enforceMandatoryStopConfiguration(config);
          registerBundledSkills(config);
        },
        event: async ({ event }) => {
          await participantStop?.handle(event);
          await deletion?.handle(event);
        },
        dispose,
      };
    } catch (cause: unknown) {
      try {
        await dispose();
      } catch {}
      throw cause;
    }
  };
}
