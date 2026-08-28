import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bunExportSpawnPort,
  type ExportChildProcess,
} from "../../../../src/adapters/export/bounded-bun-process";
import { LinuxExportRoot } from "../../../../src/adapters/export/linux-export-destination";

const roots: string[] = [];

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("refactored export adapter boundaries", () => {
  test("propagates process-group signaling errors other than an already-exited process", () => {
    const child: ExportChildProcess = {
      pid: Number.NaN,
      stdout: emptyStream(),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
      kill: () => undefined,
    };

    expect(() => bunExportSpawnPort.killTree(child, 0)).toThrow();
  });

  test("maps a native temporary sync failure to storage unavailable and finalizes the temporary", () => {
    const base = mkdtempSync(join(tmpdir(), "communicator-export-sync-fault-"));
    chmodSync(base, 0o700);
    roots.push(base);
    using root = LinuxExportRoot.open(join(base, "exports"));
    const temporary = root.createTemporary("capture.json", "9".repeat(32));
    closeSync(temporary.descriptor);

    expect(() => temporary.install(false)).toThrow(
      expect.objectContaining({ kind: "storage_unavailable" }),
    );
    expect(() => temporary.discard()).not.toThrow();
  });
});
