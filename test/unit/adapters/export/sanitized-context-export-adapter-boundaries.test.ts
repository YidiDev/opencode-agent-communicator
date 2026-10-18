import { describe, expect, test } from "bun:test";

import {
  createSessionExportLimits,
  ProcessLocalExportLimiter,
} from "../../../../src/adapters/export/export-limits";
import { ExportPathError } from "../../../../src/adapters/export/linux-export-destination";
import { SanitizedContextExportAdapter } from "../../../../src/adapters/export/sanitized-context-export-adapter";
import type { ExportEffectGuardPort } from "../../../../src/application/session-export-ports";
import type {
  NativeMessagePage,
  NativeSessionReadPort,
} from "../../../../src/application/session-read-ports";
import { sessionReadLimits } from "../../../../src/domain/session-read";

const emptyPage: NativeMessagePage = {
  messages: [],
  examinedMessageIds: [],
  examinedMessageCount: 0,
  projectedTextByteCount: 0,
  rawResponseByteCount: 2,
  examinedPartCount: 0,
  previousCursor: null,
  nextCursor: null,
};

function input(
  guard: ExportEffectGuardPort = { check: async () => "current" },
  abort = new AbortController().signal,
) {
  return {
    sessionId: "ses_target" as never,
    sourceSessionId: "ses_source" as never,
    workspaceKey: "wrk_test" as never,
    destination: "safe/context.json" as never,
    isSanitized: true,
    shouldOverwrite: false,
    abort,
    deadlineMs: Date.now() + 10_000,
    fencingToken: 1 as never,
    guard,
  };
}

function rootFixture(
  options: {
    readonly onCreate?: () => void;
    readonly onWrite?: (bytes: Uint8Array) => void;
    readonly onInstall?: (shouldOverwrite: boolean) => void;
  } = {},
) {
  let discarded = 0;
  let closed = 0;
  const root = {
    createTemporary() {
      options.onCreate?.();
      return {
        descriptor: 1,
        write(bytes: Uint8Array) {
          options.onWrite?.(bytes);
        },
        install(shouldOverwrite: boolean) {
          options.onInstall?.(shouldOverwrite);
        },
        discard() {
          discarded += 1;
        },
      };
    },
    close() {
      closed += 1;
    },
  };
  return { root: root as never, discarded: () => discarded, closed: () => closed };
}

function nativeWith(page: unknown = emptyPage): NativeSessionReadPort {
  return {
    async readMessagePage() {
      return page as NativeMessagePage;
    },
    async readMessage() {
      throw new Error("not used");
    },
  };
}

