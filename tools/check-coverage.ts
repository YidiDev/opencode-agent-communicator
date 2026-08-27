import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type CoverageMapData, createCoverageMap } from "istanbul-lib-coverage";

import { collectRuntimeSourceFiles, toProjectPath } from "./coverage-source-files";

export interface CoverageDiagnostic {
  readonly path: string;
  readonly message: string;
}

export interface CheckCoverageOptions {
  readonly rootDirectory: string;
  readonly coveragePath?: string;
}

interface CoverageTotals {
  readonly branchesFound: number;
  readonly branchesHit: number;
  readonly linesFound: number;
  readonly linesHit: number;
}

export function isCriticalProductionPath(path: string): boolean {
  return (
    path.startsWith("src/domain/") ||
    path.startsWith("src/application/") ||
    path.startsWith("src/adapters/native/") ||
    path.startsWith("src/adapters/store/") ||
    path.startsWith("src/adapters/export/")
  );
}

function percentage(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

function checkFileCoverage(
  path: string,
  totals: CoverageTotals,
  diagnostics: CoverageDiagnostic[],
): void {
  const critical = isCriticalProductionPath(path);
  const metrics: Array<[string, number, number, number]> = [
    ["lines", totals.linesHit, totals.linesFound, critical ? 95 : 85],
    ["branches", totals.branchesHit, totals.branchesFound, critical ? 90 : 80],
  ];
  for (const [metric, hit, found, threshold] of metrics) {
    const actual = percentage(hit, found);
    if (actual < threshold) {
      diagnostics.push({
        path,
        message: `${metric} coverage ${actual.toFixed(2)}% (${hit}/${found}) is below ${threshold}%.`,
      });
    }
  }
}

export function checkCoverage(options: CheckCoverageOptions): CoverageDiagnostic[] {
  const rootDirectory = resolve(options.rootDirectory);
  const coveragePath = resolve(
    rootDirectory,
    options.coveragePath ?? "coverage/coverage-final.json",
  );
  const diagnostics: CoverageDiagnostic[] = [];
  const records = new Map<string, CoverageTotals>();
  try {
    const data = JSON.parse(readFileSync(coveragePath, "utf8")) as CoverageMapData;
    const coverageMap = createCoverageMap(data);
    for (const file of coverageMap.files()) {
      const path = toProjectPath(rootDirectory, file);
      if (!path?.startsWith("src/")) continue;
      const summary = coverageMap.fileCoverageFor(file).toSummary();
      records.set(path, {
        branchesFound: summary.branches.total,
        branchesHit: summary.branches.covered,
        linesFound: summary.lines.total,
        linesHit: summary.lines.covered,
      });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown coverage input error";
    return [{ path: options.coveragePath ?? "coverage/coverage-final.json", message }];
  }

  const runtimeFiles = collectRuntimeSourceFiles(rootDirectory);
  for (const path of runtimeFiles) {
    const totals = records.get(path);
    if (totals) checkFileCoverage(path, totals, diagnostics);
    else diagnostics.push({ path, message: "Runtime production source has no coverage record." });
  }

  const branchTotal = [...records.values()].reduce((sum, record) => sum + record.branchesFound, 0);
  if (branchTotal === 0) {
    diagnostics.push({
      path: options.coveragePath ?? "coverage/coverage-final.json",
      message: "Coverage contains no instrumented branches; the branch gate is not valid.",
    });
  }
  return diagnostics.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.message.localeCompare(right.message),
  );
}
