import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("packed npm archive", () => {
  test("installs and loads the Bun TypeScript plugin entry", async () => {
    const repository = resolve(import.meta.dir, "../..");
    const staging = await mkdtemp(join(tmpdir(), "communicator-package-"));
    temporaryDirectories.push(staging);

    const packed = Bun.spawnSync({
      cmd: ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", staging],
      cwd: repository,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(packed.exitCode).toBe(0);
    const report = JSON.parse(packed.stdout.toString()) as Array<{ filename: string }>;
    const archive = join(staging, report[0]?.filename ?? "missing.tgz");

    const consumer = join(staging, "consumer");
    await mkdir(consumer);
    await Bun.write(
      join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { "opencode-agent-communicator": archive },
      }),
    );
    const installed = Bun.spawnSync({
      cmd: [process.execPath, "install", "--ignore-scripts"],
      cwd: consumer,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(installed.exitCode).toBe(0);

    const expectedToolIds = [
      "session_list",
      "session_send",
      "session_delivery_get",
      "session_ask",
      "session_respond",
      "session_wait",
      "session_signal",
      "session_request_list",
      "session_request_get",
      "session_request_ack",
      "session_request_cancel",
      "session_stop",
      "session_start",
      "session_export",
    ];
    const loaded = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        [
          'import plugin from "opencode-agent-communicator";',
          'import { communicatorToolIds } from "./node_modules/opencode-agent-communicator/src/composition/tools.ts";',
          'if (typeof plugin !== "function") throw new Error("default export is not a plugin function");',
          `if (JSON.stringify(communicatorToolIds) !== ${JSON.stringify(JSON.stringify(expectedToolIds))})`,
          `  throw new Error(\`unexpected tool IDs: \${JSON.stringify(communicatorToolIds)}\`);`,
        ].join("\n"),
      ],
      cwd: consumer,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(loaded.exitCode).toBe(0);

    const installedRoot = join(consumer, "node_modules/opencode-agent-communicator");
    const metadata = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")) as {
      version: string;
      exports: Record<string, string>;
      os: string[];
      cpu: string[];
    };
    expect(metadata).toMatchObject({
      version: "0.1.1",
      exports: { ".": "./src/index.ts" },
      os: ["linux"],
      cpu: ["x64"],
    });
    expect(
      await readFile(join(installedRoot, "skills/session-orchestrator/SKILL.md"), "utf8"),
    ).toContain("session_start");
    expect(await readFile(join(installedRoot, "docs/plugin-configuration.md"), "utf8")).toContain(
      ">=1.18.21 <1.19.0",
    );
  }, 60_000);
});