describe("sanitized current-context exporter boundaries", () => {
  test.each(["cumulative", "negative", "overflow", "noninteger"] as const)(
    "rejects %s snapshot-byte accounting before creating a file",
    async (mode) => {
      let created = false;
      let calls = 0;
      const fixture = rootFixture({
        onCreate: () => {
          created = true;
        },
      });
      const native = nativeWith();
      native.readMessagePage = async (request) => {
        calls += 1;
        expect(request.maximumResponseBytes).toBeGreaterThan(0);
        return {
          ...emptyPage,
          nextCursor: `cursor${calls}`,
          rawResponseByteCount:
            mode === "negative"
              ? -1
              : mode === "overflow"
                ? sessionReadLimits.maxNativeResponseBytesExamined + 1
                : mode === "noninteger"
                  ? 0.5
                  : sessionReadLimits.maxNativeResponseBytes,
        };
      };
      expect(
        await new SanitizedContextExportAdapter(fixture.root, native).writeExport(input()),
      ).toEqual({ ok: false, code: "export_limit_exceeded" });
      expect(calls).toBe(mode === "cumulative" ? 8 : 1);
      expect(created).toBe(false);
    },
  );
  test("rejects invalid limits and makes limiter release idempotent", () => {
    expect(() => createSessionExportLimits({ maximumConcurrent: 0 })).toThrow(TypeError);

    const limiter = new ProcessLocalExportLimiter(1);
    const release = limiter.tryAcquire();
    expect(release).toBeFunction();
    expect(limiter.tryAcquire()).toBeUndefined();
    release?.();
    release?.();
    expect(limiter.tryAcquire()).toBeFunction();
  });

  test("writes the exact sanitized projection in chronological order and forwards overwrite", async () => {
    let bytes = new Uint8Array();
    let overwrite: boolean | undefined;
    const fixture = rootFixture({
      onWrite: (value) => {
        bytes = new Uint8Array(value);
      },
      onInstall: (value) => {
        overwrite = value;
      },
    });
    let call = 0;
    const native = nativeWith();
    native.readMessagePage = async () => {
      call += 1;
      return (
        call === 1
          ? {
              ...emptyPage,
              messages: [{ type: "user", messageId: "new" }],
              examinedMessageIds: ["new"],
              examinedMessageCount: 1,
              nextCursor: "older",
            }
          : {
              ...emptyPage,
              messages: [
                {
                  type: "assistant",
                  messageId: "old",
                  state: "completed",
                  parts: [{ type: "text", itemKey: "part", text: "exact payload" }],
                },
              ],
              examinedMessageIds: ["old"],
              examinedMessageCount: 1,
            }
      ) as never;
    };
    const adapter = new SanitizedContextExportAdapter(fixture.root, native);
    const result = await adapter.writeExport({ ...input(), shouldOverwrite: true });
    const text = new TextDecoder().decode(bytes);

    expect(result).toMatchObject({ ok: true, byteCount: bytes.byteLength });
    expect(overwrite).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      version: 1,
      kind: "opencode-sanitized-current-context",
      history_complete: false,
      projection_version: 1,
      communicator: { source_session_id: "ses_source", target_session_id: "ses_target" },
      messages: [
        {
          type: "assistant",
          messageId: "old",
          state: "completed",
          parts: [{ type: "text", itemKey: "part", text: "exact payload" }],
        },
        { type: "user", messageId: "new" },
      ],
    });
  });

  test("rejects malformed page accounting, duplicate ids, and repeated or empty cursors", async () => {
    const malformedPages = [
      { ...emptyPage, examinedMessageCount: 1 },
      {
        ...emptyPage,
        examinedMessageIds: ["same", "same"],
        examinedMessageCount: 2,
      },
      { ...emptyPage, nextCursor: "" },
    ];
    for (const page of malformedPages) {
      const adapter = new SanitizedContextExportAdapter(rootFixture().root, nativeWith(page));
      expect(await adapter.writeExport(input())).toEqual({ ok: false, code: "export_unavailable" });
    }

    let calls = 0;
    const native = nativeWith();
    native.readMessagePage = async () => ({
      ...emptyPage,
      nextCursor: calls++ === 0 ? "repeat" : "repeat",
    });
    const adapter = new SanitizedContextExportAdapter(rootFixture().root, native);
    expect(await adapter.writeExport(input())).toEqual({ ok: false, code: "export_unavailable" });
  });

  test("enforces message, native-call, output, source-rate, and concurrency limits", async () => {
    const ids = Array.from(
      { length: sessionReadLimits.maxMessagesExamined + 1 },
      (_, index) => `msg_${index}`,
    );
    const tooMany = new SanitizedContextExportAdapter(
      rootFixture().root,
      nativeWith({
        ...emptyPage,
        messages: ids.map((messageId) => ({ type: "user", messageId })),
        examinedMessageIds: ids,
        examinedMessageCount: ids.length,
      }),
    );
    expect(await tooMany.writeExport(input())).toEqual({
      ok: false,
      code: "export_limit_exceeded",
    });

    let calls = 0;
    const endlessNative = nativeWith();
    endlessNative.readMessagePage = async () => ({ ...emptyPage, nextCursor: `cursor_${calls++}` });
    const tooManyCalls = new SanitizedContextExportAdapter(rootFixture().root, endlessNative);
    expect(await tooManyCalls.writeExport(input())).toEqual({
      ok: false,
      code: "export_limit_exceeded",
    });

    const output = new SanitizedContextExportAdapter(rootFixture().root, nativeWith(), {
      maximumOutputBytes: 1,
    });
    expect(await output.writeExport(input())).toEqual({ ok: false, code: "export_limit_exceeded" });

    const rate = new SanitizedContextExportAdapter(rootFixture().root, nativeWith(), {
      maximumSourceExportsPerMinute: 1,
    });
    expect(await rate.writeExport(input())).toMatchObject({ ok: true });
    expect(await rate.writeExport(input())).toEqual({ ok: false, code: "export_limit_exceeded" });

    let releaseRead: ((value: typeof emptyPage) => void) | undefined;
    let signalEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const blockingNative = nativeWith();
    blockingNative.readMessagePage = () =>
      new Promise<NativeMessagePage>((resolve) => {
        releaseRead = resolve;
        signalEntered?.();
      });
    const concurrent = new SanitizedContextExportAdapter(rootFixture().root, blockingNative, {
      maximumConcurrent: 1,
    });
    const first = concurrent.writeExport(input());
    await entered;
    expect(await concurrent.writeExport(input())).toEqual({
      ok: false,
      code: "export_limit_exceeded",
    });
    releaseRead?.(emptyPage);
    expect(await first).toMatchObject({ ok: true });
  });
});

