import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";

import type { ExportSpawnPort } from "./bounded-bun-process";
import type { SessionExportLimits } from "./export-limits";

export interface OpenCodeCliExportConfiguration {
  readonly executablePath: string;
  readonly workspaceDirectory: string;
  readonly trustedWorkingDirectory?: string;
  readonly pluginDirectories?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly limits?: Partial<SessionExportLimits>;
  readonly spawn?: ExportSpawnPort;
  readonly randomHex?: () => string;
}

export interface ExecutableIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

function isContained(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export function executableIdentity(
  configuration: OpenCodeCliExportConfiguration,
): ExecutableIdentity {
  if (!isAbsolute(configuration.executablePath)) throw new Error("PATH-only CLI is forbidden.");
  const path = realpathSync(configuration.executablePath);
  const untrusted = [
    configuration.workspaceDirectory,
    ...(configuration.pluginDirectories ?? []),
  ].map((value) => realpathSync(value));
  if (untrusted.some((value) => isContained(value, path))) throw new Error("Untrusted CLI path.");
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) {
    throw new Error("OpenCode CLI is not on a root-owned trusted chain.");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const magic = Buffer.alloc(4);
    if (
      readSync(descriptor, magic, 0, magic.length, 0) !== 4 ||
      !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    ) {
      throw new Error("OpenCode CLI must be a directly trusted ELF executable.");
    }
  } finally {
    closeSync(descriptor);
  }
  let parent = dirname(path);
  for (;;) {
    const value = statSync(parent, { bigint: true });
    if (!value.isDirectory() || value.uid !== 0n || (value.mode & 0o022n) !== 0n) {
      throw new Error("OpenCode CLI parent is writable.");
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return { path, device: stat.dev, inode: stat.ino };
}

export function sameExecutable(first: ExecutableIdentity, second: ExecutableIdentity): boolean {
  return (
    first.path === second.path && first.device === second.device && first.inode === second.inode
  );
}

export function prepareExactExecutable(
  configuration: OpenCodeCliExportConfiguration,
): { identity: ExecutableIdentity; descriptor: number; command: string } | undefined {
  let descriptor: number | undefined;
  try {
    const identity = executableIdentity(configuration);
    descriptor = openSync(identity.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.dev !== identity.device || stat.ino !== identity.inode) {
      return undefined;
    }
    const retained = descriptor;
    descriptor = undefined;
    return { identity, descriptor: retained, command: `/proc/${process.pid}/fd/${retained}` };
  } catch {
    return undefined;
  } finally {
    closeOptionalDescriptor(descriptor);
  }
}

export function closeOptionalDescriptor(descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // A retained executable descriptor contains no transcript data.
  }
}

const allowedStateEnvironment = new Set([
  "HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
]);
const rejectedEnvironment =
  /^(?:OPENCODE_CONFIG|NODE_OPTIONS$|BUN_OPTIONS$|BUN_RUNTIME_TRANSPILER_CACHE_PATH$|LD_|DYLD_|NODE_PATH$|BUN_INSTALL$)/;

export function allowlistedStateEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of allowedStateEnvironment) {
    const value = input[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export function minimalEnvironment(
  input: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value !== "string" || rejectedEnvironment.test(key)) throw new Error("Unsafe env.");
    if (allowedStateEnvironment.has(key)) result[key] = value;
  }
  return {
    ...result,
    XDG_CONFIG_HOME: "/",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  };
}

export function trustedWorkingDirectory(configuration: OpenCodeCliExportConfiguration): string {
  const path = realpathSync(configuration.trustedWorkingDirectory ?? "/");
  const stat = statSync(path, { bigint: true });
  const workspace = realpathSync(configuration.workspaceDirectory);
  const plugins = (configuration.pluginDirectories ?? []).map((value) => realpathSync(value));
  if (
    !stat.isDirectory() ||
    stat.uid !== 0n ||
    (stat.mode & 0o022n) !== 0n ||
    isContained(workspace, path) ||
    plugins.some((value) => isContained(value, path))
  ) {
    throw new Error("Export cwd is not trusted.");
  }
  let ancestor = dirname(path);
  for (;;) {
    const value = statSync(ancestor, { bigint: true });
    if (!value.isDirectory() || value.uid !== 0n || (value.mode & 0o022n) !== 0n) {
      throw new Error("Export cwd ancestor is not trusted.");
    }
    const next = dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  return path;
}

export interface PreparedTrustedWorkingDirectory {
  readonly path: string;
  readonly descriptor: number;
  readonly commandPath: string;
}

export function prepareTrustedWorkingDirectory(
  configuration: OpenCodeCliExportConfiguration,
): PreparedTrustedWorkingDirectory {
  const path = trustedWorkingDirectory(configuration);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    const expected = statSync(path, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error("Export cwd identity changed.");
    }
    const retained = descriptor;
    descriptor = undefined;
    return { path, descriptor: retained, commandPath: `/proc/${process.pid}/fd/${retained}` };
  } finally {
    closeOptionalDescriptor(descriptor);
  }
}
