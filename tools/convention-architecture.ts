import { dirname, extname, join, resolve } from "node:path";

import ts from "typescript";

type Layer = "domain" | "application" | "tools" | "native" | "store" | "export" | "composition";

export interface ArchitectureFinding {
  readonly rule: "architecture" | "import-cycle";
  readonly path: string;
  readonly message: string;
  readonly line?: number;
}

function getLayer(projectPath: string): Layer | undefined {
  if (projectPath === "src/index.ts" || projectPath.startsWith("src/composition/")) {
    return "composition";
  }
  if (projectPath.startsWith("src/domain/")) return "domain";
  if (projectPath.startsWith("src/application/")) return "application";
  if (projectPath.startsWith("src/tools/")) return "tools";
  if (projectPath.startsWith("src/adapters/native/")) return "native";
  if (projectPath.startsWith("src/adapters/store/")) return "store";
  if (projectPath.startsWith("src/adapters/export/")) return "export";
  return undefined;
}

function moduleSpecifiers(sourceFile: ts.SourceFile): Array<{ specifier: string; line: number }> {
  const imports: Array<{ specifier: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    let value: ts.Expression | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) value = node.moduleSpecifier;
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      value = node.moduleReference.expression;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length === 1
    ) {
      value = node.arguments[0];
    }
    if (value && ts.isStringLiteralLike(value)) {
      imports.push({
        specifier: value.text,
        line: sourceFile.getLineAndCharacterOfPosition(value.getStart(sourceFile)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function resolveLocalImport(
  importingPath: string,
  specifier: string,
  filesByAbsolutePath: ReadonlyMap<string, string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(importingPath), specifier);
  const candidates = extname(base)
    ? [base, base.replace(/\.[cm]?js$/, ".ts")]
    : [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.map((path) => filesByAbsolutePath.get(path)).find((path) => path !== undefined);
}

function isForbiddenExternal(layer: Layer, specifier: string): boolean {
  const isOpenCode = specifier.startsWith("@opencode-ai/");
  const isFileSystem = /^(?:node:)?(?:fs|path)(?:\/|$)/.test(specifier);
  const isSqlite = /sqlite/i.test(specifier);
  const isBun = specifier === "bun" || specifier.startsWith("bun:");
  if (layer === "domain") return isOpenCode || isFileSystem || isSqlite || isBun;
  if (layer === "tools") return isOpenCode || isFileSystem || isSqlite;
  return false;
}

function isAllowedLayerImport(from: Layer, to: Layer): boolean {
  if (from === "composition") return true;
  if (from === "domain") return to === "domain";
  if (from === "application") return to === "application" || to === "domain";
  if (from === "tools") return to === "tools" || to === "application" || to === "domain";
  return to === from || to === "application" || to === "domain";
}

function checkCycles(
  graph: ReadonlyMap<string, readonly string[]>,
  report: (finding: ArchitectureFinding) => void,
): void {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const reported = new Set<string>();
  const visit = (path: string): void => {
    if (active.has(path)) {
      const cycleStart = stack.indexOf(path);
      const cycle = [...stack.slice(cycleStart), path];
      const members = cycle.slice(0, -1).sort();
      const identity = members.join("\0");
      if (!reported.has(identity)) {
        reported.add(identity);
        for (const member of members) {
          report({
            rule: "import-cycle",
            path: member,
            message: `Import cycle: ${cycle.join(" -> ")}.`,
          });
        }
      }
      return;
    }
    if (visited.has(path)) return;
    visited.add(path);
    active.add(path);
    stack.push(path);
    for (const dependency of graph.get(path) ?? []) visit(dependency);
    stack.pop();
    active.delete(path);
  };
  for (const path of graph.keys()) visit(path);
}

export function checkArchitecture(
  sourceFiles: ReadonlyMap<string, ts.SourceFile>,
  projectToAbsolutePath: ReadonlyMap<string, string>,
  absoluteToProjectPath: ReadonlyMap<string, string>,
  report: (finding: ArchitectureFinding) => void,
): void {
  const graph = new Map<string, string[]>();
  for (const [projectPath, sourceFile] of sourceFiles) {
    if (!projectPath.startsWith("src/")) continue;
    const layer = getLayer(projectPath);
    if (!layer) {
      report({
        rule: "architecture",
        path: projectPath,
        message: "Source file is outside a declared layer.",
      });
      continue;
    }
    const dependencies: string[] = [];
    const absolutePath = projectToAbsolutePath.get(projectPath);
    if (!absolutePath) continue;
    for (const imported of moduleSpecifiers(sourceFile)) {
      const target = resolveLocalImport(absolutePath, imported.specifier, absoluteToProjectPath);
      if (target) dependencies.push(target);
      const targetLayer = target ? getLayer(target) : undefined;
      if (
        isForbiddenExternal(layer, imported.specifier) ||
        (targetLayer !== undefined && !isAllowedLayerImport(layer, targetLayer))
      ) {
        report({
          rule: "architecture",
          path: projectPath,
          line: imported.line,
          message: `Layer "${layer}" must not import "${imported.specifier}".`,
        });
      }
    }
    graph.set(
      projectPath,
      dependencies.filter((path) => path.startsWith("src/")),
    );
  }
  checkCycles(graph, report);
}
