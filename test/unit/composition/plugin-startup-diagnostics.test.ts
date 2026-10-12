import { describe, expect, test } from "bun:test";
import { parseCommunicatorOptions } from "../../../src/composition/config";
import { createCompositionFactory } from "../../../src/composition/plugin";
import { domainFailure } from "../../../src/domain/results";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("startup-diagnostic");
if (!workspace.ok) throw new Error("Invalid workspace fixture.");

function pluginContext() {
  return {
    options: {},
    location: { project: { canonical: "/" }, directory: "/" },
  } as never;
}

const invalidStartupClocks: ReadonlyArray<readonly [string, () => number]> = [
  [
    "throws",
    () => {
      throw new Error("clock detail");
    },
  ],
  ["is negative", () => -1],
  ["is non-integer", () => 1.5],
  ["is unsafe", () => Number.MAX_SAFE_INTEGER + 1],
  ["overflows after addition", () => Number.MAX_SAFE_INTEGER],
];

describe("composition startup diagnostics", () => {
  test.each(invalidStartupClocks)(
    "rejects before host or persistent effects when the startup clock %s",
    async (_name, clock) => {
      let health = 0;
      let compatibility = 0;
      let native = 0;
      let stores = 0;
      const plugin = createCompositionFactory({
        parseOptions: (value) => parseCommunicatorOptions(value, { HOME: "/home/operator" }),
        deriveWorkspace: () => ({
          workspaceKey: workspace.value,
          projectId: "project",
          directory: "/",
          worktree: "/",
        }),
        generationClock: { nowMs: clock },
        createHealth: () => {
          health += 1;
          return { readHealth: async () => ({}) };
        },
        checkCompatibility: async () => {
          compatibility += 1;
          return { ok: true, value: { version: "2.0.26" } };
        },
        createNative: () => {
          native += 1;
          return {} as never;
        },
        createStore: () => {
          stores += 1;
          return {} as never;
        },
      });

      await expect(plugin(pluginContext())).rejects.toThrow(
        "Communicator startup timing is invalid.",
      );
      expect({ health, compatibility, native, stores }).toEqual({
        health: 0,
        compatibility: 0,
        native: 0,
        stores: 0,
      });
    },
  );

  test("keeps generic startup ownership loss neutral and sanitized", async () => {
    let closes = 0;
    const plugin = createCompositionFactory({
      parseOptions: (value) => parseCommunicatorOptions(value, { HOME: "/home/operator" }),
      deriveWorkspace: () => ({
        workspaceKey: workspace.value,
        projectId: "project",
        directory: "/",
        worktree: "/",
      }),
      createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "2.0.26" }) }),
      checkCompatibility: async () => ({ ok: true, value: { version: "2.0.26" } }),
      createNative: () => ({}) as never,
      createStore: () =>
        ({
          starts: {},
          acquire: async () => {
            throw new Error("unclassified ownership loss /workspace");
          },
          close: () => {
            closes += 1;
          },
        }) as never,
      createRuntime: () =>
        ({ effectSignal: new AbortController().signal, stop: () => undefined }) as never,
      generationClock: { nowMs: () => 1_000 },
      recoverStartup: async ({ ownership }, options) => {
        expect(options.deadlineMs).toBe(31_000);
        await ownership.acquire().catch(() => undefined);
        return domainFailure("ownership_lost", "unsafe owner /workspace detail", false);
      },
    });

    const diagnostic = "Communicator ownership could not be established safely.";
    await expect(plugin(pluginContext())).rejects.toThrow(diagnostic);
    expect(closes).toBe(1);
  });
});