describe("sanitized current-context exporter failure boundaries", () => {
  test("fails closed for aborts, deadlines, invalid destinations, draining, and disposal", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const adapter = new SanitizedContextExportAdapter(rootFixture().root, nativeWith());
    expect(await adapter.writeExport(input(undefined, aborted.signal))).toEqual({
      ok: false,
      code: "export_limit_exceeded",
    });
    expect(await adapter.writeExport({ ...input(), deadlineMs: Date.now() - 1 })).toEqual({
      ok: false,
      code: "export_limit_exceeded",
    });
    expect(await adapter.writeExport({ ...input(), destination: "../escape" as never })).toEqual({
      ok: false,
      code: "export_limit_exceeded",
    });

    await adapter.drain();
    expect(await adapter.writeExport(input())).toEqual({
      ok: false,
      code: "export_limit_exceeded",
    });

    const disposableRoot = rootFixture();
    const disposable = new SanitizedContextExportAdapter(disposableRoot.root, nativeWith());
    disposable[Symbol.dispose]();
    expect(disposableRoot.closed()).toBe(1);
    expect(await disposable.writeExport(input())).toEqual({
      ok: false,
      code: "export_limit_exceeded",
    });
  });

  test("checks the effect guard at every boundary and treats post-install loss as ambiguous", async () => {
    for (const [staleAt, code] of [
      [1, "ownership_lost"],
      [2, "caller_not_visible"],
      [3, "target_not_visible"],
      [4, "export_unavailable"],
      [5, "ownership_lost"],
    ] as const) {
      let checks = 0;
      const guard: ExportEffectGuardPort = {
        async check() {
          checks += 1;
          return checks === staleAt ? code : "current";
        },
      };
      const fixture = rootFixture();
      const adapter = new SanitizedContextExportAdapter(fixture.root, nativeWith());
      expect(await adapter.writeExport(input(guard))).toEqual({ ok: false, code });
      if (staleAt >= 4) expect(fixture.discarded()).toBe(1);
    }

    let checks = 0;
    const postInstall = new SanitizedContextExportAdapter(rootFixture().root, nativeWith());
    expect(
      await postInstall.writeExport(
        input({ check: async () => (++checks === 6 ? "ownership_lost" : "current") }),
      ),
    ).toEqual({ ok: false, code: "native_outcome_unknown" });

    checks = 0;
    const throwingPostInstall = new SanitizedContextExportAdapter(rootFixture().root, nativeWith());
    expect(
      await throwingPostInstall.writeExport(
        input({
          check: async () => {
            if (++checks === 6) throw new Error("guard unavailable");
            return "current";
          },
        }),
      ),
    ).toEqual({ ok: false, code: "native_outcome_unknown" });
  });

  test("reports cancellation after staging or writing as ambiguous and discards the stage", async () => {
    const afterCreate = new AbortController();
    const createFixture = rootFixture({ onCreate: () => afterCreate.abort() });
    const createAdapter = new SanitizedContextExportAdapter(createFixture.root, nativeWith());
    expect(await createAdapter.writeExport(input(undefined, afterCreate.signal))).toEqual({
      ok: false,
      code: "native_outcome_unknown",
    });
    expect(createFixture.discarded()).toBe(1);

    const afterWrite = new AbortController();
    const writeFixture = rootFixture({ onWrite: () => afterWrite.abort() });
    const writeAdapter = new SanitizedContextExportAdapter(writeFixture.root, nativeWith());
    expect(await writeAdapter.writeExport(input(undefined, afterWrite.signal))).toEqual({
      ok: false,
      code: "native_outcome_unknown",
    });
    expect(writeFixture.discarded()).toBe(1);
  });

  test("maps secure path errors exactly and unexpected write failures to storage unavailable", async () => {
    for (const [throwAt, expected] of [
      ["create", "unsafe_path"],
      ["write", "storage_unavailable"],
      ["install", "destination_exists"],
    ] as const) {
      const root = {
        createTemporary() {
          if (throwAt === "create") throw new ExportPathError("unsafe_path");
          return {
            descriptor: 1,
            write() {
              if (throwAt === "write") throw new Error("ambiguous write failure");
            },
            install() {
              if (throwAt === "install") throw new ExportPathError("destination_exists");
            },
            discard() {},
          };
        },
        close() {},
      };
      const adapter = new SanitizedContextExportAdapter(root as never, nativeWith());
      expect(await adapter.writeExport(input())).toEqual({ ok: false, code: expected });
    }
  });
});
