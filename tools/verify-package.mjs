import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const expectedToolIds = Object.freeze([
  "session_list",
  "session_read",
  "session_lock_list",
  "session_lock_publish",
  "session_lock_release",
  "session_lock_renew",
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
  "session_request_send",
  "session_request_start",
  "session_stop",
  "session_start",
  "session_export",
]);

// This is SHA-256(npm-reported pack paths joined with LF), not a content digest. Any added, removed,
// renamed, or reordered archive entry requires an explicit review and fingerprint update.
export const expectedPackedPathPolicy = Object.freeze({
  entryCount: 317,
  sha256: "9677ddb64855bbaacad2cd383be1bc3d897d075c1ad9b99c8633078d392f8bd1",
});

const forbiddenPathSegments = new Set([
  ".env",
  ".git",
  ".github",
  ".npmrc",
  ".pnpm-store",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "test",
  "tests",
  "tmp",
]);
const secretLikeName =
  /(?:^|\/)(?:\.env(?:\..*)?|\.netrc)$|(?:^|[/._-])(credential|credentials|id_rsa|private[_-]?key|secret|secrets|token)(?:[._-]|$)|\.(?:key|p12|pem)$/i;
const generatedSuffix = /(?:\.map|\.tsbuildinfo|\.log|\.tmp|\.tgz|\.zip|~)$/i;

function assert(condition, message) {
  if (!condition) throw new Error(`Package verification failed: ${message}`);
}

export function packedPathFingerprint(paths) {
  return createHash("sha256").update(paths.join("\n")).digest("hex");
}

export function assertSafePackedPath(path) {
  assert(typeof path === "string" && path.length > 0, "archive contains an empty path");
  assert(!path.startsWith("/") && !path.includes("\\"), `archive path is not portable: ${path}`);
  const segments = path.split("/");
  assert(
    segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    `archive path is not canonical: ${path}`,
  );
  assert(
    segments.every((segment) => !forbiddenPathSegments.has(segment.toLowerCase())),
    `generated or non-runtime path is forbidden: ${path}`,
  );
  assert(!secretLikeName.test(path), `secret-like archive path is forbidden: ${path}`);
  assert(!generatedSuffix.test(path), `generated archive path is forbidden: ${path}`);
}

export async function assertPackedSourceHasNoSymlink(root, packedPath) {
  const rootPath = await realpath(root);
  let current = resolve(rootPath, packedPath);
  while (current !== rootPath) {
    const metadata = await lstat(current);
    assert(!metadata.isSymbolicLink(), `archive source is a symlink: ${packedPath}`);
    const parent = dirname(current);
    assert(parent !== current, `archive path escaped the repository: ${packedPath}`);
    current = parent;
  }
  const escaped = relative(rootPath, resolve(rootPath, packedPath));
  assert(
    escaped !== ".." && !escaped.startsWith(`..${sep}`),
    `archive path escaped: ${packedPath}`,
  );
}

function packedReport(root) {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const reports = JSON.parse(output);
  assert(Array.isArray(reports) && reports.length === 1, "npm must report exactly one package");
  return reports[0];
}

export async function verifyPackage(root = resolve(import.meta.dirname, "..")) {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert(packageJson.version === "0.7.1", "version must be 0.7.1");
  assert(packageJson.private !== true, "package must be publishable");
  assert(packageJson.license === "MIT", "license metadata must match LICENSE");
  assert(
    packageJson.os?.length === 1 && packageJson.os[0] === "linux",
    "package must be Linux-only",
  );
  assert(packageJson.cpu?.length === 1 && packageJson.cpu[0] === "x64", "package must be x64-only");
  assert(packageJson.engines?.bun === "1.4.0", "Bun compatibility must be exact");
  assert(
    packageJson.peerDependencies?.["opencode-ai"] === ">=1.18.21 <1.19.0",
    "OpenCode peer must match the certified minor line",
  );
  assert(
    packageJson.engines?.opencode === ">=1.18.21 <1.19.0",
    "OpenCode engine range must match the certified minor line",
  );
  assert(
    packageJson.dependencies?.["@opencode-ai/plugin"] === "1.18.25",
    "plugin API must be exact",
  );
  assert(packageJson.dependencies?.["@opencode-ai/sdk"] === "1.18.25", "SDK must be exact");
  assert(packageJson.dependencies?.zod === "4.4.3", "Zod must match the certified version");
  assert(
    packageJson.devDependencies?.typescript === "7.0.2",
    "TypeScript must match the certified compiler version",
  );
  assert(
    packageJson.devDependencies?.["typescript-compiler-api"] === "npm:typescript@5.9.3",
    "TypeScript compiler API alias must match the certified version",
  );
  assert(
    packageJson.exports?.["."] === "./src/index.ts",
    "export must use the Bun-loadable source entry",
  );

  const expectedFiles = [
    "src/",
    "skills/",
    "docs/plugin-configuration.md",
    "docs/session-read-security.md",
    "docs/session-export-security.md",
    "docs/linux-sqlite-store.md",
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
  ];
  assert(
    JSON.stringify(packageJson.files) === JSON.stringify(expectedFiles),
    "files allowlist changed",
  );

  const toolsSource = await readFile(resolve(root, "src/composition/tool-ids.ts"), "utf8");
  const toolManifest = toolsSource.match(
    /communicatorToolIds = Object\.freeze\(\[([\s\S]*?)\]\s+as const\)/,
  )?.[1];
  assert(toolManifest, "public tool manifest is unreadable");
  const toolIds = [...toolManifest.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  assert(
    JSON.stringify(toolIds) === JSON.stringify(expectedToolIds),
    `ordered public tool IDs changed: ${JSON.stringify(toolIds)}`,
  );

  for (const skillName of [
    "session-communication",
    "session-request-participant",
    "session-locks",
  ]) {
    const skill = await readFile(resolve(root, `skills/${skillName}/SKILL.md`), "utf8");
    assert(
      skill.startsWith(`---\nname: ${skillName}\ndescription:`),
      `${skillName} skill frontmatter is absent or malformed`,
    );
  }

  const report = packedReport(root);
  assert(Array.isArray(report.files), "npm pack file report is absent");
  const packedPaths = report.files.map((entry) => entry.path);
  const packedSkillFiles = packedPaths.filter((path) => path.startsWith("skills/"));
  assert(
    JSON.stringify(packedSkillFiles) ===
      JSON.stringify([
        "skills/session-communication/SKILL.md",
        "skills/session-locks/SKILL.md",
        "skills/session-request-participant/SKILL.md",
      ]),
    `packed skill surface changed: ${JSON.stringify(packedSkillFiles)}`,
  );
  assert(
    packedPaths.length === expectedPackedPathPolicy.entryCount &&
      packedPathFingerprint(packedPaths) === expectedPackedPathPolicy.sha256,
    `exact packed path policy changed (${packedPaths.length} entries, ${packedPathFingerprint(packedPaths)})`,
  );
  for (const entry of report.files) {
    assertSafePackedPath(entry.path);
    assert(
      entry.mode === 0o644,
      `archive entry must be a non-executable regular file: ${entry.path}`,
    );
    await assertPackedSourceHasNoSymlink(root, entry.path);
  }

  const entrySource = await readFile(resolve(root, "src/index.ts"), "utf8");
  assert(
    /export default sessionCommunicatorPlugin/.test(entrySource),
    "entry must default-export a plugin",
  );
  console.error(
    `Verified opencode-agent-communicator@${packageJson.version}: exact ${packedPaths.length}-path archive and ordered ${toolIds.length}-tool manifest.`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await verifyPackage();
