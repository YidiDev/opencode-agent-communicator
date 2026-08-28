import type { LinuxPathSyscalls } from "./store-types";

export function descriptorPath(descriptor: number, name?: string): string {
  const base = `/proc/self/fd/${descriptor}`;
  return name === undefined ? base : `${base}/${name}`;
}

export function errorCode(cause: unknown): unknown {
  return cause instanceof Error && "code" in cause ? cause.code : undefined;
}

export function safelyClose(syscalls: LinuxPathSyscalls, descriptor: number): void {
  try {
    syscalls.close(descriptor);
  } catch {
    // Closing after another failure is best effort; the original safe diagnostic wins.
  }
}
