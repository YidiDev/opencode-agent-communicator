import { expect, test } from "bun:test";

import {
  bunExportSpawnPort,
  runBoundedBunProcess,
} from "../../../../src/adapters/export/bounded-bun-process";
import { createSessionExportLimits } from "../../../../src/adapters/export/export-limits";

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(20);
  }
  return false;
}

test.skipIf(process.platform !== "linux")(
  "Bun process adapter terminates an observed descendant tree on abort",
  async () => {
    const controller = new AbortController();
    let descendantPid: number | undefined;
    const script = [
      'const {spawn}=require("node:child_process");',
      'process.on("SIGTERM",()=>{});',
      'const child=spawn(process.execPath,["-e","process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},10000)"],{stdio:["ignore","inherit","inherit"]});',
      'process.stdout.write(String(child.pid)+"\\n");',
      "setInterval(()=>{},10000);",
    ].join("");
    const result = await runBoundedBunProcess(bunExportSpawnPort, {
      command: process.execPath,
      arguments: ["-e", script],
      cwd: "/tmp",
      environment: {},
      abort: controller.signal,
      deadlineMs: Date.now() + 5_000,
      stdoutLimit: 128,
      limits: createSessionExportLimits({ maximumDurationMs: 5_000 }),
      onStdout(chunk) {
        const value = Number(new TextDecoder().decode(chunk).trim());
        if (Number.isSafeInteger(value) && value > 0) {
          descendantPid = value;
          controller.abort();
        }
      },
    });
    expect(result).toEqual({ kind: "ambiguous" });
    expect(descendantPid).toBeNumber();
    const observedPid = descendantPid;
    if (observedPid !== undefined) {
      expect(await waitForProcessExit(observedPid)).toBe(true);
    }
  },
);
