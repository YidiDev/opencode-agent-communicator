import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import ts from "typescript";

import { checkArchitecture } from "./convention-architecture";

export type ConventionSeverity = "error" | "warning";

export interface ConventionDiagnostic {
  readonly rule: string;
  readonly severity: ConventionSeverity;
  readonly path: string;
  readonly line?: number;
  readonly message: string;
}

export type CheckConventionsOptions = { readonly rootDirectory: string };

interface QualityException {
  readonly path: string;
  readonly rule: string;
  isUsed: boolean;
}

const exceptionRules = new Set([
  "source-file-lines",
  "test-file-lines",
  "function-lines",
  "dependency-version",
  "package-manager",
  "work-marker",
  "ts-ignore",
  "ts-expect-error",
  "architecture",
  "import-cycle",
  "coverage-functions",
  "coverage-lines",
]);

const coverageExceptionRules = new Set(["coverage-functions", "coverage-lines"]);

function toProjectPath(rootDirectory: string, path: string): string {
  return relative(rootDirectory, path).split(sep).join("/");
}

function collectTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectTypeScriptFiles(path));
    else if (entry.isFile() && [".ts", ".tsx", ".mts", ".cts"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function diagnostic(
  rule: string,
  severity: ConventionSeverity,
  path: string,
  message: string,
  line?: number,
): ConventionDiagnostic {
  return line === undefined
    ? { rule, severity, path, message }
    : { rule, severity, path, line, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseExceptionCandidate(
  candidate: unknown,
  index: number,
  rootDirectory: string,
  diagnostics: ConventionDiagnostic[],
): QualityException | undefined {
  const projectPath = "quality-exceptions.json";
  const location = `exceptions[${index}]`;
  const keys = ["path", "reason", "removalCondition", "rule"];
  if (
    !isRecord(candidate) ||
    Object.keys(candidate).sort().join(",") !== keys.join(",") ||
    keys.some((key) => typeof candidate[key] !== "string" || candidate[key].trim() === "")
  ) {
    diagnostics.push(
      diagnostic(
        "quality-exceptions",
        "error",
        projectPath,
        `${location} must contain only non-empty path, rule, reason, and removalCondition strings.`,
      ),
    );
    return undefined;
  }
  const path = candidate.path;
  const rule = candidate.rule;
  const reason = candidate.reason;
  const removalCondition = candidate.removalCondition;
  if (
    typeof path !== "string" ||
    typeof rule !== "string" ||
    typeof reason !== "string" ||
    typeof removalCondition !== "string"
  ) {
    return undefined;
  }
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    normalize(path).split(sep).join("/") !== path ||
    path.startsWith("../")
  ) {
    diagnostics.push(
      diagnostic("quality-exceptions", "error", projectPath, `${location} path is not exact.`),
    );
    return undefined;
  }
  if (!exceptionRules.has(rule)) {
    diagnostics.push(
      diagnostic(
        "quality-exceptions",
        "error",
        projectPath,
        `${location} has unknown rule "${rule}".`,
      ),
    );
    return undefined;
  }
  if (
    coverageExceptionRules.has(rule) &&
    (!path.startsWith("src/") || ![".ts", ".tsx", ".mts", ".cts"].includes(extname(path)))
  ) {
    diagnostics.push(
      diagnostic(
        "quality-exceptions",
        "error",
        projectPath,
        `${location} coverage exception must target an exact production TypeScript file.`,
      ),
    );
    return undefined;
  }
  const target = join(rootDirectory, path);
  if (!existsSync(target) || !statSync(target).isFile()) {
    diagnostics.push(
      diagnostic(
        "quality-exceptions",
        "error",
        projectPath,
        `${location} refers to a nonexistent file.`,
      ),
    );
    return undefined;
  }
  return { path, rule, isUsed: false };
}

function readExceptions(
  rootDirectory: string,
  diagnostics: ConventionDiagnostic[],
): QualityException[] {
  const projectPath = "quality-exceptions.json";
  const exceptionPath = join(rootDirectory, projectPath);
  if (!existsSync(exceptionPath)) {
    diagnostics.push(
      diagnostic("quality-exceptions", "error", projectPath, "Exception file does not exist."),
    );
    return [];
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(exceptionPath, "utf8"));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown JSON error";
    diagnostics.push(
      diagnostic("quality-exceptions", "error", projectPath, `Invalid JSON: ${message}`),
    );
    return [];
  }
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.exceptions)) {
    diagnostics.push(
      diagnostic(
        "quality-exceptions",
        "error",
        projectPath,
        'Expected exactly one "exceptions" array.',
      ),
    );
    return [];
  }

  const exceptions: QualityException[] = [];
  const identities = new Set<string>();
  for (const [index, candidate] of value.exceptions.entries()) {
    const parsed = parseExceptionCandidate(candidate, index, rootDirectory, diagnostics);
    if (!parsed) continue;
    const identity = `${parsed.path}\0${parsed.rule}`;
    if (identities.has(identity)) {
      diagnostics.push(
        diagnostic(
          "quality-exceptions",
          "error",
          projectPath,
          `exceptions[${index}] is a duplicate.`,
        ),
      );
      continue;
    }
    identities.add(identity);
    exceptions.push(parsed);
  }
  return exceptions;
}

