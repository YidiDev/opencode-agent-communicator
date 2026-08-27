import { describe, expect, test } from "bun:test";

import { createOpenCode11821HealthPort } from "../../../../src/adapters/native/opencode-1-18-21-health";

describe("pinned startup health malformed host envelopes", () => {
  const portFor = (response: unknown) =>
    createOpenCode11821HealthPort(
      { serverUrl: new URL("http://127.0.0.1"), directory: "/workspace" } as never,
      { createClient: () => ({ global: { health: async () => response } }) },
    );

  test.each([
    ["primitive envelope", "unavailable"],
    ["null envelope", null],
    ["array envelope", [{ healthy: true }]],
  ] as const)("preserves an exact %s without reading a data surface", async (_label, response) => {
    const port = portFor(response);

    expect(await port.readHealth()).toBe(response);
  });

  test.each([
    ["missing data", {}],
    ["primitive data", { data: false }],
    ["null data", { data: null }],
    ["array data", { data: [true, "1.18.21"] }],
  ] as const)("preserves an exact %s surface", async (_label, response) => {
    const port = portFor(response);

    expect(await port.readHealth()).toBe(Reflect.get(response, "data"));
  });
});
