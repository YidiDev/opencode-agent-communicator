import type {
  BoundedProcessOutcome,
  ExportChildProcess,
  ExportSpawnInput,
  ExportSpawnPort,
} from "./bounded-process-contracts";
import {
  cancelReaders,
  collect,
  containedFailure,
  observe,
  type SpawnedProcessCapabilities,
  StreamLimitFault,
  spawnedProcessCapabilities,
  terminate,
} from "./bounded-process-runtime";
import type { SessionExportLimits } from "./export-limits";

export type {
  BoundedProcessOutcome,
  ExportChildProcess,
  ExportSpawnInput,
  ExportSpawnPort,
} from "./bounded-process-contracts";

function signalPid(pid: number, signal: number): void {
  try {
    process.kill(pid, signal);
  } catch (cause: unknown) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ESRCH") throw cause;
  }
}

export const bunExportSpawnPort: ExportSpawnPort = {
  spawn(input) {
    const child = Bun.spawn([input.command, ...input.arguments], {
      cwd: input.cwd,
      env: { ...input.environment },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    if (!child.stdout || !child.stderr)
      throw new Error("Bun did not create bounded process pipes.");
    return {
      pid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited,
      kill: (signal) => child.kill(signal),
    };
  },
  killTree(child, signal) {
    signalPid(-child.pid, signal);
  },
};

interface RunBoundedProcessInput extends ExportSpawnInput {
  readonly abort: AbortSignal;
  readonly deadlineMs: number;
  readonly stdoutLimit: number;
  readonly limits: SessionExportLimits;
  readonly onStdout?: (chunk: Uint8Array) => void;
}

export async function runBoundedBunProcess(
  spawn: ExportSpawnPort,
  input: RunBoundedProcessInput,
): Promise<BoundedProcessOutcome> {
  if (input.abort.aborted || Date.now() >= input.deadlineMs) return { kind: "ambiguous" };
  let child: ExportChildProcess;
  let capabilities: SpawnedProcessCapabilities;
  let spawnReturned = false;
  try {
    if (input.abort.aborted || Date.now() >= input.deadlineMs) return { kind: "ambiguous" };
    const spawned: unknown = spawn.spawn(input);
    spawnReturned = true;
    const observed = spawnedProcessCapabilities(spawned);
    if (!observed) return { kind: "ambiguous" };
    capabilities = observed;
    let stdout: unknown;
    let stderr: unknown;
    try {
      stdout = Reflect.get(observed.child, "stdout");
      stderr = Reflect.get(observed.child, "stderr");
    } catch {
      const didTerminate = await terminate(spawn, observed, input.limits.terminationGraceMs);
      return containedFailure(didTerminate);
    }
    if (
      !(stdout instanceof ReadableStream) ||
      !(stderr instanceof ReadableStream) ||
      !observed.exited ||
      !observed.kill
    ) {
      const didTerminate = await terminate(spawn, observed, input.limits.terminationGraceMs);
      return containedFailure(didTerminate);
    }
    child = {
      pid: observed.pid,
      stdout,
      stderr,
      exited: observed.exited as Promise<number>,
      kill: observed.kill,
    };
  } catch {
    return { kind: spawnReturned ? "ambiguous" : "failed" };
  }
  let expire: (() => void) | undefined;
  const expired = new Promise<"expired">((resolve) => {
    expire = () => resolve("expired");
  });
  const abort = (): void => expire?.();
  input.abort.addEventListener("abort", abort, { once: true });
  const timeoutMs = Math.max(
    1,
    Math.min(input.limits.maximumDurationMs, input.deadlineMs - Date.now()),
  );
  const timer = setTimeout(() => expire?.(), timeoutMs);
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const work = Promise.all([
    collect(child.stdout, input.stdoutLimit, input.onStdout, readers),
    collect(child.stderr, input.limits.maximumStderrBytes, undefined, readers),
    child.exited,
  ]);
  observe(work);
  try {
    const outcome = await Promise.race([work, expired]);
    if (outcome === "expired") {
      cancelReaders(readers);
      await terminate(spawn, capabilities, input.limits.terminationGraceMs);
      return { kind: "ambiguous" };
    }
    const [stdout, , exitCode] = outcome;
    return { kind: "completed", exitCode, stdout };
  } catch (cause: unknown) {
    cancelReaders(readers);
    const didTerminate = await terminate(spawn, capabilities, input.limits.terminationGraceMs);
    if (cause instanceof StreamLimitFault && didTerminate) return { kind: "limit" };
    if (cause instanceof StreamLimitFault) return { kind: "ambiguous" };
    return containedFailure(didTerminate);
  } finally {
    clearTimeout(timer);
    input.abort.removeEventListener("abort", abort);
  }
}
