import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";

import type { ProcessCapture } from "./types";

const maximumCapturedBytes = 4 * 1024 * 1024;

function append(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next) > maximumCapturedBytes) {
    throw new Error("model evaluation process output exceeded 4 MiB");
  }
  return next;
}

function terminate(
  child: ChildProcessByStdio<null, Readable, Readable>,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-pid, signal);
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

export async function runEvaluationProcess(options: {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly deadlineMs: number;
}): Promise<ProcessCapture> {
  const child = spawn(options.command, [...options.arguments], {
    cwd: options.cwd,
    env: { ...options.environment },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    terminate(child, "SIGTERM");
    setTimeout(() => terminate(child, "SIGKILL"), 15_000).unref();
  }, options.deadlineMs);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  }).finally(() => clearTimeout(deadline));
  return {
    exitCode: timedOut ? 124 : exitCode,
    stdout,
    stderr: timedOut ? `${stderr}\nmodel evaluation process timed out\n` : stderr,
  };
}
