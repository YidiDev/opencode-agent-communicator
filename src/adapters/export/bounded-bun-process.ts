import type { SessionExportLimits } from "./export-limits";

export interface ExportSpawnInput {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ExportChildProcess {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal: number): void;
}

export interface ExportSpawnPort {
  spawn(input: ExportSpawnInput): ExportChildProcess;
  killTree(process: ExportChildProcess, signal: number): void;
}

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

export type BoundedProcessOutcome =
  | { readonly kind: "completed"; readonly exitCode: number; readonly stdout: Uint8Array }
  | { readonly kind: "limit" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "failed" };

interface RunBoundedProcessInput extends ExportSpawnInput {
  readonly abort: AbortSignal;
  readonly deadlineMs: number;
  readonly stdoutLimit: number;
  readonly limits: SessionExportLimits;
  readonly onStdout?: (chunk: Uint8Array) => void;
}

interface SpawnedProcessCapabilities {
  readonly child: object;
  readonly pid: number;
  readonly exited?: Promise<unknown>;
  readonly kill?: (signal: number) => void;
}

function spawnedProcessCapabilities(value: unknown): SpawnedProcessCapabilities | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null)
    return undefined;
  let pid: unknown;
  try {
    pid = Reflect.get(value, "pid");
  } catch {
    return undefined;
  }
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) return undefined;

  let exited: unknown;
  let kill: unknown;
  try {
    exited = Reflect.get(value, "exited");
  } catch {
    // A valid PID still has to be cleaned up even when another capability is hostile.
  }
  try {
    kill = Reflect.get(value, "kill");
  } catch {
    // Process-tree signaling remains available through the spawn port.
  }
  if (exited instanceof Promise) observe(exited);
  return {
    child: value,
    pid: pid as number,
    ...(exited instanceof Promise ? { exited } : {}),
    ...(typeof kill === "function"
      ? { kill: (signal: number) => Reflect.apply(kill, value, [signal]) }
      : {}),
  };
}

function signalSpawnedProcess(
  spawn: ExportSpawnPort,
  capabilities: SpawnedProcessCapabilities,
  signal: number,
): boolean {
  try {
    spawn.killTree(capabilities.child as ExportChildProcess, signal);
    return true;
  } catch {
    try {
      capabilities.kill?.(signal);
    } catch {
      // No remaining valid signaling capability exists.
    }
    return false;
  }
}

async function waitForExitOrGrace(exited: Promise<unknown>, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function confirmExitWithinGrace(exited: Promise<unknown>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function containedFailure(didTerminate: boolean): BoundedProcessOutcome {
  return didTerminate ? { kind: "failed" } : { kind: "ambiguous" };
}

async function terminate(
  spawn: ExportSpawnPort,
  capabilities: SpawnedProcessCapabilities,
  graceMs: number,
): Promise<boolean> {
  let signalFailed = !signalSpawnedProcess(spawn, capabilities, 15);
  if (capabilities.exited) {
    try {
      // Escalate as soon as the group leader exits. Descendants can retain the process group, and
      // avoiding an unconditional grace-period delay narrows the window for an empty PGID to be
      // reused without weakening tree termination.
      await waitForExitOrGrace(capabilities.exited, graceMs);
    } catch {
      // The bounded confirmation below determines whether containment is proven.
    }
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, graceMs));
  }
  signalFailed = !signalSpawnedProcess(spawn, capabilities, 9) || signalFailed;
  if (!capabilities.exited) return false;
  return (await confirmExitWithinGrace(capabilities.exited, graceMs)) && !signalFailed;
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  onChunk?: (chunk: Uint8Array) => void,
  readers?: ReadableStreamDefaultReader<Uint8Array>[],
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  readers?.push(reader);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new Error("Process stream was malformed.");
      total += next.value.byteLength;
      if (total > maximumBytes) throw new StreamLimitFault();
      onChunk?.(next.value);
      chunks.push(next.value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function observe(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

function cancelReaders(readers: readonly ReadableStreamDefaultReader<Uint8Array>[]): void {
  for (const reader of readers) {
    try {
      observe(reader.cancel());
    } catch {
      // Termination still provides the finite boundary when a stream implementation is hostile.
    }
  }
}

class StreamLimitFault extends Error {
  override readonly name = "StreamLimitFault";
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
