import { describe, expect, test } from "bun:test";
import { parseCommunicatorOptions } from "../../../src/composition/config";

describe("communicator PluginOptions", () => {
  test("applies safe PLAN policy defaults outside the workspace", () => {
    const options = parseCommunicatorOptions({}, { HOME: "/home/operator" });
    expect(options.stateDirectory).toBe("/home/operator/.local/state/opencode-agent-communicator");
    expect(options.startupDeadlineMs).toBe(30_000);
    expect(options.invocationDeadlineMs).toBe(3_600_000);
  });

  test("rejects unknown keys, relative paths, partial export trust, and hard-ceiling excess", () => {
    expect(() => parseCommunicatorOptions({ mystery: true }, { HOME: "/home/operator" })).toThrow();
    expect(() => parseCommunicatorOptions({ stateDirectory: "state" }, {})).toThrow();
    expect(() =>
      parseCommunicatorOptions({ export: { root: "/safe/export" } }, { HOME: "/home/operator" }),
    ).toThrow();
    expect(() =>
      parseCommunicatorOptions({ startupDeadlineMs: 60_001 }, { HOME: "/home/operator" }),
    ).toThrow();
    expect(() =>
      parseCommunicatorOptions({ policies: { message: "allow", extra: "deny" } }, {}),
    ).toThrow();
    expect(() => parseCommunicatorOptions({ start: { limits: { extra: 1 } } }, {})).toThrow();
    expect(() => parseCommunicatorOptions({}, {})).toThrow("private absolute stateDirectory");
  });

  test("accepts the documented policy and bounded start/export configuration", () => {
    const options = parseCommunicatorOptions(
      {
        stateDirectory: "/var/lib/communicator",
        policies: { message: "ask", ask: "deny", wait: "allow", start: "allow" },
        start: { allowedAgents: ["build"], allowedModels: ["provider/model"] },
        export: {
          root: "/var/lib/communicator-exports",
          executable: "/usr/bin/opencode",
          trustedWorkingDirectory: "/var/empty",
          limits: { maximumConcurrent: 1 },
        },
      },
      {},
    );
    expect(options.policies?.start).toBe("allow");
    expect(options.export?.limits?.maximumConcurrent).toBe(1);
  });

  test("rejects HOME and broad system roots instead of changing their modes", () => {
    for (const stateDirectory of ["/home/operator", "/etc", "/var", "/tmp"]) {
      expect(() =>
        parseCommunicatorOptions({ stateDirectory }, { HOME: "/home/operator" }),
      ).toThrow("dedicated");
    }
    expect(() =>
      parseCommunicatorOptions(
        {
          export: {
            root: "/etc",
            executable: "/usr/bin/opencode",
            trustedWorkingDirectory: "/var/empty",
          },
        },
        { HOME: "/home/operator" },
      ),
    ).toThrow("dedicated");
  });
});
