import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { exactOpenCodeVersion } from "./constants";

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly bin?: unknown;
}

function isContained(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function resolveExactProjectCli(projectRoot: string): Promise<string> {
  projectRoot = process.env.OPENCODE_COMPAT_CLI_ROOT ?? projectRoot;
  const packageDirectory = await realpath(join(projectRoot, "node_modules", "@opencode", "cli"));
  const expectedDirectory = await realpath(join(projectRoot, "node_modules"));
  if (!isContained(expectedDirectory, packageDirectory)) {
    throw new Error("@opencode/cli resolved outside project node_modules");
  }

  const manifestText = await readFile(join(packageDirectory, "package.json"), "utf8");
  const manifest: PackageManifest = JSON.parse(manifestText);
  if (manifest.name !== "@opencode/cli" || manifest.version !== exactOpenCodeVersion) {
    throw new Error(`expected project-local @opencode/cli ${exactOpenCodeVersion}`);
  }
  if (
    typeof manifest.bin !== "object" ||
    manifest.bin === null ||
    !("opencode" in manifest.bin) ||
    typeof manifest.bin.opencode !== "string"
  ) {
    throw new Error("@opencode/cli does not declare the expected CLI binary");
  }

  const cliPath = await realpath(join(packageDirectory, manifest.bin.opencode));
  if (!isContained(packageDirectory, cliPath)) {
    throw new Error("opencode CLI resolved outside its exact package");
  }
  return cliPath;
}
