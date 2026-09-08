import { describe, expect, test } from "bun:test";

import {
  bunExportSpawnPort,
  type ExportChildProcess,
  type ExportSpawnInput,
  type ExportSpawnPort,
  runBoundedBunProcess,
} from "../../../../src/adapters/export/bounded-bun-process";
import {
  createSessionExportLimits,
  ProcessLocalExportLimiter,
} from "../../../../src/adapters/export/export-limits";

function stream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

function boundedInput(overrides: Record<string, unknown> = {}) {
  return {
    command: "/trusted/opencode",
    arguments: ["--version"],
    cwd: "/",
    environment: {},
    abort: new AbortController().signal,
    deadlineMs: Date.now() + 1_000,
    stdoutLimit: 10,
    limits: createSessionExportLimits({ terminationGraceMs: 1 }),
    ...overrides,
  } as never;
}

describe("bounded Bun export process", () => {
  test("collects completed chunks and exposes each chunk to the bounded sink", async () => {
    const chunks: Uint8Array[] = [];
    const fake: ExportSpawnPort = {
      spawn: () => ({
        pid: 12,
        stdout: stream(new Uint8Array([1, 2])),
        stderr: stream(new Uint8Array()),
        exited: Promise.resolve(7),
        kill: () => undefined,
      }),
      killTree: () => undefined,
    };
    expect(
      await runBoundedBunProcess(
        fake,
        boundedInput({ onStdout: (value: Uint8Array) => chunks.push(value) }),
      ),
    ).toEqual({
      kind: "completed",
      exitCode: 7,
      stdout: new Uint8Array([1, 2]),
    });
    expect(chunks).toEqual([new Uint8Array([1, 2])]);
  });

  test("streams stdout without retaining a duplicate process buffer when requested", async () => {
    const chunks: Uint8Array[] = [];
    const fake: ExportSpawnPort = {
      spawn: () => ({
        pid: 16,
        stdout: stream(new Uint8Array([1, 2, 3])),
        stderr: stream(new Uint8Array()),
        exited: Promise.resolve(0),
        kill: () => undefined,
      }),
      killTree: () => undefined,
    };
    expect(
      await runBoundedBunProcess(
        fake,
        boundedInput({
          onStdout: (value: Uint8Array) => chunks.push(value),
          shouldRetainStdout: false,
        }),
      ),
    ).toEqual({ kind: "completed", exitCode: 0, stdout: new Uint8Array() });
    expect(chunks).toEqual([new Uint8Array([1, 2, 3])]);
  });

  test("classifies spawn, malformed-stream, and exit failures without throwing", async () => {
    const spawning: ExportSpawnPort = {
      spawn: () => {
        throw new Error("spawn denied");
      },
      killTree: () => undefined,
    };
    expect(await runBoundedBunProcess(spawning, boundedInput())).toEqual({ kind: "failed" });

    const malformed: ExportSpawnPort = {
      spawn: () => ({
        pid: 13,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue("not bytes" as never);
            controller.close();
          },
        }),
        stderr: stream(new Uint8Array()),
        exited: Promise.resolve(0),
        kill: () => undefined,
      }),
      killTree: () => undefined,
    };
    expect(await runBoundedBunProcess(malformed, boundedInput())).toEqual({ kind: "failed" });

    const rejectedExit: ExportSpawnPort = {
      spawn: () => ({
        pid: 14,
        stdout: stream(new Uint8Array()),
        stderr: stream(new Uint8Array()),
        exited: Promise.reject(new Error("wait failed")),
        kill: () => undefined,
      }),
      killTree: () => undefined,
    };
    expect(await runBoundedBunProcess(rejectedExit, boundedInput())).toEqual({
      kind: "ambiguous",
    });
  });

  test("treats an output limit as uncertain when process-tree signaling fails", async () => {
    const fake: ExportSpawnPort = {
      spawn: () => ({
        pid: 15,
        stdout: stream(new Uint8Array(2)),
        stderr: stream(new Uint8Array()),
        exited: Promise.resolve(0),
        kill: () => undefined,
      }),
      killTree: () => {
        throw new Error("signal failed");
      },
    };
    expect(await runBoundedBunProcess(fake, boundedInput({ stdoutLimit: 1 }))).toEqual({
      kind: "ambiguous",
    });
  });

  test("ignores an already-gone native process group", () => {
    expect(() =>
      bunExportSpawnPort.killTree(
        {
          pid: 2_000_000_000,
          stdout: stream(new Uint8Array()),
          stderr: stream(new Uint8Array()),
          exited: Promise.resolve(0),
          kill: () => undefined,
        },
        0,
      ),
    ).not.toThrow();
  });
});

