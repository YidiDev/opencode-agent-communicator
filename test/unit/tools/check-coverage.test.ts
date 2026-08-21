import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CoverageDiagnostic,
  checkCoverage,
  isCriticalProductionPath,
} from "../../../tools/check-coverage";

const temporaryRoots: string[] = [];

function write(root: string, projectPath: string, contents: string): void {
  const path = join(root, projectPath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "coverage-checker-"));
  temporaryRoots.push(root);
  write(root, "quality-exceptions.json", JSON.stringify({ exceptions: [] }));
  return root;
}

function record(
  path: string,
  linesHit: number,
  linesFound: number,
  functionsHit = linesHit,
  functionsFound = linesFound,
): string {
  return [
    `SF:${path}`,
    `FNF:${functionsFound}`,
    `FNH:${functionsHit}`,
    `LF:${linesFound}`,
    `LH:${linesHit}`,
    "end_of_record",
  ].join("\n");
}

function findings(root: string, lcov: string): CoverageDiagnostic[] {
  write(root, "coverage/lcov.info", lcov);
  return checkCoverage({ rootDirectory: root });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("coverage thresholds", () => {
  test("classifies invariant-bearing layers as critical", () => {
    expect(isCriticalProductionPath("src/domain/state.ts")).toBeTrue();
    expect(isCriticalProductionPath("src/application/approve.ts")).toBeTrue();
    expect(isCriticalProductionPath("src/adapters/native/process.ts")).toBeTrue();
    expect(isCriticalProductionPath("src/adapters/store/ownership.ts")).toBeTrue();
    expect(isCriticalProductionPath("src/adapters/export/log.ts")).toBeTrue();
    expect(isCriticalProductionPath("src/index.ts")).toBeFalse();
  });

  test("enforces per-file line and function thresholds", () => {
    const root = createRepository();
    write(root, "src/domain/state.ts", "export const state = 1;");
    write(root, "src/index.ts", "export const plugin = () => {};\n");

    const diagnostics = findings(
      root,
      [
        record("src/domain/state.ts", 94, 100, 90, 100),
        record("src/index.ts", 84, 100, 80, 100),
      ].join("\n"),
    );

    expect(diagnostics).toEqual([
      {
        path: "src/domain/state.ts",
        message: "lines coverage 94.00% (94/100) is below 95%.",
      },
      { path: "src/index.ts", message: "lines coverage 84.00% (84/100) is below 85%." },
    ]);
  });

  test("treats a file with no functions as fully function-covered", () => {
    const root = createRepository();
    write(root, "src/index.ts", "export const value = 1;\n");

    expect(findings(root, record("src/index.ts", 1, 1, 0, 0))).toEqual([]);
  });

  test("rejects production files omitted from LCOV", () => {
    const root = createRepository();
    write(root, "src/index.ts", "export const value = 1;\n");

    expect(findings(root, "TN:\n")).toEqual([
      { path: "src/index.ts", message: "Production source has no LCOV record." },
    ]);
  });
});

describe("LCOV validation", () => {
  test("accepts absolute source paths inside the repository", () => {
    const root = createRepository();
    write(root, "src/index.ts", "export const value = 1;\n");

    expect(findings(root, record(join(root, "src/index.ts"), 1, 1))).toEqual([]);
  });

  test("rejects incomplete and impossible summaries", () => {
    const root = createRepository();
    write(root, "src/index.ts", "export const value = 1;\n");

    expect(findings(root, "SF:src/index.ts\nLF:1\nLH:1\nend_of_record")[0]?.message).toContain(
      "missing FNF, FNH, LF, or LH",
    );
    expect(findings(root, record("src/index.ts", 2, 1))[0]?.message).toContain(
      "more covered items than found items",
    );
  });

  test("rejects duplicate source records", () => {
    const root = createRepository();
    write(root, "src/index.ts", "export const value = 1;\n");

    expect(
      findings(root, `${record("src/index.ts", 1, 1)}\n${record("src/index.ts", 1, 1)}`)[0]
        ?.message,
    ).toContain("duplicate record");
  });
});

describe("coverage exceptions", () => {
  test("uses an exact metric exception only for a failing file", () => {
    const root = createRepository();
    write(root, "src/index.ts", "export const plugin = () => {};\n");
    write(
      root,
      "quality-exceptions.json",
      JSON.stringify({
        exceptions: [
          {
            path: "src/index.ts",
            rule: "coverage-lines",
            reason: "The generated bootstrap cannot be exercised in process.",
            removalCondition: "Remove when bootstrap generation is replaced.",
          },
        ],
      }),
    );

    expect(findings(root, record("src/index.ts", 84, 100, 80, 100))).toEqual([]);
  });

  test("rejects stale and wrong-metric exceptions", () => {
    const root = createRepository();
    write(root, "src/index.ts", "export const plugin = () => {};\n");
    write(
      root,
      "quality-exceptions.json",
      JSON.stringify({
        exceptions: [
          {
            path: "src/index.ts",
            rule: "coverage-lines",
            reason: "A temporary generated-code exception.",
            removalCondition: "Remove when generated code changes.",
          },
        ],
      }),
    );

    expect(findings(root, record("src/index.ts", 100, 100, 79, 100))).toEqual([
      {
        path: "quality-exceptions.json",
        message: "Unused exception for src/index.ts (coverage-lines).",
      },
      {
        path: "src/index.ts",
        message: "functions coverage 79.00% (79/100) is below 80%.",
      },
    ]);
  });
});
