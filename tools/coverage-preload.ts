import { afterAll } from "bun:test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createInstrumenter } from "istanbul-lib-instrument";

import { sourceHasRuntimeCode } from "./coverage-source-files";

type IstanbulCoverage = Record<string, unknown>;

const rootDirectory = resolve(process.cwd());
const sourceDirectory = join(rootDirectory, "src");
const coverageDirectory = join(rootDirectory, "coverage");
const finalCoveragePath = join(coverageDirectory, "coverage-final.json");
const temporaryCoveragePath = join(coverageDirectory, `coverage-${process.pid}.json`);
const sourceFilter = new RegExp(
  `^${sourceDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.*\\.ts$`,
);
const instrumenter = createInstrumenter({
  coverageVariable: "__coverage__",
  esModules: true,
  parserPlugins: ["typescript"],
  preserveComments: true,
  produceSourceMap: true,
});

function isProductionSource(path: string): boolean {
  const projectPath = relative(sourceDirectory, resolve(path)).split(sep).join("/");
  return projectPath !== ".." && !projectPath.startsWith("../") && projectPath.endsWith(".ts");
}

Bun.plugin({
  name: "istanbul-production-coverage",
  setup(builder) {
    builder.onLoad({ filter: sourceFilter }, (args) => {
      if (!isProductionSource(args.path)) return undefined;
      const source = readFileSync(args.path, "utf8");
      if (!sourceHasRuntimeCode(args.path, source)) return undefined;
      return {
        contents: instrumenter.instrumentSync(source, args.path),
        loader: "ts",
      };
    });
  },
});

function writeCoverage(): void {
  const coverage = (globalThis as typeof globalThis & { __coverage__?: IstanbulCoverage })
    .__coverage__;
  mkdirSync(coverageDirectory, { recursive: true });
  writeFileSync(temporaryCoveragePath, `${JSON.stringify(coverage ?? {})}\n`);
  renameSync(temporaryCoveragePath, finalCoveragePath);
}

afterAll(writeCoverage);
process.once("exit", writeCoverage);
