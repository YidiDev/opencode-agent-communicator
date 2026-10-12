import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { parseCommunicatorOptions } from "../../../src/composition/config";
import {
  type CompositionDependencies,
  createOpenCodeV2Plugin,
  registerBundledSkills,
  registerCommunicatorPrimaryTools,
} from "../../../src/composition/plugin";
import { communicatorToolIds } from "../../../src/composition/tools";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const parsedWorkspace = validateWorkspaceKey("v2-effect-plugin");
if (!parsedWorkspace.ok) throw new Error("Invalid workspace fixture.");
const workspaceKey = parsedWorkspace.value;

function dependencies(order: string[]): Partial<CompositionDependencies> {
  return {
    parseOptions: (value) => parseCommunicatorOptions(value, { HOME: "/home/operator" }),
    deriveWorkspace: () => ({
      workspaceKey,
      projectId: "project",
      directory: "/workspace",
      worktree: "/workspace",
    }),
    createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "2.0.26" }) }),
    checkCompatibility: async () => ({ ok: true, value: { version: "2.0.26" } }),
    createNative: () =>
      ({
        readVisibleRoots: async () => [],
        readParticipantPresence: async () => "absent",
        isEligibleContextTarget: async () => true,
      }) as never,
    createStore: () =>
      ({
        starts: {},
        recordParticipantObservations: async (input: { observations: readonly unknown[] }) => ({
          ok: true,
          recorded: input.observations.length,
        }),
        listParticipantRootCandidates: async () => [],
        listParticipantDeletionCandidates: async () => ({
          ok: true,
          sessionIds: ["ses_deleted"],
        }),
        listPendingContext: async () => [],
        readContextReminders: async () => ({ activeLockCount: 0, availableResults: [] }),
        deleteParticipantRequests: async () => {
          order.push("event");
          return { ok: true, terminalized: [] };
        },
        deleteAbsentParticipantRequests: async () => ({ ok: true, terminalized: [] }),
        failPendingContextForParticipant: async () => [],
        settlePendingContextForParticipant: async () => [],
        close: () => order.push("store-close"),
      }) as never,
    createRuntime: () =>
      ({ effectSignal: new AbortController().signal, stop: () => undefined }) as never,
    recoverStartup: async () => ({
      ok: true,
      value: {
        fencingToken: 1 as never,
        status: "ready",
        stopState: undefined,
        effectSignal: new AbortController().signal,
        assertReady: () => undefined,
        observeStop: () => () => undefined,
        stop: () => order.push("lifecycle-stop"),
        scheduler: { drain: async () => order.push("scheduler-drain") },
      } as never,
    }),
    recoverContextStartup: async () => undefined,
    createExporter: () => ({
      adapter: { writeExport: async () => ({ ok: false, code: "export_unavailable" }) },
      drain: async () => {
        order.push("exporter-drain");
      },
      dispose: () => {
        order.push("exporter-dispose");
      },
    }),
  };
}

function contextFixture(input: {
  readonly addedTools: unknown[];
  readonly addedSkills: unknown[];
  readonly contextHook: { current?: (event: never) => Effect.Effect<void> };
  readonly event: unknown;
}) {
  return {
    options: {},
    location: { project: { canonical: "/workspace" }, directory: "/workspace" },
    tool: {
      transform: (transform: (editor: { add(value: unknown): void }) => void) =>
        Effect.sync(() => transform({ add: (value) => input.addedTools.push(value) })),
    },
    skill: {
      transform: (transform: (editor: { add(value: unknown): void }) => void) =>
        Effect.sync(() => transform({ add: (value) => input.addedSkills.push(value) })),
    },
    session: {
      hook: (name: string, hook: (event: never) => Effect.Effect<void>) =>
        Effect.sync(() => {
          expect(name).toBe("context");
          input.contextHook.current = hook;
        }),
    },
    event: { subscribe: () => Stream.make(input.event) },
  } as unknown as Record<string, unknown>;
}

