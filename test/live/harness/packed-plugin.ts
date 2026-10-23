import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import { cleanupAll } from "./cleanup";
import { runBoundedProcess } from "./process";

export interface PackedPluginInstallation {
  readonly packagePath: string;
  remove(): Promise<void>;
}

export const packedRuntimeDependenciesRootEnvironmentVariable =
  "OPENCODE_COMMUNICATOR_PACKED_RUNTIME_DEPENDENCIES_ROOT";

function inheritedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function dependencyRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("packed package runtime dependencies are unavailable");
  }
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    throw new Error("packed package runtime dependencies are malformed");
  }
  return Object.fromEntries(entries);
}

function dependencySegments(name: string): readonly string[] {
  const segments = name.split("/");
  const isUnscoped = segments.length === 1 && /^[a-z0-9][a-z0-9._-]*$/u.test(segments[0] ?? "");
  const isScoped =
    segments.length === 2 &&
    /^@[a-z0-9][a-z0-9._-]*$/u.test(segments[0] ?? "") &&
    /^[a-z0-9][a-z0-9._-]*$/u.test(segments[1] ?? "");
  if (!isUnscoped && !isScoped) throw new Error(`runtime dependency name is invalid: ${name}`);
  return segments;
}

async function readManifest(path: string, label: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    throw new Error(`${label} manifest is unavailable or malformed`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} manifest is malformed`);
  }
  return value as Record<string, unknown>;
}

interface ExposeRuntimeDependenciesOptions {
  readonly consumerNodeModules: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly runtimeDependenciesRoot: string;
}

export async function resolvePackedRuntimeDependenciesRoot(
  repository: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const override = environment[packedRuntimeDependenciesRootEnvironmentVariable];
  const candidate = override === undefined ? join(repository, "node_modules") : override;
  if (candidate.length === 0 || !isAbsolute(candidate)) {
    throw new Error(
      `${packedRuntimeDependenciesRootEnvironmentVariable} must be a non-empty absolute path`,
    );
  }
  try {
    const resolved = await realpath(candidate);
    if (!(await stat(resolved)).isDirectory()) throw new Error("path is not a directory");
    return resolved;
  } catch (error: unknown) {
    throw new Error(
      `${packedRuntimeDependenciesRootEnvironmentVariable} dependency root is unavailable`,
      { cause: error },
    );
  }
}

export async function exposeDeclaredRuntimeDependencies(
  options: ExposeRuntimeDependenciesOptions,
): Promise<void> {
  const verified = await Promise.all(
    Object.entries(options.dependencies).map(async ([name, expectedVersion]) => {
      const segments = dependencySegments(name);
      let source: string;
      try {
        source = await realpath(join(options.runtimeDependenciesRoot, ...segments));
      } catch (error: unknown) {
        throw new Error(`declared runtime dependency is unavailable: ${name}@${expectedVersion}`, {
          cause: error,
        });
      }
      const manifest = await readManifest(
        join(source, "package.json"),
        `runtime dependency ${name}`,
      );
      if (manifest.name !== name) {
        throw new Error(`runtime dependency manifest name mismatch for ${name}`);
      }
      if (manifest.version !== expectedVersion) {
        throw new Error(
          `runtime dependency version mismatch for ${name}: expected ${expectedVersion}, received ${String(manifest.version)}`,
        );
      }
      return { destination: join(options.consumerNodeModules, ...segments), source };
    }),
  );

  await mkdir(options.consumerNodeModules, { recursive: true });
  for (const dependency of verified) {
    await mkdir(dirname(dependency.destination), { recursive: true });
    await symlink(dependency.source, dependency.destination, "dir");
  }
}

function packedArchiveName(stdout: string): string {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch (error: unknown) {
    throw new Error("npm pack returned malformed JSON", { cause: error });
  }
  if (
    !Array.isArray(report) ||
    report.length !== 1 ||
    typeof report[0] !== "object" ||
    report[0] === null
  )
    throw new Error("npm pack returned no archive");
  const filename = Reflect.get(report[0], "filename");
  if (
    typeof filename !== "string" ||
    basename(filename) !== filename ||
    !filename.endsWith(".tgz")
  ) {
    throw new Error("npm pack returned an invalid archive name");
  }
  return filename;
}

export async function installPackedPlugin(repository: string): Promise<PackedPluginInstallation> {
  if (Bun.version !== "1.4.0") {
    throw new Error(`packed live install requires Bun 1.4.0, received ${Bun.version}`);
  }
  const staging = await mkdtemp(join(tmpdir(), "communicator-packed-live-"));
  try {
    const packed = await runBoundedProcess({
      command: "npm",
      arguments: ["pack", "--json", "--ignore-scripts", "--pack-destination", staging],
      cwd: repository,
      environment: inheritedEnvironment(),
      deadlineMs: 120_000,
    });
    if (packed.exitCode !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    const archive = join(staging, packedArchiveName(packed.stdout));
    const consumer = join(staging, "consumer");
    const consumerNodeModules = join(consumer, "node_modules");
    const packageDirectory = join(consumerNodeModules, "opencode-agent-communicator");
    await mkdir(packageDirectory, { recursive: true });
    const extracted = await runBoundedProcess({
      command: "tar",
      arguments: [
        "--extract",
        "--gzip",
        "--file",
        archive,
        "--directory",
        packageDirectory,
        "--strip-components=1",
        "--no-same-owner",
      ],
      cwd: staging,
      environment: inheritedEnvironment(),
      deadlineMs: 30_000,
    });
    if (extracted.exitCode !== 0) {
      throw new Error(`packed archive extraction failed: ${extracted.stderr}`);
    }
    const packageManifest = await readManifest(
      join(packageDirectory, "package.json"),
      "packed package",
    );
    if (packageManifest.name !== "opencode-agent-communicator") {
      throw new Error("packed package manifest name mismatch");
    }
    const runtimeDependenciesRoot = await resolvePackedRuntimeDependenciesRoot(repository);
    await exposeDeclaredRuntimeDependencies({
      consumerNodeModules,
      dependencies: dependencyRecord(packageManifest.dependencies),
      runtimeDependenciesRoot,
    });
    return {
      // Exercise the exact directory users configure, not a synthetic wrapper entrypoint.
      packagePath: await realpath(join(packageDirectory, "src")),
      async remove(): Promise<void> {
        await rm(staging, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await cleanupAll([() => rm(staging, { recursive: true, force: true })], error);
    throw new Error("unreachable packed plugin installation cleanup");
  }
}
