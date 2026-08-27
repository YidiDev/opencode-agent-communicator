import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  ExportChildProcess,
  ExportSpawnInput,
  ExportSpawnPort,
} from "../../../../src/adapters/export/bounded-bun-process";
import { LinuxExportRoot } from "../../../../src/adapters/export/linux-export-destination";
import { ExportPathError } from "../../../../src/adapters/export/linux-export-install";
import { OpenCodeCliExportAdapter } from "../../../../src/adapters/export/opencode-cli-export-adapter";
import { hasLinuxDescriptorInstall } from "../../../support/linux-export-capability";

const roots: string[] = [];
const sessionId = "ses_export" as never;

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function nativeOutput(id = sessionId, sanitized = true): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      info: {
        id,
        slug: "session",
        projectID: "project",
        title: sanitized ? `[redacted:session-title:${id}]` : "title",
        directory: sanitized ? `[redacted:session-directory:${id}]` : "/private",
        version: "1.18.21",
        time: { created: 1, updated: 2 },
      },
      messages: [
        {
          info: {
            id: "msg_1",
            sessionID: id,
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { providerID: "test", modelID: "test" },
          },
          parts: [{ id: "part_1", sessionID: id, messageID: "msg_1", type: "text", text: "hello" }],
        },
      ],
    }),
  );
}

class FakeSpawn implements ExportSpawnPort {
  readonly calls: ExportSpawnInput[] = [];
  version = new TextEncoder().encode("1.18.21\n");
  exported = nativeOutput();
  stderr = new Uint8Array();
  exitCode = 0;
  exportExitCode = 0;
  afterVersion?: () => void;
  afterExport?: () => void;
  retainVersionOutput = false;
  retainExportOutput = false;
  retainExit = false;
  readonly signals: number[] = [];
  private settleExit: ((code: number) => void) | undefined;

  spawn(input: ExportSpawnInput): ExportChildProcess {
    this.calls.push(input);
    const isVersion = input.arguments[0] === "--version";
    if (isVersion) this.afterVersion?.();
    else this.afterExport?.();
    return {
      pid: 99_999,
      stdout:
        (isVersion && this.retainVersionOutput) || (!isVersion && this.retainExportOutput)
          ? new ReadableStream({ pull: () => new Promise(() => {}) })
          : stream(isVersion ? this.version : this.exported),
      stderr: stream(this.stderr),
      exited: this.retainExit
        ? new Promise<number>((resolve) => {
            this.settleExit = resolve;
          })
        : Promise.resolve(isVersion ? this.exitCode : this.exportExitCode),
      kill: () => undefined,
    };
  }

  killTree(_child: ExportChildProcess, signal: number): void {
    this.signals.push(signal);
    if (signal === 9) this.settleExit?.(137);
  }
}

class FakeExportRoot {
  readonly chunks: Uint8Array[] = [];
  installOverwrite: boolean | undefined;
  discarded = false;
  closed = false;

  createTemporary() {
    return {
      descriptor: 1,
      write: (chunk: Uint8Array) => this.chunks.push(chunk.slice()),
      install: (overwrite: boolean) => {
        this.installOverwrite = overwrite;
      },
      discard: () => {
        this.discarded = true;
      },
    };
  }

  close(): void {
    this.closed = true;
  }
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "communicator-cli-export-"));
  roots.push(base);
  chmodSync(base, 0o700);
  // The adapter deliberately rejects the user-owned Bun binary used by npx. A root-owned ELF
  // fixture exercises version verification without weakening that production trust boundary.
  const executable = "/bin/true";
  const workspace = join(base, "workspace");
  const exportPath = join(base, "exports");
  mkdirSync(workspace, { mode: 0o700 });
  const spawn = new FakeSpawn();
  const root = LinuxExportRoot.open(exportPath);
  const adapter = new OpenCodeCliExportAdapter(root, {
    executablePath: executable,
    workspaceDirectory: workspace,
    environment: {
      HOME: base,
    },
    spawn,
    randomHex: () => "a".repeat(32),
    limits: { maximumOutputBytes: 4_096, maximumStderrBytes: 128 },
  });
  const input = {
    sessionId,
    sourceSessionId: sessionId,
    workspaceKey: "workspace:export" as never,
    destination: "nested/$(touch nope);x.json" as never,
    isSanitized: true,
    shouldOverwrite: false,
    abort: new AbortController().signal,
    deadlineMs: Date.now() + 10_000,
    fencingToken: 1 as never,
    guard: { check: async () => "current" as const },
  };
  return { adapter, spawn, executable, exportPath, input };
}

