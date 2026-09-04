import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupAll } from "./cleanup";
import { runBoundedProcess } from "./process";

export interface PackedPluginInstallation {
  readonly entryPath: string;
  remove(): Promise<void>;
}

function inheritedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function offlineEnvironment(): Record<string, string> {
  const environment = inheritedEnvironment();
  // Bun 1.4 may still resolve missing manifests with --offline; sink every proxy to fail closed.
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    environment[name] = "http://127.0.0.1:9";
  }
  environment.NO_PROXY = "";
  environment.no_proxy = "";
  return environment;
}

function dependencyRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("project package dependencies are unavailable");
  }
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    throw new Error("project package dependencies are malformed");
  }
  return Object.fromEntries(entries);
}

export async function installPackedPlugin(repository: string): Promise<PackedPluginInstallation> {
  if (Bun.version !== "1.4.0") {
    throw new Error(`packed live install requires Bun 1.4.0, received ${Bun.version}`);
  }
  const staging = await mkdtemp(join(tmpdir(), "communicator-packed-live-"));
  try {
    const packed = await runBoundedProcess({
      command: "npm",
      arguments: ["pack", "--json", "--pack-destination", staging],
      cwd: repository,
      environment: inheritedEnvironment(),
      deadlineMs: 120_000,
    });
    if (packed.exitCode !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    const report = JSON.parse(packed.stdout) as Array<{ filename?: string }>;
    const archive = join(staging, report[0]?.filename ?? "missing.tgz");
    const consumer = join(staging, "consumer");
    await mkdir(consumer);
    const projectPackage: unknown = JSON.parse(
      await Bun.file(join(repository, "package.json")).text(),
    );
    if (
      typeof projectPackage !== "object" ||
      projectPackage === null ||
      Array.isArray(projectPackage)
    ) {
      throw new Error("project package manifest is malformed");
    }
    await Bun.write(
      join(consumer, "package.json"),
      `${JSON.stringify({
        ...projectPackage,
        name: "packed-live-consumer",
        private: true,
        dependencies: {
          ...dependencyRecord(Reflect.get(projectPackage, "dependencies")),
          "opencode-agent-communicator": archive,
        },
      })}\n`,
    );
    await Bun.write(join(consumer, "bun.lock"), Bun.file(join(repository, "bun.lock")));
    const installed = await runBoundedProcess({
      command: process.execPath,
      arguments: ["install", "--offline", "--ignore-scripts", "--no-progress", "--no-summary"],
      cwd: consumer,
      environment: offlineEnvironment(),
      deadlineMs: 120_000,
    }).catch((error: unknown) => {
      throw new Error(
        "Bun offline packed install did not complete; ensure bun install --frozen-lockfile " +
          "has warmed the project dependency cache",
        { cause: error },
      );
    });
    if (installed.exitCode !== 0) {
      throw new Error(
        `Bun offline packed install failed with exit ${installed.exitCode}; run the project ` +
          `bun install --frozen-lockfile first to warm the dependency cache: ${installed.stderr}`,
      );
    }
    return {
      entryPath: await realpath(
        join(consumer, "node_modules/opencode-agent-communicator/src/index.ts"),
      ),
      async remove(): Promise<void> {
        await rm(staging, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await cleanupAll([() => rm(staging, { recursive: true, force: true })], error);
    throw new Error("unreachable packed plugin installation cleanup");
  }
}
