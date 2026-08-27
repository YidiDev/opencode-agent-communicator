import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveWorkspaceKey } from "../../../src/composition/workspace";

describe("workspace identity", () => {
  test("is stable, directory-sensitive, and does not leak canonical paths", () => {
    const root = mkdtempSync(join(tmpdir(), "communicator-workspace-"));
    const nested = join(root, "nested");
    mkdirSync(nested);
    try {
      const first = deriveWorkspaceKey({
        project: { id: "project-1" },
        worktree: root,
        directory: root,
      });
      const repeated = deriveWorkspaceKey({
        project: { id: "project-1" },
        worktree: root,
        directory: root,
      });
      const nestedKey = deriveWorkspaceKey({
        project: { id: "project-1" },
        worktree: root,
        directory: nested,
      });
      expect(first).toBe(repeated);
      expect(first).not.toBe(nestedKey);
      expect(first).not.toContain(root);
      expect(first).toMatch(/^wrk_[0-9a-f]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a canonical directory outside its worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "communicator-worktree-"));
    const sibling = mkdtempSync(join(tmpdir(), "communicator-sibling-"));
    try {
      expect(() =>
        deriveWorkspaceKey({ project: { id: "project-1" }, worktree: root, directory: sibling }),
      ).toThrow("contained");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test("rejects malformed project identities and non-absolute workspace paths", () => {
    for (const project of [null, {}, { id: "" }, { id: "x".repeat(513) }]) {
      expect(() => deriveWorkspaceKey({ project, worktree: "/tmp", directory: "/tmp" })).toThrow(
        "Project identity",
      );
    }
    expect(() =>
      deriveWorkspaceKey({ project: { id: "project-1" }, worktree: ".", directory: "/tmp" }),
    ).toThrow("absolute");
    expect(() =>
      deriveWorkspaceKey({ project: { id: "project-1" }, worktree: "/tmp", directory: "." }),
    ).toThrow("absolute");
  });
});
