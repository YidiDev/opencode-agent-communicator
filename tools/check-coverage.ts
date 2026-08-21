import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

export type CoverageMetric = "functions" | "lines";

export interface CoverageDiagnostic {
  readonly path: string;
  readonly message: string;
}

export interface CheckCoverageOptions {
  readonly rootDirectory: string;
  readonly lcovPath?: string;
}

interface CoverageTotals {
  functionsFound: number;
  functionsHit: number;
  linesFound: number;
  linesHit: number;
}

interface CoverageException {
  readonly path: string;
  readonly metric: CoverageMetric;
  isUsed: boolean;
}

const sourceExtensions = new Set([".cts", ".mts", ".ts", ".tsx"]);
const coverageRules = new Map<string, CoverageMetric>([
  ["coverage-functions", "functions"],
  ["coverage-lines", "lines"],
]);

function projectPath(rootDirectory: string, path: string): string | undefined {
  const result = relative(rootDirectory, resolve(rootDirectory, path)).split(sep).join("/");
  return result === ".." || result.startsWith("../") ? undefined : result;
}

function collectSourceFiles(directory: string, rootDirectory: string): string[] {
  if (!existsSync(directory)) return [];
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...collectSourceFiles(path, rootDirectory));
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      const relativePath = projectPath(rootDirectory, path);
      if (relativePath) paths.push(relativePath);
    }
  }
  return paths.sort();
}

function parseCount(value: string, field: string, line: number): number {
  if (!/^\d+$/.test(value))
    throw new Error(`line ${line}: ${field} must be a non-negative integer`);
  return Number(value);
}

function parseLcov(rootDirectory: string, contents: string): Map<string, CoverageTotals> {
  const records = new Map<string, CoverageTotals>();
  let path: string | undefined;
  let values: Partial<CoverageTotals> = {};
  const finishRecord = (line: number): void => {
    if (!path) throw new Error(`line ${line}: record has no SF field`);
    const required: Array<keyof CoverageTotals> = [
      "functionsFound",
      "functionsHit",
      "linesFound",
      "linesHit",
    ];
    if (required.some((field) => values[field] === undefined)) {
      throw new Error(`line ${line}: ${path} is missing FNF, FNH, LF, or LH`);
    }
    const totals = values as CoverageTotals;
    if (totals.functionsHit > totals.functionsFound || totals.linesHit > totals.linesFound) {
      throw new Error(`line ${line}: ${path} has more covered items than found items`);
    }
    if (records.has(path)) throw new Error(`line ${line}: duplicate record for ${path}`);
    records.set(path, totals);
    path = undefined;
    values = {};
  };

  for (const [index, rawLine] of contents.split(/\r\n|\n|\r/).entries()) {
    const line = index + 1;
    if (rawLine.startsWith("SF:")) {
      if (path) throw new Error(`line ${line}: record is missing end_of_record`);
      const sourcePath = rawLine.slice(3);
      const normalized = projectPath(rootDirectory, sourcePath);
      if (!normalized) throw new Error(`line ${line}: source file is outside the project`);
      path = normalized;
    } else if (rawLine === "end_of_record") finishRecord(line);
    else if (rawLine.startsWith("FNF:")) {
      values.functionsFound = parseCount(rawLine.slice(4), "FNF", line);
    } else if (rawLine.startsWith("FNH:")) {
      values.functionsHit = parseCount(rawLine.slice(4), "FNH", line);
    } else if (rawLine.startsWith("LF:")) {
      values.linesFound = parseCount(rawLine.slice(3), "LF", line);
    } else if (rawLine.startsWith("LH:")) {
      values.linesHit = parseCount(rawLine.slice(3), "LH", line);
    }
  }
  if (path) throw new Error("LCOV ends before end_of_record");
  return records;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCoverageExceptions(rootDirectory: string): CoverageException[] {
  const path = join(rootDirectory, "quality-exceptions.json");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value) || !Array.isArray(value.exceptions)) {
    throw new Error('quality-exceptions.json must contain an "exceptions" array');
  }
  const exceptions: CoverageException[] = [];
  for (const candidate of value.exceptions) {
    if (!isRecord(candidate) || typeof candidate.path !== "string") continue;
    const metric =
      typeof candidate.rule === "string" ? coverageRules.get(candidate.rule) : undefined;
    if (metric) exceptions.push({ path: candidate.path, metric, isUsed: false });
  }
  return exceptions;
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
  exceptions: CoverageException[],
  diagnostics: CoverageDiagnostic[],
): void {
  const critical = isCriticalProductionPath(path);
  const metrics: Array<[CoverageMetric, number, number, number]> = [
    ["lines", totals.linesHit, totals.linesFound, critical ? 95 : 85],
    ["functions", totals.functionsHit, totals.functionsFound, critical ? 90 : 80],
  ];
  for (const [metric, hit, found, threshold] of metrics) {
    const actual = percentage(hit, found);
    if (actual >= threshold) continue;
    const exception = exceptions.find(
      (candidate) => candidate.path === path && candidate.metric === metric,
    );
    if (exception) exception.isUsed = true;
    else {
      diagnostics.push({
        path,
        message: `${metric} coverage ${actual.toFixed(2)}% (${hit}/${found}) is below ${threshold}%.`,
      });
    }
  }
}

export function checkCoverage(options: CheckCoverageOptions): CoverageDiagnostic[] {
  const rootDirectory = resolve(options.rootDirectory);
  const lcovPath = resolve(rootDirectory, options.lcovPath ?? "coverage/lcov.info");
  const diagnostics: CoverageDiagnostic[] = [];
  let records: Map<string, CoverageTotals>;
  let exceptions: CoverageException[];
  try {
    records = parseLcov(rootDirectory, readFileSync(lcovPath, "utf8"));
    exceptions = readCoverageExceptions(rootDirectory);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown coverage input error";
    return [{ path: projectPath(rootDirectory, lcovPath) ?? lcovPath, message }];
  }

  for (const path of collectSourceFiles(join(rootDirectory, "src"), rootDirectory)) {
    const totals = records.get(path);
    if (!totals) {
      diagnostics.push({ path, message: "Production source has no LCOV record." });
      continue;
    }
    checkFileCoverage(path, totals, exceptions, diagnostics);
  }
  for (const exception of exceptions) {
    if (!exception.isUsed) {
      diagnostics.push({
        path: "quality-exceptions.json",
        message: `Unused exception for ${exception.path} (coverage-${exception.metric}).`,
      });
    }
  }
  return diagnostics.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.message.localeCompare(right.message),
  );
}
