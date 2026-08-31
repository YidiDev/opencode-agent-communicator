import { describe, expect, test } from "bun:test";
import { parseCommunicatorOptions } from "../../../src/composition/config";
import { createCompositionFactory } from "../../../src/composition/plugin";
import { domainFailure } from "../../../src/domain/results";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const workspace = validateWorkspaceKey("startup-diagnostic");
if (!workspace.ok) throw new Error("Invalid workspace fixture.");

describe("composition startup diagnostics", () => {
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
      createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "1.18.23" }) }),
      checkCompatibility: async () => ({ ok: true, value: { version: "1.18.23" } }),
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
    await expect(Reflect.apply(plugin, undefined, [{}, {}])).rejects.toThrow(diagnostic);
    expect(closes).toBe(1);
  });
});
