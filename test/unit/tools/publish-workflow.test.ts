import { describe, expect, test } from "bun:test";

describe("publish workflow trust gate", () => {
  test("automatically accepts version tags while retaining guarded manual recovery", async () => {
    const workflow = await Bun.file(".github/workflows/publish.yml").text();

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toMatch(/push:\s*\n\s*tags:/);
    expect(workflow).toContain("node tools/release-policy.mjs");
    expect(workflow).toContain('test "$(gh api "repos/$GITHUB_REPOSITORY" --jq .private)" = false');
  });

  test("gates all release work on the tagged commit being reachable from fetched main", async () => {
    const workflow = await Bun.file(".github/workflows/publish.yml").text();
    const checkout = workflow.indexOf("ref: $" + "{{ github.sha }}");
    const fullHistory = workflow.indexOf("fetch-depth: 0");
    const ancestry = workflow.indexOf(
      'git merge-base --is-ancestor "$RELEASE_COMMIT" refs/remotes/origin/main',
    );
    const verification = workflow.indexOf("verification:");

    expect(checkout).toBeGreaterThan(-1);
    expect(fullHistory).toBeGreaterThan(checkout);
    expect(ancestry).toBeGreaterThan(fullHistory);
    expect(verification).toBeGreaterThan(ancestry);
    expect(workflow).toContain("needs: metadata");
    expect(workflow).toContain("needs: [metadata, archive]");
  });

  test("requires every invocation to select the exact package tag rather than a named branch", async () => {
    const workflow = await Bun.file(".github/workflows/publish.yml").text();

    expect(workflow).toContain("RELEASE_REF: $" + "{{ github.ref }}");
    expect(workflow).toContain("RELEASE_REF_TYPE: $" + "{{ github.ref_type }}");
    expect(workflow).toContain('test "$RELEASE_REF_TYPE" = "tag"');
    expect(workflow).toContain('test "$RELEASE_REF" = "refs/tags/v$package_version"');
  });

  test("does not install packages in the OIDC job and independently binds the archive digest", async () => {
    const workflow = await Bun.file(".github/workflows/publish.yml").text();
    const publishJob = workflow.slice(
      workflow.indexOf("  publish:"),
      workflow.indexOf("  consumer:"),
    );

    expect(publishJob).toContain("id-token: write");
    expect(publishJob).toContain("node-version: 24.22.1");
    expect(publishJob).toContain('test "$(npm --version)" = "11.19.1"');
    expect(publishJob).not.toMatch(/\bnpm\s+(?:i|install|ci)\b/);
    expect(publishJob).not.toContain("bun install");
    expect(workflow).toContain(
      "archive_sha256: $" + "{{ steps.release_evidence.outputs.archive_sha256 }}",
    );
    expect(publishJob).toContain(
      "EXPECTED_ARCHIVE_SHA256: $" + "{{ needs.archive.outputs.archive_sha256 }}",
    );
    expect(publishJob).toContain(
      'test "$(sha256sum "$archive" | cut -d \' \' -f 1)" = "$EXPECTED_ARCHIVE_SHA256"',
    );
  });
  test("uses one archive and verifies public installation before publishing GitHub assets", async () => {
    const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/publish.yml").text()) as {
      jobs: Record<
        string,
        {
          needs?: string[];
          environment?: string;
          permissions?: Record<string, string>;
          steps?: Array<{ run?: string }>;
        }
      >;
    };
    expect(workflow.jobs.publish?.environment).toBe("release");
    expect(workflow.jobs.publish?.permissions?.["id-token"]).toBe("write");
    expect(workflow.jobs.consumer?.permissions?.["id-token"]).toBeUndefined();
    expect(workflow.jobs.consumer?.needs).toContain("archive");
    const consumer = workflow.jobs.consumer?.steps?.map((s) => s.run ?? "").join("\n") ?? "";
    expect(consumer.indexOf("npm audit signatures")).toBeLessThan(
      consumer.indexOf("node ../tools/release-provenance.mjs"),
    );
    expect(workflow.jobs["github-release"]?.needs).toContain("consumer");
    const publication = workflow.jobs.publish?.steps?.map((s) => s.run ?? "").join("\n");
    expect(publication).toContain('--ignore-scripts --tag "$NPM_DIST_TAG"');
    expect(publication).toContain("--verify-download");
    const assets = workflow.jobs["github-release"]?.steps?.map((s) => s.run ?? "").join("\n");
    expect(assets).toContain("--draft");
    expect(assets).toContain("diff -r release uploaded");
    expect(assets).not.toContain("--clobber");
  });
});