describe("bounded Bun export process limits", () => {
  test("bounds stdout and stderr independently", async () => {
    const fake: ExportSpawnPort = {
      spawn(): ExportChildProcess {
        return {
          pid: 123,
          stdout: stream(new Uint8Array(5)),
          stderr: stream(new Uint8Array(1)),
          exited: Promise.resolve(0),
          kill: () => undefined,
        };
      },
      killTree: () => undefined,
    };
    expect(
      await runBoundedBunProcess(fake, {
        command: "/trusted/opencode",
        arguments: ["export", "ses_x"],
        cwd: "/private",
        environment: {},
        abort: new AbortController().signal,
        deadlineMs: Date.now() + 1_000,
        stdoutLimit: 4,
        limits: createSessionExportLimits({ maximumOutputBytes: 4, maximumStderrBytes: 1 }),
      }),
    ).toEqual({ kind: "limit" });
  });

  test("propagates abort and invokes process-tree termination without retry", async () => {
    const controller = new AbortController();
    const signals: number[] = [];
    let closeOutput: (() => void) | undefined;
    let settleExit: ((code: number) => void) | undefined;
    const fake: ExportSpawnPort = {
      spawn(_input: ExportSpawnInput): ExportChildProcess {
        queueMicrotask(() => controller.abort());
        return {
          pid: 456,
          stdout: new ReadableStream({ start: (output) => (closeOutput = () => output.close()) }),
          stderr: stream(new Uint8Array()),
          exited: new Promise((resolve) => (settleExit = resolve)),
          kill: () => undefined,
        };
      },
      killTree(_child, signal) {
        signals.push(signal);
        closeOutput?.();
        settleExit?.(143);
      },
    };
    const result = await runBoundedBunProcess(fake, {
      command: "/trusted/opencode",
      arguments: ["export", "ses_x"],
      cwd: "/private",
      environment: {},
      abort: controller.signal,
      deadlineMs: Date.now() + 1_000,
      stdoutLimit: 10,
      limits: createSessionExportLimits(),
    });
    expect(result).toEqual({ kind: "ambiguous" });
    expect(signals).toEqual([15, 9]);
  });

  test("uses bounded process-local concurrency and releases idempotently", () => {
    const limiter = new ProcessLocalExportLimiter(1);
    const release = limiter.tryAcquire();
    expect(release).toBeFunction();
    expect(limiter.tryAcquire()).toBeUndefined();
    release?.();
    release?.();
    expect(limiter.tryAcquire()).toBeFunction();
  });

  test("bounds sequential per-source and workspace spam in a fixed process-local window", () => {
    const limiter = new ProcessLocalExportLimiter(10, 2, 3);
    const first = limiter.tryAcquire({ source: "source-a", workspace: "workspace" }, 1_000);
    first?.();
    const second = limiter.tryAcquire({ source: "source-a", workspace: "workspace" }, 1_001);
    second?.();
    expect(
      limiter.tryAcquire({ source: "source-a", workspace: "workspace" }, 1_002),
    ).toBeUndefined();
    const third = limiter.tryAcquire({ source: "source-b", workspace: "workspace" }, 1_003);
    third?.();
    expect(
      limiter.tryAcquire({ source: "source-c", workspace: "workspace" }, 1_004),
    ).toBeUndefined();
    expect(
      limiter.tryAcquire({ source: "source-a", workspace: "workspace" }, 61_001),
    ).toBeFunction();
  });
});

describe("bounded Bun export process fault boundaries", () => {
  test("does not spawn after the finite deadline has elapsed", async () => {
    let didSpawn = false;
    const fake: ExportSpawnPort = {
      spawn(): ExportChildProcess {
        didSpawn = true;
        throw new Error("must not spawn");
      },
      killTree: () => undefined,
    };
    expect(
      await runBoundedBunProcess(fake, {
        command: "/trusted/opencode",
        arguments: ["--version"],
        cwd: "/private",
        environment: {},
        abort: new AbortController().signal,
        deadlineMs: Date.now() - 1,
        stdoutLimit: 10,
        limits: createSessionExportLimits(),
      }),
    ).toEqual({ kind: "ambiguous" });
    expect(didSpawn).toBe(false);
  });

  test("rejects malformed child process runtime shapes", async () => {
    const fake: ExportSpawnPort = {
      spawn: (() => ({
        pid: "not-a-pid",
        stdout: {},
        stderr: {},
        exited: {},
        kill: null,
      })) as never,
      killTree: () => undefined,
    };
    expect(
      await runBoundedBunProcess(fake, {
        command: "/trusted/opencode",
        arguments: ["--version"],
        cwd: "/",
        environment: {},
        abort: new AbortController().signal,
        deadlineMs: Date.now() + 1_000,
        stdoutLimit: 10,
        limits: createSessionExportLimits(),
      }),
    ).toEqual({ kind: "ambiguous" });
    expect(
      await runBoundedBunProcess(
        { spawn: () => null as never, killTree: () => undefined },
        boundedInput(),
      ),
    ).toEqual({ kind: "ambiguous" });
  });

  test("observes and terminates a positive-PID child whose remaining shape is malformed", async () => {
    const signals: number[] = [];
    let settleExit: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => (settleExit = resolve));
    const fake: ExportSpawnPort = {
      spawn: (() => ({
        pid: 321,
        stdout: {},
        stderr: stream(new Uint8Array()),
        exited,
        kill: () => undefined,
      })) as never,
      killTree: (_child, signal) => {
        signals.push(signal);
        settleExit?.(143);
      },
    };

    expect(await runBoundedBunProcess(fake, boundedInput())).toEqual({ kind: "failed" });
    expect(signals).toEqual([15, 9]);
    expect(await exited).toBe(143);
  });

  test("uses a valid direct-kill fallback for a malformed positive-PID child", async () => {
    const directSignals: number[] = [];
    const fake: ExportSpawnPort = {
      spawn: (() => ({
        pid: 322,
        stdout: {},
        stderr: {},
        exited: {},
        kill: (signal: number) => directSignals.push(signal),
      })) as never,
      killTree: () => {
        throw new Error("tree signaling unavailable");
      },
    };

    expect(await runBoundedBunProcess(fake, boundedInput())).toEqual({ kind: "ambiguous" });
    expect(directSignals).toEqual([15, 9]);
  });
});

