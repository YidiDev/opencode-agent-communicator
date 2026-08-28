import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ConventionDiagnostic, checkConventions } from "../../../tools/check-conventions";

const temporaryRoots: string[] = [];

function write(root: string, projectPath: string, contents: string): void {
  const path = join(root, projectPath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "convention-checker-"));
  temporaryRoots.push(root);
  write(
    root,
    "package.json",
    JSON.stringify({
      packageManager: "bun@1.4.0",
      dependencies: { example: "1.2.3" },
      devDependencies: { typescript: "5.9.3" },
    }),
  );
  write(root, "quality-exceptions.json", JSON.stringify({ exceptions: [] }));
  return root;
}

function lines(count: number, content = ""): string {
  return Array.from({ length: count }, () => content).join("\n");
}

function findings(root: string, rule: string): ConventionDiagnostic[] {
  return checkConventions({ rootDirectory: root }).filter((item) => item.rule === rule);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("physical line limits", () => {
  test("applies source warning and error boundaries", () => {
    const root = createRepository();
    const path = "src/domain/large.ts";

    write(root, path, `${lines(300, "export {};")}\n`);
    expect(findings(root, "source-file-lines")).toHaveLength(0);
    write(root, path, lines(301, "export {};"));
    expect(findings(root, "source-file-lines").map((item) => item.severity)).toEqual(["warning"]);
    write(root, path, lines(500, "export {};"));
    expect(findings(root, "source-file-lines").map((item) => item.severity)).toEqual(["warning"]);
    write(root, path, lines(501, "export {};"));
    expect(findings(root, "source-file-lines").map((item) => item.severity)).toEqual(["error"]);
  });

  test("applies test and function boundaries", () => {
    const root = createRepository();
    const testPath = "test/unit/domain/large.test.ts";
    write(root, testPath, lines(800, "export {};"));
    expect(findings(root, "test-file-lines")).toHaveLength(0);
    write(root, testPath, lines(801, "export {};"));
    expect(findings(root, "test-file-lines")).toHaveLength(1);

    const functionPath = "src/domain/function.ts";
    write(root, functionPath, `export function boundary() {\n${lines(198)}\n}`);
    expect(findings(root, "function-lines")).toHaveLength(0);
    write(root, functionPath, `export function overLimit() {\n${lines(199)}\n}`);
    expect(findings(root, "function-lines")).toHaveLength(1);
  });
});

describe("metadata and source directives", () => {
  test("requires exact installed versions and bounded peer ranges", () => {
    const root = createRepository();
    write(
      root,
      "package.json",
      JSON.stringify({
        packageManager: "bun@^1.4.0",
        dependencies: { example: "~1.2.3" },
        peerDependencies: {
          bounded: ">=2.0.0 <3.0.0",
          broad: "^2.0.0",
          inverted: ">=3.0.0 <2.0.0",
          empty: ">=2.0.0 <2.0.0",
          unsafe: ">=9007199254740992.0.0 <9007199254740993.0.0",
        },
      }),
    );

    expect(findings(root, "package-manager")).toHaveLength(1);
    expect(findings(root, "dependency-version")).toHaveLength(5);
  });

  test("rejects bare work markers and TypeScript suppressions", () => {
    const root = createRepository();
    write(
      root,
      "src/domain/directives.ts",
      ["// TODO", "// FIXME: explain migration", "// @ts-ignore", "export const value = 1;"].join(
        "\n",
      ),
    );
    write(
      root,
      "test/unit/domain/value.type-test.ts",
      "// @ts-expect-error explains the intentionally invalid assignment\nconst value: string = 1;",
    );
    write(root, "test/unit/domain/value.test.ts", "// @ts-expect-error missing type-level file");
    write(root, "test/unit/domain/missing.type-test.ts", "// @ts-expect-error");

    expect(findings(root, "work-marker")).toHaveLength(1);
    expect(findings(root, "ts-ignore")).toHaveLength(1);
    expect(findings(root, "ts-expect-error")).toHaveLength(2);
  });
});

describe("architecture", () => {
  test("allows intended direction and rejects inverted layer imports", () => {
    const root = createRepository();
    write(root, "src/domain/contract.ts", "export const contract = 1;");
    write(
      root,
      "src/application/coordinator.ts",
      'import { contract } from "../domain/contract";\nexport const coordinator = contract;',
    );
    write(
      root,
      "src/adapters/store/database.ts",
      'import { contract } from "../../domain/contract";\nexport const database = contract;',
    );
    write(
      root,
      "src/tools/handler.ts",
      'import { database } from "../adapters/store/database";\nexport const handler = database;',
    );
    write(
      root,
      "src/domain/inverted.ts",
      'import { coordinator } from "../application/coordinator";\nexport const inverted = coordinator;',
    );
    write(
      root,
      "src/index.ts",
      'import { database } from "./adapters/store/database";\nexport default database;',
    );

    expect(findings(root, "architecture").map((item) => item.path)).toEqual([
      "src/domain/inverted.ts",
      "src/tools/handler.ts",
    ]);
  });

  test("rejects forbidden domain platform imports and unknown source layers", () => {
    const root = createRepository();
    write(root, "src/domain/file.ts", 'import "node:fs";');
    write(root, "src/misc.ts", "export const misplaced = true;");

    expect(findings(root, "architecture").map((item) => item.path)).toEqual([
      "src/domain/file.ts",
      "src/misc.ts",
    ]);
  });

  test("reports every member of a local import cycle", () => {
    const root = createRepository();
    write(root, "src/domain/a.ts", 'export { b } from "./b";');
    write(root, "src/domain/b.ts", 'export { a } from "./a";');

    expect(findings(root, "import-cycle").map((item) => item.path)).toEqual([
      "src/domain/a.ts",
      "src/domain/b.ts",
    ]);
  });
});

describe("quality exceptions", () => {
  test("uses an exact path and rule only when it suppresses a finding", () => {
    const root = createRepository();
    write(root, "src/domain/large.ts", lines(301, "export {};"));
    write(
      root,
      "quality-exceptions.json",
      JSON.stringify({
        exceptions: [
          {
            path: "src/domain/large.ts",
            rule: "source-file-lines",
            reason: "The generated protocol vector is reviewed as one artifact.",
            removalCondition: "Remove when the upstream generator supports sharding.",
          },
        ],
      }),
    );

    expect(findings(root, "source-file-lines")).toHaveLength(0);
    expect(findings(root, "quality-exceptions")).toHaveLength(0);
    write(root, "src/domain/large.ts", lines(300, "export {};"));
    expect(findings(root, "quality-exceptions")).toHaveLength(1);
  });

  test("rejects malformed, duplicate, and nonexistent entries", () => {
    const root = createRepository();
    write(root, "src/domain/value.ts", "export const value = 1;");
    const valid = {
      path: "src/domain/value.ts",
      rule: "function-lines",
      reason: "A temporary exception.",
      removalCondition: "Remove after extraction.",
    };
    write(
      root,
      "quality-exceptions.json",
      JSON.stringify({
        exceptions: [
          valid,
          valid,
          { ...valid, path: "src/domain/missing.ts" },
          { path: "src/domain/value.ts", rule: "function-lines", reason: "Missing condition" },
        ],
      }),
    );

    expect(findings(root, "quality-exceptions")).toHaveLength(4);
  });

  test("validates coverage exception targets without declaring valid entries stale", () => {
    const root = createRepository();
    write(root, "src/domain/value.ts", "export const value = 1;");
    const exception = {
      path: "src/domain/value.ts",
      rule: "coverage-lines",
      reason: "Generated source is not reachable from the test process.",
      removalCondition: "Remove when source generation is replaced.",
    };
    write(root, "quality-exceptions.json", JSON.stringify({ exceptions: [exception] }));
    expect(findings(root, "quality-exceptions")).toHaveLength(0);

    write(
      root,
      "quality-exceptions.json",
      JSON.stringify({ exceptions: [{ ...exception, path: "test/unit/value.test.ts" }] }),
    );
    write(root, "test/unit/value.test.ts", "export {};");
    expect(findings(root, "quality-exceptions")).toHaveLength(1);
  });
});
