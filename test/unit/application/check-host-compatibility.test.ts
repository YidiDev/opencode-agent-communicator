import { describe, expect, test } from "bun:test";

import { checkHostCompatibility } from "../../../src/application/check-host-compatibility";
import type { HostHealthPort, RuntimeIdentityPort } from "../../../src/domain/host";

const exactRuntime: RuntimeIdentityPort = {
  readIdentity: () => ({ platform: "linux", architecture: "x64", bunVersion: "1.4.0" }),
};

function healthPort(value: unknown): HostHealthPort {
  return {
    async readHealth(): Promise<unknown> {
      return value;
    },
  };
}

describe("host compatibility", () => {
  test.each(["1.18.21", "1.18.23", "1.18.999"])(
    "accepts a healthy supported patch host at %s",
    async (version) => {
      expect(
        await checkHostCompatibility(exactRuntime, healthPort({ healthy: true, version })),
      ).toEqual({
        ok: true,
        value: { version },
      });
    },
  );

  test.each([
    ["wrong platform", { platform: "darwin", architecture: "x64", bunVersion: "1.4.0" }],
    ["malformed platform", { platform: 1, architecture: "x64", bunVersion: "1.4.0" }],
    ["wrong architecture", { platform: "linux", architecture: "arm64", bunVersion: "1.4.0" }],
    ["malformed architecture", { platform: "linux", architecture: null, bunVersion: "1.4.0" }],
    ["malformed identity", "linux-x64"],
    ["null identity", null],
    ["array identity", []],
  ])("fails closed for %s without reading host health", async (_label, identity) => {
    let healthReads = 0;
    const result = await checkHostCompatibility(
      { readIdentity: () => identity },
      {
        async readHealth(): Promise<unknown> {
          healthReads += 1;
          return { healthy: true, version: "1.18.23" };
        },
      },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "incompatible_host",
        message:
          "The communicator requires Linux x64 and a healthy OpenCode >=1.18.21 <1.19.0 host.",
        retryable: false,
      },
    });
    expect(healthReads).toBe(0);
  });

  test.each([
    ["missing health", undefined],
    ["null health", null],
    ["array health", []],
    ["missing healthy", { version: "1.18.23" }],
    ["false healthy", { healthy: false, version: "1.18.23" }],
    ["malformed healthy", { healthy: "true", version: "1.18.23" }],
    ["missing version", { healthy: true }],
    ["malformed version", { healthy: true, version: 11823 }],
    ["older host", { healthy: true, version: "1.18.20" }],
    ["next minor", { healthy: true, version: "1.19.0" }],
    ["next major", { healthy: true, version: "2.0.0" }],
    ["prerelease", { healthy: true, version: "1.18.24-beta.1" }],
    ["build metadata", { healthy: true, version: "1.18.24+build" }],
    ["noncanonical patch", { healthy: true, version: "1.18.021" }],
    ["unsafe patch integer", { healthy: true, version: `1.18.${Number.MAX_SAFE_INTEGER + 1}` }],
  ])("fails closed for %s", async (_label, health) => {
    expect(await checkHostCompatibility(exactRuntime, healthPort(health))).toEqual({
      ok: false,
      error: {
        code: "incompatible_host",
        message:
          "The communicator requires Linux x64 and a healthy OpenCode >=1.18.21 <1.19.0 host.",
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
    const result = await checkHostCompatibility(exactRuntime, port);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("does not confuse OpenCode's embedded Bun with the package installer version", async () => {
    expect(
      await checkHostCompatibility(
        {
          readIdentity: () => ({ platform: "linux", architecture: "x64", bunVersion: "embedded" }),
        },
        healthPort({ healthy: true, version: "1.18.23" }),
      ),
    ).toMatchObject({ ok: true });
  });

  test("does not expose runtime identity faults", async () => {
    const secret = "runtime identity included a private environment value";
    const result = await checkHostCompatibility(
      {
        readIdentity(): never {
          throw new Error(secret);
        },
      },
      healthPort({ healthy: true, version: "1.18.23" }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "incompatible_host" } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("bounds startup health and observes a rejection that loses the deadline race", async () => {
    let rejectLate: ((cause: unknown) => void) | undefined;
    const pending = new Promise<unknown>((_resolve, reject) => {
      rejectLate = reject;
    });
    const result = await checkHostCompatibility(
      exactRuntime,
      { readHealth: () => pending },
      { abort: new AbortController().signal, deadlineMs: Date.now() + 5 },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "incompatible_host" } });
    rejectLate?.(new Error("late health transport rejection"));
    await Promise.resolve();
  });
});
