import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { liveDeadlineMs, maximumCapturedProcessBytes } from "./constants";

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type HarnessChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface ManagedProcess {
  readonly child: HarnessChildProcess;
  readonly stderr: () => string;
  terminate(): Promise<void>;
}

interface SpawnOptions {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly deadlineMs?: number;
}

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next) > maximumCapturedProcessBytes) {
    throw new Error("child process output exceeded the live harness bound");
  }
  return next;
}

function signalProcessTree(child: HarnessChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

function waitForExit(child: HarnessChildProcess, deadlineMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("child process did not exit before deadline")),
      deadlineMs,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function launchManagedProcess(options: SpawnOptions): ManagedProcess {
  const child = spawn(options.command, [...options.arguments], {
    cwd: options.cwd,
    env: { ...options.environment },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });

  return {
    child,
    stderr: () => stderr,
    async terminate(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      signalProcessTree(child, "SIGTERM");
      try {
        await waitForExit(child, 2_000);
      } catch {
        signalProcessTree(child, "SIGKILL");
        await waitForExit(child, 2_000);
      }
    },
  };
}

export async function runBoundedProcess(options: SpawnOptions): Promise<ProcessResult> {
  const managed = launchManagedProcess(options);
  let stdout = "";
  managed.child.stdout.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  const deadlineMs = options.deadlineMs ?? liveDeadlineMs;
  const deadline = setTimeout(() => signalProcessTree(managed.child, "SIGKILL"), deadlineMs);
  try {
    await waitForExit(managed.child, deadlineMs + 2_000);
  } finally {
    clearTimeout(deadline);
    await managed.terminate();
  }
  const exitCode = managed.child.exitCode;
  if (exitCode === null) throw new Error("child process ended without an exit code");
  return { exitCode, stdout, stderr: managed.stderr() };
}

export async function waitForOutputLine(
  child: HarnessChildProcess,
  predicate: (line: string) => string | undefined,
  deadlineMs = liveDeadlineMs,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = "";
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const succeed = (value: string): void => {
      cleanup();
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      pending = appendBounded(pending, chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const value = predicate(line);
        if (value !== undefined) {
          succeed(value);
          return;
        }
      }
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error("child exited before emitting its readiness line"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("readiness line deadline exceeded"));
    }, deadlineMs);
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
