import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

import ts from "typescript-compiler-api";

const sourceExtensions = new Set([".cts", ".mts", ".ts", ".tsx"]);

function hasDeclareModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ??
        false)
    : false;
}

function importHasRuntime(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function exportHasRuntime(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) return false;
  if (!statement.exportClause) return true;
  if (ts.isNamespaceExport(statement.exportClause)) return true;
  return statement.exportClause.elements.some((element) => !element.isTypeOnly);
}

function statementHasRuntime(statement: ts.Statement): boolean {
  if (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEmptyStatement(statement)
  ) {
    return false;
  }
  if (ts.isImportDeclaration(statement)) return importHasRuntime(statement);
  if (ts.isExportDeclaration(statement)) return exportHasRuntime(statement);
  if (ts.isFunctionDeclaration(statement) && !statement.body) return false;
  return !hasDeclareModifier(statement);
}

export function sourceHasRuntimeCode(path: string, source: string): boolean {
  const kind = path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, kind);
  return sourceFile.statements.some(statementHasRuntime);
}

export function toProjectPath(rootDirectory: string, path: string): string | undefined {
  const projectPath = relative(rootDirectory, resolve(path)).split(sep).join("/");
  return projectPath === ".." || projectPath.startsWith("../") ? undefined : projectPath;
}

export function collectRuntimeSourceFiles(rootDirectory: string): string[] {
  const root = resolve(rootDirectory);
  const sourceRoot = join(root, "src");
  if (!existsSync(sourceRoot)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.isFile() &&
        sourceExtensions.has(extname(entry.name)) &&
        sourceHasRuntimeCode(path, readFileSync(path, "utf8"))
      ) {
        const projectPath = toProjectPath(root, path);
        if (projectPath) files.push(projectPath);
      }
    }
  };
  visit(sourceRoot);
  return files.sort();
}
