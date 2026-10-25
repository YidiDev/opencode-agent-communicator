import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// New or changed expressions require an explicit license review before updating this set.
const reviewedLicenses = new Set([
  "MIT",
  "Apache-2.0",
  "ISC",
  "BlueOak-1.0.0",
  "BSD-3-Clause",
  "BSD-2-Clause",
  "(AFL-2.1 OR BSD-3-Clause)",
  "CC-BY-3.0",
  "CC0-1.0",
  "0BSD",
]);

export function licenseInventory(packages, rootName) {
  if (!Array.isArray(packages) || packages.length === 0)
    throw new Error("Dependency inventory is absent");
  const unique = new Map();
  for (const item of packages) {
    if (item?.name === rootName && item.location === "") continue;
    if (
      !item ||
      typeof item.name !== "string" ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(item.name) ||
      typeof item.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(item.version) ||
      !reviewedLicenses.has(item.license)
    ) {
      throw new Error("Production dependency has an unreviewed identity or license expression");
    }
    const entry = {
      name: item.name,
      version: item.version,
      license: item.license,
      package: `https://www.npmjs.com/package/${item.name}/v/${item.version}`,
    };
    const key = `${item.name}@${item.version}`;
    if (unique.has(key) && JSON.stringify(unique.get(key)) !== JSON.stringify(entry))
      throw new Error("Conflicting dependency license metadata");
    unique.set(key, entry);
  }
  if (unique.size === 0) throw new Error("Production dependencies are absent");
  return {
    schema_version: 1,
    scope: "installed production dependencies; not vendored code",
    packages: [...unique.values()].sort(
      (a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"),
    ),
  };
}

export async function checkLicenses(root = process.cwd(), update = false) {
  const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const packages = JSON.parse(
    execFileSync("npm", ["query", ".prod", "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
  const expected = `${JSON.stringify(licenseInventory(packages, metadata.name), null, 2)}\n`;
  const destination = resolve(root, "THIRD_PARTY_LICENSES.json");
  if (update) await writeFile(destination, expected);
  else if ((await readFile(destination, "utf8")) !== expected)
    throw new Error("Production license inventory drift; review before regenerating");
  console.error("Verified reviewed production dependency license inventory");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await checkLicenses(process.cwd(), process.argv.includes("--update"));
}
