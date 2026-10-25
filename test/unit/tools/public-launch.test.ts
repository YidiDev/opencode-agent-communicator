import { expect, test } from "bun:test";
import { assertStableReadiness, runtimeDigest } from "../../../tools/release-policy.mjs";

test("public installation examples use native v2 plugin objects and valid JSON", async () => {
  const readme = await Bun.file("README.md").text();
  const examples = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const configurations = examples.filter((value) => value?.includes('"plugins"'));
  expect(configurations).toHaveLength(2);
  for (const value of configurations) {
    const config = JSON.parse(value ?? "");
    expect(config.plugins[0].package).toEndWith("/src");
    expect(config.plugins[0].options.policies.start).toBe("deny");
  }
  expect(readme).not.toContain('"plugin":');
  const options = (await Bun.file("docs/plugin-configuration.md").text()).match(
    /```json\n([\s\S]*?)\n```/,
  )?.[1];
  expect(JSON.parse(options ?? "").package).toEndWith("/src");
});

test("release bot prepares PRs without publishing or impersonating the human author", async () => {
  const source = await Bun.file(".github/workflows/release-please.yml").text();
  const workflow = Bun.YAML.parse(source) as {
    jobs: Record<
      string,
      {
        permissions: Record<string, string>;
        steps: Array<{ run?: string; with?: Record<string, unknown> }>;
      }
    >;
  };
  expect(workflow.jobs.prepare?.permissions).toEqual({
    contents: "write",
    "pull-requests": "write",
  });
  expect(workflow.jobs.prepare?.steps.some((s) => s.with?.["skip-github-release"] === true)).toBe(
    true,
  );
  expect(workflow.jobs["verify-pr"]?.permissions.actions).toBe("write");
  expect(source).toContain("gh workflow run ci.yml");
  expect(source).not.toMatch(/GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)/);
  expect(source).not.toContain("id-token: write");
  const policy = JSON.parse(await Bun.file("release-readiness.json").text());
  expect(policy.schema_version).toBe(1);
  const metadata = JSON.parse(await Bun.file("package.json").text());
  const digest = await runtimeDigest(process.cwd());
  expect(() => assertStableReadiness(metadata.version, policy, digest)).not.toThrow();
});
