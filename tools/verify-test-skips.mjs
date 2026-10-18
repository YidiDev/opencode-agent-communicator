import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const reviewedSkips = new Map([
  ["test/integration/adapters/export/linux-export-destination.test.ts", 4],
]);

async function testFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await testFiles(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

const observed = new Map();
for (const path of await testFiles(resolve(root, "test"))) {
  const source = await readFile(path, "utf8");
  const count = [...source.matchAll(/\b(?:test|it|describe)\.(?:skip|skipIf|todo)\b/g)].length;
  if (count > 0) observed.set(path.slice(root.length + 1), count);
}
if (JSON.stringify([...observed]) !== JSON.stringify([...reviewedSkips])) {
  throw new Error(
    `Test skip policy changed. Expected ${JSON.stringify([...reviewedSkips])}; observed ${JSON.stringify([...observed])}.`,
  );
}
console.error(
  `Verified ${[...observed.values()].reduce((sum, count) => sum + count, 0)} explicit reviewed regular-suite skips.`,
);
