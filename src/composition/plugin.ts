import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin, Skill } from "@opencode/plugin/effect";
import { Effect, Schema, Stream } from "effect";
import { createOpenCode2NativeAdapter } from "../adapters/native/opencode-2";
import { createOpenCode2HealthPort } from "../adapters/native/opencode-2-health";
import { LinuxBunSqliteStore } from "../adapters/store/sqlite-store";
import { ContextAdmissionRuntime } from "../application/context-admission-runtime";
import {
  type CommunicatorStartupRecoveryLifecycle,
  recoverCommunicatorStartup,
} from "../application/recover-communicator-startup";
import { RequestRuntime } from "../application/request-runtime";
import {
  minimumSupportedOpenCodeVersion,
  parseSupportedOpenCodeVersion,
  supportedOpenCodeVersionRange,
} from "../domain/host";
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
import { createProductionExporter } from "./plugin-exporter";
import {
  productionClock,
  productionMonotonicNowMs,
  productionRuntimeIdentity,
  productionSchedulerTimers,
  productionStartupTimers,
} from "./primitives";
import { type BridgedToolDefinition, bridgeManagedTool } from "./tool-bridge";
import { communicatorToolIds } from "./tools";
import type { WorkspaceBinding } from "./workspace";
import { deriveWorkspaceBinding } from "./workspace";

export type { CompositionDependencies } from "./composition-dependencies";

const bundledSkillsPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");

interface CompositionHooks {
  readonly tool: Record<string, BridgedToolDefinition>;
  readonly "experimental.chat.messages.transform": (
    input: unknown,
    output: { messages: unknown },
  ) => Promise<void>;
  readonly event: (input: { readonly event: unknown }) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

async function checkOpenCodeV2Compatibility(
  runtime: CompositionDependencies["runtimeIdentity"],
  health: ReturnType<CompositionDependencies["createHealth"]>,
  control: { readonly abort: AbortSignal; readonly deadlineMs: number },
) {
  const requirement = `Communicator requires Linux x64 and OpenCode ${minimumSupportedOpenCodeVersion} or newer in the stable ${supportedOpenCodeVersionRange} range.`;
  const identity = runtime.readIdentity();
  const validRuntime =
    typeof identity === "object" &&
    identity !== null &&
    Reflect.get(identity, "platform") === "linux" &&
    Reflect.get(identity, "architecture") === "x64";
  if (!validRuntime) {
    return {
      ok: false as const,
      error: { message: requirement },
    };
  }
  const remainingMs = control.deadlineMs - Date.now();
  if (control.abort.aborted || !Number.isSafeInteger(remainingMs) || remainingMs <= 0) {
    return { ok: false as const, error: { message: "OpenCode v2 compatibility proof timed out." } };
  }
  const timedOut = Symbol("timed_out");
  const value = await new Promise<unknown>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      control.abort.removeEventListener("abort", cancel);
      resolve(result);
    };
    const cancel = () => finish(timedOut);
    timer = setTimeout(cancel, remainingMs);
    control.abort.addEventListener("abort", cancel, { once: true });
    void health.readHealth().then(finish, () => finish(undefined));
  });
  if (value === timedOut) {
    return { ok: false as const, error: { message: "OpenCode v2 compatibility proof timed out." } };
  }
  const version =
    typeof value === "object" && value !== null && Reflect.get(value, "healthy") === true
      ? parseSupportedOpenCodeVersion(Reflect.get(value, "version"))
      : undefined;
  return version !== undefined
    ? { ok: true as const, value: { version } }
    : {
        ok: false as const,
        error: { message: requirement },
      };
}

const productionDependencies: CompositionDependencies = Object.freeze({
  parseOptions: parseCommunicatorOptions,
  deriveWorkspace: deriveWorkspaceBinding,
  createHealth: createOpenCode2HealthPort,
  runtimeIdentity: productionRuntimeIdentity,
  createNative: createOpenCode2NativeAdapter,
  checkCompatibility: checkOpenCodeV2Compatibility,
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
  ) => assertGenerationStartupActive(abort),
  createAdvisoryLockHooks: ({
    lifecycle,
  }: {
    readonly lifecycle: CommunicatorStartupRecoveryLifecycle;
  }) => ({
    wake: { wakeAdvisoryLockExpiry: () => lifecycle.scheduler.wake() },
  }),
  recoverStartup: recoverCommunicatorStartup,
  recoverContextStartup: failUncertainContextOnStartup,
  createExporter: createProductionExporter,
});

