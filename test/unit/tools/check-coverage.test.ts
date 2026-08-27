import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CoverageDiagnostic,
  checkCoverage,
  isCriticalProductionPath,
} from "../../../tools/check-coverage";
import { sourceHasRuntimeCode } from "../../../tools/coverage-source-files";

const temporaryRoots: string[] = [];

function write(root: string, projectPath: string, contents: string): void {
  const path = join(root, projectPath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "coverage-checker-"));
  temporaryRoots.push(root);
  return root;
}

function locations(count: number): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      String(index),
      {
        start: { line: index + 1, column: 0 },
        end: { line: index + 1, column: 1 },
      },
    ]),
  );
}

function coverageRecord(
  path: string,
  linesHit: number,
  linesFound: number,
  branchesHit = linesHit,
  branchesFound = linesFound,
): Record<string, unknown> {
  const branchLocations = locations(branchesFound);
  return {
    path,
    statementMap: locations(linesFound),
    s: Object.fromEntries(
      Array.from({ length: linesFound }, (_, index) => [String(index), index < linesHit ? 1 : 0]),
    ),
    fnMap: {},
    f: {},
    branchMap: Object.fromEntries(
      Object.entries(branchLocations).map(([key, location]) => [
        key,
        { type: "cond-expr", line: Number(key) + 1, locations: [location] },
      ]),
    ),
    b: Object.fromEntries(
      Array.from({ length: branchesFound }, (_, index) => [
        String(index),
        [index < branchesHit ? 1 : 0],
      ]),
    ),
  };
}

function findings(root: string, records: Record<string, unknown>): CoverageDiagnostic[] {
  write(root, "coverage/coverage-final.json", JSON.stringify(records));
  return checkCoverage({ rootDirectory: root });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("coverage thresholds", () => {
  test("classifies the specified invariant-bearing layers as critical", () => {
    expect(isCriticalProductionPath("src/domain/state.ts")).toBeTrue();
    expect(isCriticalProductionPath("src/application/approve.ts")).toBeTrue();
    expect(isCriticalProductionPath("src/adapters/native/process.ts")).toBeTrue();
    expect(isCriticalProductionPath("src/adapters/store/ownership.ts")).toBeTrue();
    expect(isCriticalProductionPath("src/adapters/export/log.ts")).toBeTrue();
    expect(isCriticalProductionPath("src/composition/plugin.ts")).toBeFalse();
  });

  test("enforces per-file line and real branch thresholds", () => {
    const root = createRepository();
    write(root, "src/domain/state.ts", "export const state = 1;");
    write(root, "src/index.ts", "export const plugin = () => {};\n");
    const criticalPath = join(root, "src/domain/state.ts");
    const generalPath = join(root, "src/index.ts");

    expect(
      findings(root, {
        [criticalPath]: coverageRecord(criticalPath, 94, 100, 89, 100),
        [generalPath]: coverageRecord(generalPath, 85, 100, 79, 100),
      }),
    ).toEqual([
      {
        path: "src/domain/state.ts",
        message: "branches coverage 89.00% (89/100) is below 90%.",
      },
      {
        path: "src/domain/state.ts",
        message: "lines coverage 94.00% (94/100) is below 95%.",
      },
      { path: "src/index.ts", message: "branches coverage 79.00% (79/100) is below 80%." },
    ]);
  });

  test("rejects reports with no branch instrumentation", () => {
    const root = createRepository();
    write(root, "src/index.ts", "export const value = 1;\n");
    const path = join(root, "src/index.ts");

    expect(findings(root, { [path]: coverageRecord(path, 1, 1, 0, 0) })).toContainEqual({
      path: "coverage/coverage-final.json",
      message: "Coverage contains no instrumented branches; the branch gate is not valid.",
    });
  });
});

describe("runtime source discovery", () => {
  test("structurally excludes erased type-only modules", () => {
    expect(
      sourceHasRuntimeCode(
        "ports.ts",
        'import type { Input } from "./input";\nexport interface Port { run(x: Input): void }\nexport type Id = string;\n',
      ),
    ).toBeFalse();
    expect(
      sourceHasRuntimeCode("ambient.ts", "export declare const version: string;\n"),
    ).toBeFalse();
    expect(sourceHasRuntimeCode("runtime.ts", "export const version = '1';\n")).toBeTrue();
    expect(sourceHasRuntimeCode("side-effect.ts", 'import "./register";\n')).toBeTrue();
  });

  test("requires records for runtime files but not type-only files", () => {
    const root = createRepository();
    write(root, "src/ports.ts", "export interface Port { run(): void }\n");
    write(root, "src/index.ts", "export const value = 1;\n");
    const unrelatedPath = join(root, "src/executed.ts");

    expect(findings(root, { [unrelatedPath]: coverageRecord(unrelatedPath, 1, 1, 1, 1) })).toEqual([
      { path: "src/index.ts", message: "Runtime production source has no coverage record." },
    ]);
  });
});

describe("Istanbul input validation", () => {
  test("reports malformed JSON without throwing", () => {
    const root = createRepository();
    write(root, "coverage/coverage-final.json", "{");

    expect(checkCoverage({ rootDirectory: root })[0]).toMatchObject({
      path: "coverage/coverage-final.json",
    });
  });
});