function adapterFixture() {
  const base = mkdtempSync(join(tmpdir(), "communicator-cli-export-unit-"));
  roots.push(base);
  chmodSync(base, 0o700);
  const workspace = join(base, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  const spawn = new FakeSpawn();
  const root = new FakeExportRoot();
  const configuration = {
    executablePath: "/bin/true",
    workspaceDirectory: workspace,
    environment: { HOME: base },
    spawn,
    randomHex: () => "b".repeat(32),
    limits: {
      maximumOutputBytes: 4_096,
      maximumStderrBytes: 128,
      maximumDurationMs: 5,
      terminationGraceMs: 1,
    },
  };
  const adapter = new OpenCodeCliExportAdapter(root as never, configuration);
  const input = {
    sessionId,
    sourceSessionId: sessionId,
    workspaceKey: "workspace:export" as never,
    destination: "capture.json" as never,
    isSanitized: true,
    shouldOverwrite: true,
    abort: new AbortController().signal,
    deadlineMs: Date.now() + 10_000,
    fencingToken: 1 as never,
    guard: { check: async () => "current" as const },
  };
  return { adapter, configuration, input, root, spawn };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("exact OpenCode CLI export adapter", () => {
  test.skipIf(!hasLinuxDescriptorInstall)(
    "verifies exact argv/minimal env and hashes installed bytes",
    async () => {
      const fake = fixture();
      using adapter = fake.adapter;
      const result = await adapter.writeExport(fake.input);
      expect(result).toMatchObject({ ok: true, byteCount: fake.spawn.exported.byteLength });
      expect(fake.spawn.calls.map((call) => call.arguments)).toEqual([
        ["--version"],
        ["export", "ses_export", "--sanitize"],
      ]);
      expect(fake.spawn.calls[0]?.command).toMatch(/^\/proc\/\d+\/fd\/\d+$/);
      expect(fake.spawn.calls[1]?.command).toBe(fake.spawn.calls[0]?.command);
      expect(fake.spawn.calls[1]?.environment).toEqual({
        HOME: expect.any(String),
        XDG_CONFIG_HOME: "/",
        OPENCODE_PURE: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      });
      expect(fake.spawn.calls[1]?.environment.PATH).toBeUndefined();
      expect(fake.spawn.calls[1]?.environment.NODE_OPTIONS).toBeUndefined();
      expect(fake.spawn.calls[1]?.environment.LD_PRELOAD).toBeUndefined();
      expect(readFileSync(join(fake.exportPath, "nested", "$(touch nope);x.json"))).toEqual(
        Buffer.from(fake.spawn.exported),
      );
    },
  );

  test("rejects wrong versions and an owner-mutable executable", async () => {
    const wrong = fixture();
    using wrongAdapter = wrong.adapter;
    wrong.spawn.version = new TextEncoder().encode("1.18.20\n");
    expect(await wrongAdapter.writeExport(wrong.input)).toEqual({
      ok: false,
      code: "export_unavailable",
    });
    expect(wrong.spawn.calls).toHaveLength(1);

    const mutable = fixture();
    using mutableAdapter = mutable.adapter;
    const mutablePath = join(dirname(mutable.exportPath), "mutable-opencode");
    writeFileSync(mutablePath, "replacement", { mode: 0o755 });
    Object.assign((mutableAdapter as unknown as { configuration: object }).configuration, {
      executablePath: mutablePath,
    });
    expect(await mutableAdapter.writeExport(mutable.input)).toEqual({
      ok: false,
      code: "export_unavailable",
    });
    expect(mutable.spawn.calls).toHaveLength(0);
  });

  test("rejects inherited runtime/config injection controls before spawn", async () => {
    for (const environment of [
      { HOME: "/tmp", NODE_OPTIONS: "--require=/evil" },
      { HOME: "/tmp", OPENCODE_CONFIG_CONTENT: '{"plugin":["/evil"]}' },
      { HOME: "/tmp", BUN_OPTIONS: "--preload=/evil" },
    ]) {
      const fake = fixture();
      using adapter = fake.adapter;
      Object.assign((adapter as unknown as { configuration: object }).configuration, {
        environment,
      });
      expect(await adapter.writeExport(fake.input)).toEqual({
        ok: false,
        code: "export_unavailable",
      });
      expect(fake.spawn.calls).toHaveLength(0);
    }
  });

  test.skipIf(!hasLinuxDescriptorInstall)(
    "rejects malformed, wrong-session, unsanitized, oversized stdout/stderr and cleans temp",
    async () => {
      const cases: Array<{
        readonly mutate: (spawn: FakeSpawn) => void;
        readonly code: "export_unavailable" | "export_limit_exceeded";
      }> = [
        {
          mutate: (spawn) => (spawn.exported = new TextEncoder().encode("{")),
          code: "export_unavailable",
        },
        {
          mutate: (spawn) => (spawn.exported = nativeOutput("ses_wrong" as never)),
          code: "export_unavailable",
        },
        {
          mutate: (spawn) => (spawn.exported = nativeOutput(sessionId, false)),
          code: "export_unavailable",
        },
        {
          mutate: (spawn) => (spawn.exported = new Uint8Array(4_097)),
          code: "export_limit_exceeded",
        },
        { mutate: (spawn) => (spawn.stderr = new Uint8Array(129)), code: "export_limit_exceeded" },
      ];
      for (const item of cases) {
        const fake = fixture();
        using adapter = fake.adapter;
        item.mutate(fake.spawn);
        expect(await adapter.writeExport(fake.input)).toEqual({ ok: false, code: item.code });
        expect(() =>
          readFileSync(join(fake.exportPath, "nested", "$(touch nope);x.json")),
        ).toThrow();
      }
    },
  );

  test.skipIf(!hasLinuxDescriptorInstall)(
    "omits sanitize argv only for approved unsanitized mode",
    async () => {
      const fake = fixture();
      using adapter = fake.adapter;
      fake.spawn.exported = nativeOutput(sessionId, false);
      expect(await adapter.writeExport({ ...fake.input, isSanitized: false })).toMatchObject({
        ok: true,
      });
      expect(fake.spawn.calls[1]?.arguments).toEqual(["export", "ses_export"]);
    },
  );

  test.skipIf(!hasLinuxDescriptorInstall)(
    "verifies each invocation and rejects writable CLI locations",
    async () => {
      const repeated = fixture();
      using repeatedAdapter = repeated.adapter;
      expect(await repeatedAdapter.writeExport(repeated.input)).toMatchObject({ ok: true });
      expect(
        await repeatedAdapter.writeExport({
          ...repeated.input,
          destination: "second.json" as never,
        }),
      ).toMatchObject({ ok: true });
      expect(repeated.spawn.calls.map((call) => call.arguments[0])).toEqual([
        "--version",
        "export",
        "--version",
        "export",
      ]);

      const writable = fixture();
      using writableAdapter = writable.adapter;
      const writablePath = join(dirname(writable.exportPath), "writable-opencode");
      writeFileSync(writablePath, "fixture", { mode: 0o755 });
      Object.assign((writableAdapter as unknown as { configuration: object }).configuration, {
        executablePath: writablePath,
      });
      expect(await writableAdapter.writeExport(writable.input)).toEqual({
        ok: false,
        code: "export_unavailable",
      });
      expect(writable.spawn.calls).toHaveLength(0);
    },
  );
});

describe("OpenCode CLI export staging", () => {
  test("streams validated bytes to a temporary and installs only after all guards pass", async () => {
    const fake = adapterFixture();
    const result = await fake.adapter.writeExport(fake.input);
    expect(result).toEqual({
      ok: true,
      byteCount: fake.spawn.exported.byteLength,
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Buffer.concat(fake.root.chunks.map((chunk) => Buffer.from(chunk)))).toEqual(
      Buffer.from(fake.spawn.exported),
    );
    expect(fake.root.installOverwrite).toBe(true);
    expect(fake.root.discarded).toBe(false);
    fake.adapter[Symbol.dispose]();
    fake.adapter[Symbol.dispose]();
    expect(fake.root.closed).toBe(true);
  });

  test("aborts and drains a TERM-resistant owned process before closing the export root", async () => {
    const fake = adapterFixture();
    fake.spawn.retainVersionOutput = true;
    fake.spawn.retainExit = true;
    const operation = fake.adapter.writeExport(fake.input);
    while (fake.spawn.calls.length === 0) await Promise.resolve();

    const drain = fake.adapter.drain();
    expect(fake.root.closed).toBe(false);
    await drain;
    expect(fake.spawn.signals).toEqual([15, 9]);
    expect(await operation).toEqual({ ok: false, code: "native_outcome_unknown" });

    fake.adapter[Symbol.dispose]();
    expect(fake.root.closed).toBe(true);
  });

  test("discards staged data when native output is malformed or the CLI exits unsuccessfully", async () => {
    for (const mutate of [
      (spawn: FakeSpawn) => (spawn.exported = new TextEncoder().encode("{")),
      (spawn: FakeSpawn) => (spawn.exportExitCode = 2),
    ]) {
      const fake = adapterFixture();
      using adapter = fake.adapter;
      mutate(fake.spawn);
      expect(await adapter.writeExport(fake.input)).toEqual({
        ok: false,
        code: "export_unavailable",
      });
      expect(fake.root.installOverwrite).toBeUndefined();
      expect(fake.root.discarded).toBe(true);
    }
  });

  test("fails closed when executable identity or visibility changes during verification", async () => {
    const identity = adapterFixture();
    using identityAdapter = identity.adapter;
    identity.spawn.afterVersion = () => {
      Object.assign(identity.configuration, { executablePath: "/etc/passwd" });
    };
    expect(await identityAdapter.writeExport(identity.input)).toEqual({
      ok: false,
      code: "export_unavailable",
    });
    expect(identity.spawn.calls).toHaveLength(1);

    const visibility = adapterFixture();
    using visibilityAdapter = visibility.adapter;
    let checks = 0;
    const input = {
      ...visibility.input,
      guard: {
        check: async () => {
          checks += 1;
          return checks < 3 ? ("current" as const) : ("target_not_visible" as const);
        },
      },
    };
    expect(await visibilityAdapter.writeExport(input)).toEqual({
      ok: false,
      code: "native_outcome_unknown",
    });
    expect(visibility.spawn.calls).toHaveLength(1);
  });

  test("maps temporary creation faults without retaining transcript chunks", async () => {
    const fake = adapterFixture();
    using adapter = fake.adapter;
    fake.root.createTemporary = () => {
      throw new Error("disk offline");
    };
    expect(await adapter.writeExport(fake.input)).toEqual({
      ok: false,
      code: "storage_unavailable",
    });
    expect(fake.root.chunks).toEqual([]);
  });
});

describe("OpenCode CLI export staged boundaries", () => {
  test("rejects inactive, unsafe, and rate-limited requests before native export", async () => {
    const inactive = adapterFixture();
    using inactiveAdapter = inactive.adapter;
    expect(
      await inactiveAdapter.writeExport({ ...inactive.input, deadlineMs: Date.now() - 1 }),
    ).toEqual({ ok: false, code: "export_limit_exceeded" });
    expect(inactive.spawn.calls).toEqual([]);

    const unsafe = adapterFixture();
    using unsafeAdapter = unsafe.adapter;
    expect(
      await unsafeAdapter.writeExport({ ...unsafe.input, destination: "../escape" as never }),
    ).toEqual({
      ok: false,
      code: "unsafe_path",
    });
    expect(unsafe.spawn.calls).toEqual([]);

    const limited = adapterFixture();
    using limitedAdapter = limited.adapter;
    Object.assign(limitedAdapter as unknown as { limiter: unknown }, {
      limiter: new (
        await import("../../../../src/adapters/export/export-limits")
      ).ProcessLocalExportLimiter(1, 1, 1),
    });
    expect(await limitedAdapter.writeExport(limited.input)).toMatchObject({ ok: true });
    expect(await limitedAdapter.writeExport(limited.input)).toEqual({
      ok: false,
      code: "export_limit_exceeded",
    });
  });

  test("honors each guard before creating, capturing, installing, and reporting output", async () => {
    for (const [failedCheck, code] of [
      [1, "caller_not_visible"],
      [2, "target_not_visible"],
      [4, "ownership_lost"],
      [5, "export_unavailable"],
      [7, "target_not_visible"],
      [8, "ownership_lost"],
    ] as const) {
      const fake = adapterFixture();
      using adapter = fake.adapter;
      let checks = 0;
      const input = {
        ...fake.input,
        guard: {
          check: async () => {
            checks += 1;
            return checks === failedCheck ? code : ("current" as const);
          },
        },
      };
      expect(await adapter.writeExport(input)).toEqual({
        ok: false,
        code: failedCheck === 8 ? "native_outcome_unknown" : code,
      });
      expect(fake.root.installOverwrite).toBe(failedCheck === 8 ? true : undefined);
    }
  });

  test("classifies bounded version and export output failures", async () => {
    const versionLimit = adapterFixture();
    using versionLimitAdapter = versionLimit.adapter;
    versionLimit.spawn.version = new Uint8Array(65);
    expect(await versionLimitAdapter.writeExport(versionLimit.input)).toEqual({
      ok: false,
      code: "export_limit_exceeded",
    });

    const versionTimeout = adapterFixture();
    using versionTimeoutAdapter = versionTimeout.adapter;
    versionTimeout.spawn.retainVersionOutput = true;
    expect(await versionTimeoutAdapter.writeExport(versionTimeout.input)).toEqual({
      ok: false,
      code: "native_outcome_unknown",
    });

    const exportLimit = adapterFixture();
    using exportLimitAdapter = exportLimit.adapter;
    exportLimit.spawn.exported = new Uint8Array(4_097);
    expect(await exportLimitAdapter.writeExport(exportLimit.input)).toEqual({
      ok: false,
      code: "export_limit_exceeded",
    });
    expect(exportLimit.root.discarded).toBe(true);

    const exportTimeout = adapterFixture();
    using exportTimeoutAdapter = exportTimeout.adapter;
    exportTimeout.spawn.retainExportOutput = true;
    expect(await exportTimeoutAdapter.writeExport(exportTimeout.input)).toEqual({
      ok: false,
      code: "native_outcome_unknown",
    });
  });

  test("stops when deadlines expire at each staged effect boundary", async () => {
    for (const abortAtCheck of [4, 5, 7]) {
      const fake = adapterFixture();
      using adapter = fake.adapter;
      const controller = new AbortController();
      let checks = 0;
      expect(
        await adapter.writeExport({
          ...fake.input,
          abort: controller.signal,
          guard: {
            check: async () => {
              checks += 1;
              if (checks === abortAtCheck) controller.abort();
              return "current" as const;
            },
          },
        }),
      ).toEqual({ ok: false, code: "export_limit_exceeded" });
    }
  });

  test("supports explicitly approved unsanitized staging and refuses use after disposal", async () => {
    const unsanitized = adapterFixture();
    using unsanitizedAdapter = unsanitized.adapter;
    unsanitized.spawn.exported = nativeOutput(sessionId, false);
    expect(
      await unsanitizedAdapter.writeExport({ ...unsanitized.input, isSanitized: false }),
    ).toMatchObject({ ok: true });
    expect(unsanitized.spawn.calls[1]?.arguments).toEqual(["export", "ses_export"]);

    const disposed = adapterFixture();
    disposed.adapter[Symbol.dispose]();
    expect(await disposed.adapter.writeExport(disposed.input)).toEqual({
      ok: false,
      code: "export_unavailable",
    });
  });

  test("fails closed when executable identity changes after capture and preserves path errors", async () => {
    const identity = adapterFixture();
    using identityAdapter = identity.adapter;
    identity.spawn.afterExport = () =>
      Object.assign(identity.configuration, { executablePath: "/etc/passwd" });
    expect(await identityAdapter.writeExport(identity.input)).toEqual({
      ok: false,
      code: "native_outcome_unknown",
    });

    const path = adapterFixture();
    using pathAdapter = path.adapter;
    path.root.createTemporary = () => {
      throw new ExportPathError("destination_exists");
    };
    expect(await pathAdapter.writeExport(path.input)).toEqual({
      ok: false,
      code: "destination_exists",
    });
  });
});
