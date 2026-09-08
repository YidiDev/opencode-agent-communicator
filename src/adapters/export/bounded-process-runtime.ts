import type {
  BoundedProcessOutcome,
  ExportChildProcess,
  ExportSpawnPort,
} from "./bounded-process-contracts";

export interface SpawnedProcessCapabilities {
  readonly child: object;
  readonly pid: number;
  readonly exited?: Promise<unknown>;
  readonly kill?: (signal: number) => void;
}

export function spawnedProcessCapabilities(value: unknown): SpawnedProcessCapabilities | undefined {
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

export function containedFailure(didTerminate: boolean): BoundedProcessOutcome {
  return didTerminate ? { kind: "failed" } : { kind: "ambiguous" };
}

export async function terminate(
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

export async function collect(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  onChunk?: (chunk: Uint8Array) => void,
  readers?: ReadableStreamDefaultReader<Uint8Array>[],
  shouldRetain = true,
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
      if (shouldRetain) chunks.push(next.value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(shouldRetain ? total : 0);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function observe(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

export function cancelReaders(readers: readonly ReadableStreamDefaultReader<Uint8Array>[]): void {
  for (const reader of readers) {
    try {
      observe(reader.cancel());
    } catch {
      // Termination still provides the finite boundary when a stream implementation is hostile.
    }
  }
}

export class StreamLimitFault extends Error {
  override readonly name = "StreamLimitFault";
}
