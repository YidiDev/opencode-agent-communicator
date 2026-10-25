import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function releaseVersion(value) {
  const match =
    typeof value === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/.exec(value);
  if (
    !match ||
    match[0] !== value ||
    Number(match[1]) < 1 ||
    match.slice(1).some((v) => v !== undefined && !Number.isSafeInteger(Number(v)))
  )
    throw new Error("Release version must be canonical SemVer >=1, stable or rc.N");
  return {
    version: value,
    tag: `v${value}`,
    prerelease: match[4] !== undefined,
    distTag: match[4] ? "next" : "latest",
  };
}

export function assertStableReadiness(version, readiness, digest) {
  if (releaseVersion(version).prerelease) return;
  if (
    readiness?.schema_version !== 1 ||
    readiness.stable_approved !== true ||
    readiness.soak?.result !== "passed" ||
    !Number.isFinite(readiness.soak.duration_hours) ||
    readiness.soak.duration_hours < 48 ||
    readiness.soak.runtime_sha256 !== digest ||
    !/^[0-9a-f]{64}$/.test(digest) ||
    !/^https:\/\/github\.com\/YidiDev\/opencode-agent-communicator\//.test(
      readiness.soak.report_url ?? "",
    )
  ) {
    throw new Error(
      "Stable publishing requires reviewed passing 48-hour soak evidence for this runtime",
    );
  }
}

export async function runtimeDigest(root) {
  const hash = createHash("sha256");
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error("Runtime digest refuses symlinks");
      if (metadata.isDirectory()) await visit(path);
      else if (metadata.isFile())
        hash
          .update(relative(root, path))
          .update("\0")
          .update(await readFile(path))
          .update("\0");
      else throw new Error("Runtime digest refuses non-regular source");
    }
  }
  await visit(join(root, "src"));
  await visit(join(root, "skills"));
  hash.update(await readFile(join(root, "bun.lock")));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  for (const key of [
    "dependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "engines",
    "trustedDependencies",
    "exports",
    "main",
    "type",
    "files",
    "os",
    "cpu",
  ])
    hash.update(key).update(JSON.stringify(manifest[key] ?? null));
  return hash.digest("hex");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = process.cwd();
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const release = releaseVersion(metadata.version);
  const readiness = JSON.parse(await readFile(join(root, "release-readiness.json"), "utf8"));
  const digest = await runtimeDigest(root);
  assertStableReadiness(metadata.version, readiness, digest);
  console.log(JSON.stringify({ ...release, runtime_sha256: digest }));
}