function addFinding(
  diagnostics: ConventionDiagnostic[],
  exceptions: QualityException[],
  finding: ConventionDiagnostic,
): void {
  const exception = exceptions.find(
    (candidate) => candidate.path === finding.path && candidate.rule === finding.rule,
  );
  if (exception) exception.isUsed = true;
  else diagnostics.push(finding);
}

function physicalLineCount(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\n|\r/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function checkFileLimit(
  projectPath: string,
  lines: number,
  diagnostics: ConventionDiagnostic[],
  exceptions: QualityException[],
): void {
  if (projectPath.startsWith("src/") && lines > 300) {
    addFinding(
      diagnostics,
      exceptions,
      diagnostic(
        "source-file-lines",
        lines > 500 ? "error" : "warning",
        projectPath,
        `Source file has ${lines} physical lines; the review threshold is 300 and limit is 500.`,
      ),
    );
  } else if (projectPath.startsWith("test/") && lines > 800) {
    addFinding(
      diagnostics,
      exceptions,
      diagnostic(
        "test-file-lines",
        "error",
        projectPath,
        `Test file has ${lines} physical lines; the limit is 800.`,
      ),
    );
  }
}

function checkFunctions(
  projectPath: string,
  sourceFile: ts.SourceFile,
  diagnostics: ConventionDiagnostic[],
  exceptions: QualityException[],
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      const end = sourceFile.getLineAndCharacterOfPosition(node.end).line;
      const functionLines = end - start + 1;
      if (functionLines > 200) {
        addFinding(
          diagnostics,
          exceptions,
          diagnostic(
            "function-lines",
            "error",
            projectPath,
            `Function-like declaration has ${functionLines} physical lines; the limit is 200.`,
            start + 1,
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function checkComments(
  projectPath: string,
  sourceFile: ts.SourceFile,
  diagnostics: ConventionDiagnostic[],
  exceptions: QualityException[],
): void {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sourceFile.languageVariant,
    sourceFile.text,
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    const comment = scanner.getTokenText();
    const line = sourceFile.getLineAndCharacterOfPosition(scanner.getTokenPos()).line + 1;
    for (const [lineOffset, commentLine] of comment.split(/\r\n|\n|\r/).entries()) {
      if (/\b(?:TODO|FIXME|HACK)\b\s*:?\s*(?:\*\/)?$/.test(commentLine)) {
        addFinding(
          diagnostics,
          exceptions,
          diagnostic(
            "work-marker",
            "error",
            projectPath,
            "Bare TODO/FIXME/HACK marker.",
            line + lineOffset,
          ),
        );
      }
    }
    if (/@ts-ignore\b/.test(comment)) {
      addFinding(
        diagnostics,
        exceptions,
        diagnostic("ts-ignore", "error", projectPath, "@ts-ignore is prohibited.", line),
      );
    }
    const expectError = comment.match(/@ts-expect-error\b(.*)/);
    if (expectError) {
      const isTypeTest =
        projectPath.startsWith("test/") &&
        /(?:\.test-d|\.type-test|\.types?\.test)\.[cm]?tsx?$/.test(projectPath);
      const explanation = expectError[1]?.replace(/^\s*(?::|--?)\s*|\*\/$/g, "").trim() ?? "";
      if (!isTypeTest || explanation.length === 0) {
        addFinding(
          diagnostics,
          exceptions,
          diagnostic(
            "ts-expect-error",
            "error",
            projectPath,
            "@ts-expect-error requires an explanation in a test type-level file.",
            line,
          ),
        );
      }
    }
  }
}

function checkSourceFile(
  projectPath: string,
  sourceFile: ts.SourceFile,
  diagnostics: ConventionDiagnostic[],
  exceptions: QualityException[],
): void {
  checkFileLimit(projectPath, physicalLineCount(sourceFile.text), diagnostics, exceptions);
  checkFunctions(projectPath, sourceFile, diagnostics, exceptions);
  checkComments(projectPath, sourceFile, diagnostics, exceptions);
}

function isExactVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

function checkPackageJson(
  rootDirectory: string,
  diagnostics: ConventionDiagnostic[],
  exceptions: QualityException[],
): void {
  const projectPath = "package.json";
  const packagePath = join(rootDirectory, projectPath);
  if (!existsSync(packagePath)) {
    addFinding(
      diagnostics,
      exceptions,
      diagnostic("package-manager", "error", projectPath, "package.json does not exist."),
    );
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown JSON error";
    addFinding(
      diagnostics,
      exceptions,
      diagnostic("package-manager", "error", projectPath, `Invalid package.json: ${message}`),
    );
    return;
  }
  if (!isRecord(value)) {
    addFinding(
      diagnostics,
      exceptions,
      diagnostic("package-manager", "error", projectPath, "package.json must be an object."),
    );
    return;
  }
  if (
    typeof value.packageManager !== "string" ||
    !/^[a-z0-9-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      value.packageManager,
    )
  ) {
    addFinding(
      diagnostics,
      exceptions,
      diagnostic(
        "package-manager",
        "error",
        projectPath,
        "packageManager must pin an exact version.",
      ),
    );
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = value[field];
    if (dependencies === undefined) continue;
    if (!isRecord(dependencies)) {
      addFinding(
        diagnostics,
        exceptions,
        diagnostic("dependency-version", "error", projectPath, `${field} must be an object.`),
      );
      continue;
    }
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version !== "string" || !isExactVersion(version)) {
        addFinding(
          diagnostics,
          exceptions,
          diagnostic(
            "dependency-version",
            "error",
            projectPath,
            `${field}.${name} must pin an exact semantic version.`,
          ),
        );
      }
    }
  }
}

export function checkConventions(options: CheckConventionsOptions): ConventionDiagnostic[] {
  const rootDirectory = resolve(options.rootDirectory);
  const diagnostics: ConventionDiagnostic[] = [];
  const exceptions = readExceptions(rootDirectory, diagnostics);
  const paths = ["src", "test", "tools"].flatMap((directory) =>
    collectTypeScriptFiles(join(rootDirectory, directory)),
  );
  const sourceFiles = new Map<string, ts.SourceFile>();
  const absolutePaths = new Map<string, string>();
  const filesByAbsolutePath = new Map<string, string>();
  for (const absolutePath of paths) {
    const projectPath = toProjectPath(rootDirectory, absolutePath);
    const sourceFile = ts.createSourceFile(
      projectPath,
      readFileSync(absolutePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    sourceFiles.set(projectPath, sourceFile);
    absolutePaths.set(projectPath, absolutePath);
    filesByAbsolutePath.set(absolutePath, projectPath);
    checkSourceFile(projectPath, sourceFile, diagnostics, exceptions);
  }
  checkPackageJson(rootDirectory, diagnostics, exceptions);
  checkArchitecture(sourceFiles, absolutePaths, filesByAbsolutePath, (finding) => {
    addFinding(
      diagnostics,
      exceptions,
      diagnostic(finding.rule, "error", finding.path, finding.message, finding.line),
    );
  });
  for (const exception of exceptions) {
    if (!exception.isUsed && !coverageExceptionRules.has(exception.rule)) {
      diagnostics.push(
        diagnostic(
          "quality-exceptions",
          "error",
          "quality-exceptions.json",
          `Unused exception for ${exception.path} (${exception.rule}).`,
        ),
      );
    }
  }
  return diagnostics.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.rule.localeCompare(right.rule),
  );
}
