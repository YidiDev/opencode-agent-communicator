import { cp, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const environmentVariable = "OPENCODE_COMMUNICATOR_PACKED_RUNTIME_DEPENDENCIES_ROOT";
const destinationRoot = process.env[environmentVariable];
if (destinationRoot === undefined || destinationRoot.length === 0 || !isAbsolute(destinationRoot)) {
  throw new Error(`${environmentVariable} must be a non-empty absolute path`);
}

function dependencySegments(name) {
  const segments = name.split("/");
  const isUnscoped = segments.length === 1 && /^[a-z0-9][a-z0-9._-]*$/u.test(segments[0] ?? "");
  const isScoped =
    segments.length === 2 &&
    /^@[a-z0-9][a-z0-9._-]*$/u.test(segments[0] ?? "") &&
    /^[a-z0-9][a-z0-9._-]*$/u.test(segments[1] ?? "");
  if (!isUnscoped && !isScoped) throw new Error(`runtime dependency name is invalid: ${name}`);
  return segments;
}

async function manifest(path, label) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} manifest is unavailable or malformed`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} manifest is malformed`);
  }
  return value;
}

const project = await manifest("package.json", "project package");
const dependencies = project.dependencies;
if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
  throw new Error("project runtime dependencies are unavailable");
}

await mkdir(destinationRoot, { mode: 0o700 });
for (const [name, expectedVersion] of Object.entries(dependencies)) {
  if (typeof expectedVersion !== "string") {
    throw new Error(`runtime dependency requirement is malformed: ${name}`);
  }
  const segments = dependencySegments(name);
  const source = await realpath(join("node_modules", ...segments));
  const sourceManifest = await manifest(join(source, "package.json"), `runtime dependency ${name}`);
  if (sourceManifest.name !== name || sourceManifest.version !== expectedVersion) {
    throw new Error(
      `runtime dependency does not match locked manifest: ${name}@${expectedVersion}`,
    );
  }
  const destination = join(destinationRoot, ...segments);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination, { recursive: true, dereference: true, errorOnExist: true });
  const copiedManifest = await manifest(
    join(destination, "package.json"),
    `snapshotted runtime dependency ${name}`,
  );
  if (copiedManifest.name !== name || copiedManifest.version !== expectedVersion) {
    throw new Error(`snapshotted runtime dependency does not match: ${name}@${expectedVersion}`);
  }
}
