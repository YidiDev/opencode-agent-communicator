import { describe, expect, test } from "bun:test";

import { parseCommunicatorOptions } from "../../../src/composition/config";
import { createCompositionFactory } from "../../../src/composition/plugin";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

const validatedWorkspaceKey = validateWorkspaceKey("host-compatibility");
if (!validatedWorkspaceKey.ok) throw new Error("Invalid workspace fixture.");
const workspaceKey = validatedWorkspaceKey.value;

const context = {
  options: {},
  location: { project: { canonical: "/workspace" }, directory: "/workspace" },
} as never;

function compatibilityProbe(health: unknown) {
  let nativeCreations = 0;
  const plugin = createCompositionFactory({
    parseOptions: (value) => parseCommunicatorOptions(value, { HOME: "/home/operator" }),
    deriveWorkspace: () => ({
      workspaceKey,
      projectId: "project",
      directory: "/workspace",
      worktree: "/workspace",
    }),
    createHealth: () => ({ readHealth: async () => health }),
    createNative(): never {
      nativeCreations += 1;
      throw new Error("compatible-host-proceeded");
    },
  });
  return { plugin, nativeCreations: () => nativeCreations };
}

describe("production OpenCode v2 compatibility", () => {
  test("host cancellation during compatibility prevents native resource creation", async () => {
    const host = new AbortController();
    let nativeCreations = 0;
    const plugin = createCompositionFactory({
      parseOptions: (value) => parseCommunicatorOptions(value, { HOME: "/home/operator" }),
      deriveWorkspace: () => ({
        workspaceKey,
        projectId: "project",
        directory: "/workspace",
        worktree: "/workspace",
      }),
      createHealth: () => ({ readHealth: async () => ({ healthy: true, version: "2.0.26" }) }),
      checkCompatibility: async (_identity, _health, control) => {
        host.abort();
        expect(control.abort.aborted).toBe(true);
        return { ok: true, value: { version: "2.0.26" } };
      },
      createNative: () => {
        nativeCreations += 1;
        throw new Error("unexpected native creation");
      },
    });
    await expect(plugin(context, host.signal)).rejects.toThrow();
    expect(nativeCreations).toBe(0);
  });
  test.each(["2.1.3", "2.1.4", "2.1.999"])("accepts supported stable patch %s", async (version) => {
    const probe = compatibilityProbe({ healthy: true, version });
    await expect(probe.plugin(context)).rejects.toThrow("compatible-host-proceeded");
    expect(probe.nativeCreations()).toBe(1);
  });

  test.each([
    "2.0.25",
    "2.0.26",
    "2.1.0",
    "2.1.2",
    "2.2.0",
    "2.1.03",
    "2.1.3-rc.1",
    "2.1.3+build.1",
    `2.1.${Number.MAX_SAFE_INTEGER + 1}`,
  ])("rejects unsupported or noncanonical host %s before native creation", async (version) => {
    const probe = compatibilityProbe({ healthy: true, version });
    await expect(probe.plugin(context)).rejects.toThrow(">=2.1.3 <2.2.0");
    expect(probe.nativeCreations()).toBe(0);
  });

  test("rejects an unhealthy otherwise-supported host", async () => {
    const probe = compatibilityProbe({ healthy: false, version: "2.1.4" });
    await expect(probe.plugin(context)).rejects.toThrow(">=2.1.3 <2.2.0");
    expect(probe.nativeCreations()).toBe(0);
  });
});