describe("bounded Bun export process containment", () => {
  test("keeps containment ambiguous when malformed-child tree signaling needs direct kill", async () => {
    const directSignals: number[] = [];
    const exited = Promise.resolve(143);
    const fake: ExportSpawnPort = {
      spawn: (() => ({
        pid: 325,
        get stdout() {
          throw new Error("hostile stdout capability");
        },
        stderr: stream(new Uint8Array()),
        exited,
        kill: (signal: number) => directSignals.push(signal),
      })) as never,
      killTree: () => {
        throw new Error("tree signaling unavailable");
      },
    };

    expect(await runBoundedBunProcess(fake, boundedInput())).toEqual({ kind: "ambiguous" });
    expect(directSignals).toEqual([15, 9]);
    expect(await exited).toBe(143);
  });

  test("confirms malformed-child containment without requiring a direct-kill capability", async () => {
    const treeSignals: number[] = [];
    const fake: ExportSpawnPort = {
      spawn: (() => ({
        pid: 326,
        get stdout() {
          throw new Error("hostile stdout capability");
        },
        stderr: stream(new Uint8Array()),
        exited: Promise.resolve(143),
      })) as never,
      killTree: (_child, signal) => treeSignals.push(signal),
    };

    expect(await runBoundedBunProcess(fake, boundedInput())).toEqual({ kind: "failed" });
    expect(treeSignals).toEqual([15, 9]);
  });

  test("keeps malformed positive-PID setup ambiguous without confirmed exit", async () => {
    const signals: number[] = [];
    const fake: ExportSpawnPort = {
      spawn: (() => ({
        pid: 324,
        stdout: {},
        stderr: {},
        exited: {},
        kill: () => undefined,
      })) as never,
      killTree: (_child, signal) => signals.push(signal),
    };

    expect(await runBoundedBunProcess(fake, boundedInput())).toEqual({ kind: "ambiguous" });
    expect(signals).toEqual([15, 9]);
  });

  test("escalates immediately after confirmed leader exit instead of delaying PGID signaling", async () => {
    const signals: number[] = [];
    const fake: ExportSpawnPort = {
      spawn: (() => ({
        pid: 323,
        stdout: {},
        stderr: {},
        exited: Promise.resolve(143),
        kill: () => undefined,
      })) as never,
      killTree: (_child, signal) => signals.push(signal),
    };
    const started = Date.now();

    expect(
      await runBoundedBunProcess(
        fake,
        boundedInput({
          limits: createSessionExportLimits({ terminationGraceMs: 1_000 }),
        }),
      ),
    ).toEqual({ kind: "failed" });
    expect(signals).toEqual([15, 9]);
    expect(Date.now() - started).toBeLessThan(250);
  });

  test("settles finitely when descendants retain pipes and exit never settles", async () => {
    const retained = () => new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const signals: number[] = [];
    const fake: ExportSpawnPort = {
      spawn: () => ({
        pid: 789,
        stdout: retained(),
        stderr: retained(),
        exited: new Promise(() => {}),
        kill: () => undefined,
      }),
      killTree: (_child, signal) => signals.push(signal),
    };
    const started = Date.now();
    expect(
      await runBoundedBunProcess(fake, {
        command: "/trusted/opencode",
        arguments: ["export", "ses_x"],
        cwd: "/",
        environment: {},
        abort: new AbortController().signal,
        deadlineMs: Date.now() + 20,
        stdoutLimit: 10,
        limits: createSessionExportLimits({ maximumDurationMs: 20, terminationGraceMs: 10 }),
      }),
    ).toEqual({ kind: "ambiguous" });
    expect(Date.now() - started).toBeLessThan(100);
    expect(signals).toEqual([15, 9]);
  });
});
