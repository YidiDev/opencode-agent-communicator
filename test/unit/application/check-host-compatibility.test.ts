import { describe, expect, test } from "bun:test";

import { checkHostCompatibility } from "../../../src/application/check-host-compatibility";
import type { HostHealthPort } from "../../../src/domain/host";

function healthPort(value: unknown): HostHealthPort {
  return {
    async readHealth(): Promise<unknown> {
      return value;
    },
  };
}

describe("host compatibility", () => {
  test("accepts only the healthy exact pinned host", async () => {
    expect(await checkHostCompatibility(healthPort({ healthy: true, version: "1.18.21" }))).toEqual(
      {
        ok: true,
        value: { version: "1.18.21" },
      },
    );
  });

  test.each([
    ["missing health", undefined],
    ["null health", null],
    ["array health", []],
    ["missing healthy", { version: "1.18.21" }],
    ["false healthy", { healthy: false, version: "1.18.21" }],
    ["malformed healthy", { healthy: "true", version: "1.18.21" }],
    ["missing version", { healthy: true }],
    ["malformed version", { healthy: true, version: 11821 }],
    ["older host", { healthy: true, version: "1.18.20" }],
    ["newer host", { healthy: true, version: "1.18.22" }],
  ])("fails closed for %s", async (_label, health) => {
    expect(await checkHostCompatibility(healthPort(health))).toEqual({
      ok: false,
      error: {
        code: "incompatible_host",
        message: "The communicator requires a healthy OpenCode 1.18.21 host.",
        retryable: false,
      },
    });
  });

  test("does not leak a native fault or its cause", async () => {
    const secret = "transport contained a credential";
    const port: HostHealthPort = {
      async readHealth(): Promise<unknown> {
        throw new Error(secret);
      },
    };
    const result = await checkHostCompatibility(port);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
