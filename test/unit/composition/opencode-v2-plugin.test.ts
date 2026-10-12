import { describe, expect, test } from "bun:test";
import { communicatorToolIds } from "../../../src/composition/tools";
import plugin from "../../../src/index";

describe("OpenCode v2 plugin entrypoint", () => {
  test("exports the Effect plugin definition and preserves the complete tool manifest", () => {
    expect(plugin.id).toBe("opencode-agent-communicator");
    expect(plugin.effect).toBeFunction();
    expect(communicatorToolIds).toHaveLength(21);
    expect(new Set(communicatorToolIds).size).toBe(21);
  });
});
