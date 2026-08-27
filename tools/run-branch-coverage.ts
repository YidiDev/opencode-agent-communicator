import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { checkCoverage } from "./check-coverage";

const rootDirectory = process.cwd();
rmSync(join(rootDirectory, "coverage", "coverage-final.json"), { force: true });

const result = spawnSync(
  process.execPath,
  [
    "test",
    "--preload",
    "./tools/coverage-preload.ts",
    "test/unit",
    "test/integration",
    "test/black-box",
  ],
  { cwd: rootDirectory, stdio: "inherit" },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const diagnostics = checkCoverage({ rootDirectory });
for (const item of diagnostics) console.error(`ERROR ${item.path} [coverage] ${item.message}`);
if (diagnostics.length > 0) process.exit(1);
