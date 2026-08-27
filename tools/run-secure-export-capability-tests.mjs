import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const reportPath = "/tmp/secure-export-junit.xml";
const testFiles = [
  "test/acceptance/export-capability.test.ts",
  "test/integration/adapters/export/linux-export-destination.test.ts",
  "test/integration/adapters/export/opencode-cli-export-adapter.test.ts",
];

if (process.env.REQUIRE_SECURE_EXPORT_CAPABILITY !== "1") {
  throw new Error("The secure-export capability suite must require positive capability evidence.");
}

const result = spawnSync(
  process.execPath,
  ["test", "--reporter=junit", `--reporter-outfile=${reportPath}`, ...testFiles],
  { stdio: "inherit", env: process.env },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const report = readFileSync(reportPath, "utf8");
const skippedAttributeTotal = [...report.matchAll(/\bskipped="(\d+)"/g)].reduce(
  (total, match) => total + Number(match[1]),
  0,
);
const skippedElements = [...report.matchAll(/<skipped(?:\s|\/?>)/g)].length;

if (skippedAttributeTotal !== 0 || skippedElements !== 0) {
  throw new Error(
    `Secure-export capability suite skipped tests (attributes=${skippedAttributeTotal}, elements=${skippedElements}).`,
  );
}

console.error("Secure-export capability suite reported zero skipped tests.");
