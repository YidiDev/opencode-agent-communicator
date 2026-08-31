import type { PluginInput } from "@opencode-ai/plugin";
import type {
  createOpenCode118NativeAdapter,
  OpenCodeNativeAdapter,
} from "../adapters/native/opencode-1-18";
import type { LinuxBunSqliteStore } from "../adapters/store/sqlite-store";
import type {
  AdvisoryLockPostCommitNotificationPort,
  AdvisoryLockWakePort,
} from "../application/advisory-lock-use-cases";
import type { checkHostCompatibility } from "../application/check-host-compatibility";
import type { CommunicatorStartupRecoveryLifecycle } from "../application/communicator-startup-lifecycle";
import type { ContextAdmissionRuntime } from "../application/context-admission-runtime";
import type { ClockPort } from "../application/delivery-ports";
import type { recoverCommunicatorStartup } from "../application/recover-communicator-startup";
import type { RequestDeadlineTimerPort } from "../application/request-deadline-scheduler";
import type { RequestRuntime } from "../application/request-runtime";
import type { SessionExportAdapterPort } from "../application/session-export-ports";
import type { StartupDeadlineTimerPort } from "../application/startup-effect-control";
import type { HostHealthPort, RuntimeIdentityPort } from "../domain/host";
import type { WorkspaceKey } from "../domain/workspaces";
import type { CommunicatorOptions, parseCommunicatorOptions } from "./config";
import type { GenerationRecoveryDelayPort } from "./generation-recovery-delay";
import type { createProductionExporter } from "./plugin-exporter";
import type { deriveWorkspaceBinding } from "./workspace";

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
  readonly createRuntime: (contextRuntime?: ContextAdmissionRuntime) => RequestRuntime;
  readonly createContextRuntime: () => ContextAdmissionRuntime;
  readonly generationRecoveryDelay: GenerationRecoveryDelayPort;
  readonly generationClock: ClockPort;
  readonly generationSchedulerTimers: RequestDeadlineTimerPort;
  readonly generationStartupTimers: StartupDeadlineTimerPort;
  readonly generationMonotonicNowMs: () => number;
  readonly generationStartupCheckpoint: (
    phase: "participants" | "exporter" | "advisory",
    abort: AbortSignal,
  ) => Promise<void>;
  readonly createAdvisoryLockHooks: (input: {
    readonly native: OpenCodeNativeAdapter;
    readonly lifecycle: CommunicatorStartupRecoveryLifecycle;
  }) => {
    readonly wake: AdvisoryLockWakePort;
    readonly notifications?: AdvisoryLockPostCommitNotificationPort;
    readonly dispose?: () => void;
    readonly drain?: () => Promise<void>;
  };
  readonly recoverStartup: typeof recoverCommunicatorStartup;
  readonly recoverContextStartup: (
    store: LinuxBunSqliteStore,
    lifecycle: CommunicatorStartupRecoveryLifecycle,
    workspaceKey: WorkspaceKey,
    abort: AbortSignal,
  ) => Promise<void>;
  readonly createExporter: (
    options: CommunicatorOptions,
    input: PluginInput,
  ) => ReturnType<typeof createProductionExporter> & {
    readonly adapter: SessionExportAdapterPort;
  };
}
