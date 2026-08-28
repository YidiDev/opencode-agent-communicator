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

export type BoundedProcessOutcome =
  | { readonly kind: "completed"; readonly exitCode: number; readonly stdout: Uint8Array }
  | { readonly kind: "limit" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "failed" };
