import { describe, expect, test } from "bun:test";

const skillNames = ["session-orchestrator", "session-worker"] as const;

function parseFrontmatter(content: string): Readonly<Record<string, string>> {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1];
  if (frontmatter === undefined) throw new Error("SKILL.md must start with YAML frontmatter");

  return Object.fromEntries(
    frontmatter.split("\n").map((line) => {
      const separator = line.indexOf(":");
      if (separator < 1) throw new Error(`invalid frontmatter line: ${line}`);
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }),
  );
}

describe("bundled skill frontmatter", () => {
  for (const skillName of skillNames) {
    test(`${skillName} follows OpenCode skill naming and discovery rules`, async () => {
      const path = `${import.meta.dir}/../../../skills/${skillName}/SKILL.md`;
      const file = Bun.file(path);
      expect(await file.exists()).toBe(true);

      const frontmatter = parseFrontmatter(await file.text());
      expect(Object.keys(frontmatter).sort()).toEqual(["description", "name"]);
      expect(frontmatter.name).toBe(skillName);
      expect(frontmatter.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(frontmatter.name?.length).toBeLessThanOrEqual(64);
      expect(frontmatter.description).toMatch(/^.+\bUse when\b.+\.$/);
    });
  }
});