// Retained for callers migrating configuration independently. V2 registration uses transforms.
export function registerBundledSkills(config: object): void {
  const current: unknown = Reflect.get(config, "skills");
  if (
    current !== undefined &&
    (typeof current !== "object" || current === null || Array.isArray(current))
  )
    throw new TypeError("OpenCode skills configuration is malformed.");
  const pathsValue: unknown = current === undefined ? undefined : Reflect.get(current, "paths");
  if (
    pathsValue !== undefined &&
    (!Array.isArray(pathsValue) || pathsValue.some((path) => typeof path !== "string"))
  )
    throw new TypeError("OpenCode skill paths are malformed.");
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
  )
    throw new TypeError("OpenCode experimental configuration is malformed.");
  const value: unknown = current === undefined ? undefined : Reflect.get(current, "primary_tools");
  if (value !== undefined && (!Array.isArray(value) || value.some((id) => typeof id !== "string")))
    throw new TypeError("OpenCode primary tool configuration is malformed.");
  const primaryTools = value === undefined ? [] : [...value];
  for (const id of communicatorToolIds) if (!primaryTools.includes(id)) primaryTools.push(id);
  const experimental = current ?? {};
  Reflect.set(experimental, "primary_tools", primaryTools);
  Reflect.set(config, "experimental", experimental);
}

function bridgeContracts(
  manager: CommunicatorGenerationManager,
  workspace: WorkspaceBinding,
): Record<string, BridgedToolDefinition> {
  const definitions: Record<string, BridgedToolDefinition> = {};
  for (const id of communicatorToolIds) definitions[id] = bridgeManagedTool(id, manager, workspace);
  if (Object.keys(definitions).length !== communicatorToolIds.length)
    throw new Error("Atomic communicator tool registration failed.");
  return Object.freeze(definitions);
}

export async function failUncertainContextOnStartup(
  store: LinuxBunSqliteStore,
  lifecycle: CommunicatorStartupRecoveryLifecycle,
  workspaceKey: WorkspaceBinding["workspaceKey"],
  abort: AbortSignal,
): Promise<void> {
  const batchLimit = 100;
  const ceiling = deliveryRecordsPerWorkspaceHardCeiling + pendingRequestsPerWorkspaceHardCeiling;
  let recovered = 0;
  while (recovered < ceiling) {
    assertGenerationStartupActive(abort);
    const failed = await store.failUncertainContextOnStartup({
      fencingToken: lifecycle.fencingToken,
      workspaceKey,
      limit: batchLimit,
    });
    assertGenerationStartupActive(abort);
    if (failed.length > batchLimit)
      throw new Error("Context startup recovery returned an oversized batch.");
    recovered += failed.length;
    if (recovered > ceiling)
      throw new Error("Context startup recovery did not make bounded progress.");
    if (failed.length < batchLimit && recovered < ceiling) return;
  }
  assertGenerationStartupActive(abort);
  const residual = await store.failUncertainContextOnStartup({
    fencingToken: lifecycle.fencingToken,
    workspaceKey,
    limit: 1,
  });
  assertGenerationStartupActive(abort);
  if (residual.length !== 0)
    throw new Error("Context startup recovery did not make bounded progress.");
}

