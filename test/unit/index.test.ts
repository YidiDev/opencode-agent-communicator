import { describe, expect, test } from "bun:test";

import sessionCommunicatorPlugin from "../../src/index";

describe("package entrypoint", () => {
  test("exports an OpenCode plugin initializer", () => {
    expect(sessionCommunicatorPlugin).toBeInstanceOf(Function);
  });
});
