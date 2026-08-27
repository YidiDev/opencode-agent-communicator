import { describe, expect, test } from "bun:test";

describe("publish workflow trust gate", () => {
  test("gates all release work on the tagged commit being reachable from fetched main", async () => {
    const workflow = await Bun.file(".github/workflows/publish.yml").text();
    const checkout = workflow.indexOf("ref: $" + "{{ github.sha }}");
    const fetch = workflow.indexOf("+refs/heads/main:refs/remotes/origin/main");
    const ancestry = workflow.indexOf(
      'git merge-base --is-ancestor "$RELEASE_COMMIT" refs/remotes/origin/main',
    );
    const verification = workflow.indexOf("verification:");

    expect(checkout).toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(checkout);
    expect(ancestry).toBeGreaterThan(fetch);
    expect(verification).toBeGreaterThan(ancestry);
    expect(workflow).toContain("needs: metadata");
    expect(workflow).toContain("needs: archive");
  });

  test("does not install packages in the OIDC job and independently binds the archive digest", async () => {
    const workflow = await Bun.file(".github/workflows/publish.yml").text();
    const publishJob = workflow.slice(workflow.indexOf("  publish:"));

    expect(publishJob).toContain("id-token: write");
    expect(publishJob).toContain("node-version: 24.6.0");
    expect(publishJob).toContain('test "$(npm --version)" = "11.5.1"');
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
});