export function createCompositionFactory(
  overrides: Partial<CompositionDependencies> = {},
): (input: Plugin.Context, hostAbort?: AbortSignal) => Promise<CompositionHooks> {
  const dependencies: CompositionDependencies = { ...productionDependencies, ...overrides };
  return async (input, hostAbort) => {
    const options = dependencies.parseOptions(input.options);
    const workspace = dependencies.deriveWorkspace({
      project: input.location.project,
      worktree: input.location.project.canonical,
      directory: input.location.directory,
    });
    const startupAbort = new AbortController();
    const abortStartup = () => startupAbort.abort("host_disposal");
    hostAbort?.addEventListener("abort", abortStartup, { once: true });
    if (hostAbort?.aborted) startupAbort.abort("host_disposal");
    try {
      const startupDeadlineMs = createCommunicatorStartupDeadline(
        () => dependencies.generationClock.nowMs(),
        options.startupDeadlineMs,
      );
      const compatible = await dependencies.checkCompatibility(
        dependencies.runtimeIdentity,
        dependencies.createHealth(input),
        { abort: startupAbort.signal, deadlineMs: startupDeadlineMs },
      );
      assertGenerationStartupActive(startupAbort.signal);
      if (!compatible.ok) throw new Error(compatible.error.message);
      const native = dependencies.createNative({
        context: input,
        directory: workspace.directory,
        workspaceKey: workspace.workspaceKey,
        projectId: workspace.projectId,
      });
      const chatBookkeeping = createChatMessagesTransformBookkeeping();
      const build = (deadlineMs: number, abort: AbortSignal) =>
        createCommunicatorGeneration({
          pluginInput: { directory: workspace.directory, worktree: workspace.worktree },
          options,
          workspace,
          native,
          dependencies,
          chatBookkeeping,
          startupDeadlineMs: deadlineMs,
          startupAbort: abort,
        });
      const initial = await build(startupDeadlineMs, startupAbort.signal);
      if (startupAbort.signal.aborted || initial.lifecycle.status !== "ready") {
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
      return {
        tool: bridgeContracts(manager, workspace),
        "experimental.chat.messages.transform": (...arguments_) => manager.routeChat(...arguments_),
        event: (...arguments_) => manager.routeEvent(...arguments_),
        dispose: () => manager.dispose(),
      };
    } finally {
      hostAbort?.removeEventListener("abort", abortStartup);
    }
  };
}

function readBundledSkills() {
  const descriptions = {
    "session-communication": "Communicates with independent OpenCode sessions safely.",
    "session-request-participant": "Handles inbound peer requests safely.",
    "session-locks": "Coordinates shared workspace mutations with advisory locks.",
  } as const;
  return Object.entries(descriptions).map(([id, description]) => {
    const path = join(bundledSkillsPath, id, "SKILL.md");
    return Schema.decodeUnknownSync(Skill.Info)({
      id,
      name: id,
      description,
      path,
      content: readFileSync(path, "utf8"),
    });
  });
}

function adaptContextMessages(event: {
  readonly sessionID: string;
  readonly messages: readonly unknown[];
}) {
  const links: Array<{ readonly source: { text: string }; readonly copy: { text: string } }> = [];
  const messages = event.messages.map((value, index) => {
    const source = value as {
      readonly id?: string;
      readonly role?: string;
      readonly content?: unknown;
    };
    const messageID = source.id ?? `v2context${index}`;
    const content = Array.isArray(source.content) ? source.content : [];
    const parts = content.map((part) => {
      const record = typeof part === "object" && part !== null ? part : {};
      const copy = { ...record, sessionID: event.sessionID, messageID } as {
        text?: unknown;
        sessionID: string;
        messageID: string;
      };
      if (typeof Reflect.get(record, "text") === "string" && typeof copy.text === "string")
        links.push({ source: record as { text: string }, copy: copy as { text: string } });
      return copy;
    });
    return { info: { id: messageID, sessionID: event.sessionID, role: source.role }, parts };
  });
  return {
    messages,
    synchronize: () => {
      for (const { source, copy } of links) source.text = copy.text;
    },
  };
}

export function createOpenCodeV2Plugin(
  overrides: Partial<CompositionDependencies> = {},
): Plugin.Plugin {
  return Plugin.define({
    id: "opencode-agent-communicator",
    effect: (context) =>
      Effect.gen(function* () {
        // Recovery completes before the transform publishes any of the 21 tools.
        const hooks = yield* Effect.acquireRelease(
          Effect.promise((signal) => createCompositionFactory(overrides)(context, signal)),
          (hooks) => Effect.promise(() => hooks.dispose()).pipe(Effect.orDie),
        );
        yield* context.tool.transform((editor) => {
          for (const [name, definition] of Object.entries(hooks.tool)) {
            editor.add({
              name,
              description: definition.description,
              input: definition.input,
              options: { codemode: false },
              execute: (input, toolContext) =>
                Effect.promise(async (signal) => ({
                  content: await definition.execute(input, {
                    sessionID: toolContext.sessionID,
                    messageID: toolContext.messageID,
                    abort: signal,
                  }),
                })),
            });
          }
        });
        yield* context.skill.transform((editor) => {
          for (const skill of readBundledSkills()) editor.add(skill);
        });
        yield* context.session.hook("context", (event) =>
          Effect.promise(async () => {
            const adapted = adaptContextMessages(event);
            await hooks["experimental.chat.messages.transform"]({}, { messages: adapted.messages });
            adapted.synchronize();
          }),
        );
        yield* context.event.subscribe().pipe(
          Stream.runForEach((event) => Effect.promise(() => hooks.event({ event }))),
          Effect.forkScoped({ startImmediately: true }),
        );
      }),
  });
}
