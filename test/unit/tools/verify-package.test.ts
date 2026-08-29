import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPackedSourceHasNoSymlink,
  assertSafePackedPath,
  expectedPackedPathPolicy,
  expectedToolIds,
  packedPathFingerprint,
} from "../../../tools/verify-package.mjs";

describe("release package policy", () => {
  test("pins the exact ordered public tool IDs", () => {
    expect(expectedToolIds).toEqual([
      "session_list",
      "session_lock_list",
      "session_lock_publish",
      "session_lock_release",
      "session_lock_renew",
      "session_send",
      "session_delivery_get",
      "session_ask",
      "session_respond",
      "session_wait",
      "session_signal",
      "session_request_list",
      "session_request_get",
      "session_request_ack",
      "session_request_cancel",
      "session_stop",
      "session_start",
      "session_export",
    ]);
  });

  test("makes additions, removals, and ordering changes alter the path policy", () => {
    const paths = ["README.md", "package.json", "src/index.ts"];
    expect(packedPathFingerprint(paths)).not.toBe(packedPathFingerprint([...paths, "src/new.ts"]));
    expect(packedPathFingerprint(paths)).not.toBe(packedPathFingerprint([...paths].reverse()));
    expect(expectedPackedPathPolicy.entryCount).toBeGreaterThan(paths.length);
  });

  test("rejects symlink-adjacent, secret-like, generated, and non-canonical names", () => {
    for (const path of [
      ".env",
      ".env.production",
      "src/private-key.pem",
      "src/token.txt",
      "dist/index.js",
      "coverage/lcov.info",
      "src/index.js.map",
      "src/../README.md",
      "/etc/passwd",
      "src\\index.ts",
    ]) {
      expect(() => assertSafePackedPath(path)).toThrow("Package verification failed");
    }
    expect(() => assertSafePackedPath("docs/session-export-security.md")).not.toThrow();
  });

  test("rejects a packed source reached through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "package-policy-"));
    try {
      await writeFile(join(root, "real.ts"), "export {};\n");
      await symlink("real.ts", join(root, "linked.ts"));
      await expect(assertPackedSourceHasNoSymlink(root, "linked.ts")).rejects.toThrow(
        "archive source is a symlink",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