describe("OpenCode v2 Effect plugin", () => {
  test("publishes tools and skills, routes hooks and events, and finalizes the generation", async () => {
    const order: string[] = [];
    const addedTools: Array<{
      name: string;
      execute: (input: unknown, context: unknown) => Effect.Effect<{ content: unknown }>;
    }> = [];
    const addedSkills: Array<{ id: string; content: string }> = [];
    const contextHook: { current?: (event: never) => Effect.Effect<void> } = {};
    const event = {
      id: "evt_deleted",
      created: 1,
      type: "session.deleted",
      durable: { aggregateID: "ses_deleted", seq: 1, version: 2 },
      location: { directory: "/workspace" },
      data: { sessionID: "ses_deleted" },
    };
    const context = contextFixture({ addedTools, addedSkills, contextHook, event });
    const plugin = createOpenCodeV2Plugin(dependencies(order));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* plugin.effect(context as never);
          expect(addedTools.map((tool) => tool.name)).toEqual([...communicatorToolIds]);
          expect(addedSkills.map((skill) => skill.id)).toEqual([
            "session-communication",
            "session-request-participant",
            "session-locks",
          ]);
          expect(addedSkills.every((skill) => skill.content.length > 0)).toBe(true);

          const sessionList = addedTools.find((tool) => tool.name === "session_list");
          if (!sessionList) throw new Error("session_list was not transformed");
          const result = yield* sessionList.execute(
            {},
            {
              sessionID: "ses_0123456789abcdef0123456789abcdef",
              messageID: "msg",
            },
          );
          expect(typeof result.content).toBe("string");
          expect(JSON.parse(String(result.content))).toBeObject();

          const source = { type: "text", text: "visible context" };
          if (!contextHook.current) throw new Error("context hook was not installed");
          yield* contextHook.current({
            sessionID: "ses_0123456789abcdef0123456789abcdef",
            messages: [
              { id: "msg_existing", role: "user", content: [source, null, "invalid"] },
              { role: "assistant", content: "not-an-array" },
            ],
          } as never);
          expect(source.text).toBe("visible context");
          yield* Effect.sleep("10 millis");
        }),
      ),
    );

    expect(order).toContain("event");
    expect(order.slice(-5)).toEqual([
      "lifecycle-stop",
      "scheduler-drain",
      "exporter-drain",
      "exporter-dispose",
      "store-close",
    ]);
  });

  test("fails startup without publishing transforms or resources", async () => {
    let transforms = 0;
    const plugin = createOpenCodeV2Plugin({
      ...dependencies([]),
      checkCompatibility: async () => ({
        ok: false,
        error: { message: "incompatible v2 host" },
      }),
    });
    const context = {
      ...contextFixture({
        addedTools: [],
        addedSkills: [],
        contextHook: {},
        event: { type: "idle" },
      }),
      tool: { transform: () => Effect.sync(() => (transforms += 1)) },
      skill: { transform: () => Effect.sync(() => (transforms += 1)) },
    } as never;

    await expect(Effect.runPromise(Effect.scoped(plugin.effect(context)))).rejects.toThrow(
      "incompatible v2 host",
    );
    expect(transforms).toBe(0);
  });

  test("fails malformed plugin options before any transform is installed", async () => {
    let transforms = 0;
    const plugin = createOpenCodeV2Plugin(dependencies([]));
    const context = {
      ...contextFixture({
        addedTools: [],
        addedSkills: [],
        contextHook: {},
        event: { type: "idle" },
      }),
      options: { startupDeadlineMs: "invalid" },
      tool: { transform: () => Effect.sync(() => (transforms += 1)) },
    } as never;

    await expect(Effect.runPromise(Effect.scoped(plugin.effect(context)))).rejects.toThrow();
    expect(transforms).toBe(0);
  });
});

describe("legacy registration validation", () => {
  test("adds each bundled skill path and communicator tool once", () => {
    const config: Record<string, unknown> = {};
    registerBundledSkills(config);
    registerBundledSkills(config);
    registerCommunicatorPrimaryTools(config);
    registerCommunicatorPrimaryTools(config);

    const skills = config.skills as { paths: string[] };
    const experimental = config.experimental as { primary_tools: string[] };
    expect(skills.paths).toHaveLength(1);
    expect(experimental.primary_tools).toEqual([...communicatorToolIds]);
  });

  test("rejects malformed skill and primary-tool configuration fail closed", () => {
    for (const skills of [null, [], "bad"]) {
      expect(() => registerBundledSkills({ skills })).toThrow("skills configuration is malformed");
    }
    for (const paths of [null, ["valid", 1]]) {
      expect(() => registerBundledSkills({ skills: { paths } })).toThrow(
        "skill paths are malformed",
      );
    }
    for (const experimental of [null, [], "bad"]) {
      expect(() => registerCommunicatorPrimaryTools({ experimental })).toThrow(
        "experimental configuration is malformed",
      );
    }
    for (const primary_tools of [null, ["valid", 1]]) {
      expect(() => registerCommunicatorPrimaryTools({ experimental: { primary_tools } })).toThrow(
        "primary tool configuration is malformed",
      );
    }
  });
});
