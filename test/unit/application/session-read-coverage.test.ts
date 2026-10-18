import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readSession } from "../../../src/application/read-session";
import { readValidatedSessionReadAnchor } from "../../../src/application/session-read-anchor";
import {
  boundaryDigest,
  emptyBoundaryDigest,
  emptySessionReadPosition,
  encodeSessionReadBoundary,
  hasPackingLookahead,
  type SessionReadCallScope,
  type SessionReadSettlement,
  sessionReadVisibilityFailure,
  snapshotNativeFixedMessage,
  snapshotSessionReadPresence,
  splitAnchorProjection,
  traverseSessionRead,
} from "../../../src/application/session-read-pagination";
import type { SessionReadPorts } from "../../../src/application/session-read-ports";
import { observeSessionReadPresence } from "../../../src/application/session-read-presence";
import { SessionReadWorkBudget } from "../../../src/application/session-read-work";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import type {
  ProjectionSafeMessage,
  RenderedProjectionLine,
} from "../../../src/domain/session-read";
import {
  encodeSessionReadCursor,
  type SessionReadCursorBoundary,
} from "../../../src/domain/session-read-cursor";
import type { SessionId } from "../../../src/domain/sessions";
import type { WorkspaceKey } from "../../../src/domain/workspaces";
import { nativeFoundFixture, nativePageFixture } from "../../support/session-read-fixtures";

const workspace = "workspace" as WorkspaceKey;
const source = "ses_source" as SessionId;
const target = "ses_target" as SessionId;
const digestPort = {
  async sha256(input: Uint8Array) {
    return new Uint8Array(createHash("sha256").update(input).digest());
  },
};

function workWithCalls(calls = 0): SessionReadWorkBudget {
  const work = new SessionReadWorkBudget();
  for (let index = 0; index < calls; index += 1) work.chargeNativeCall();
  return work;
}
const hash = "a".repeat(64) as Sha256Digest;
const visible = {
  sourceVisible: true,
  targetVisible: true,
  targetStatus: "busy" as const,
  observedAtMs: 7,
};
const notFound = { kind: "not_found", rawResponseByteCount: 0 } as const;
function assistant(id = "msg_a", text = "one\ntwo"): ProjectionSafeMessage {
  return {
    type: "assistant",
    messageId: id,
    state: "active",
    parts: [{ type: "text", itemKey: "text", text }],
  };
}

function scope(settlement?: SessionReadSettlement<unknown>): SessionReadCallScope {
  return {
    signal: new AbortController().signal,
    async run<T>(operation: () => Promise<T>) {
      return (settlement ?? {
        kind: "value",
        value: await operation(),
      }) as SessionReadSettlement<T>;
    },
  };
}

function fixture(messages: ProjectionSafeMessage[] = []) {
  let timerWake: (() => void) | undefined;
  const ports: SessionReadPorts = {
    readiness: { assertReady() {} },
    membership: {
      async observeSessionReadPresence() {
        return visible;
      },
    },
    approval: {
      async requestReadApproval() {
        return "approved";
      },
    },
    native: {
      async readMessagePage() {
        return nativePageFixture(messages);
      },
      async readMessage({ messageId }) {
        const message = messages.find((entry) => entry.messageId === messageId);
        return message ? nativeFoundFixture(message) : notFound;
      },
    },
    digest: { ...digestPort },
    clock: { nowMs: () => 10 },
    timer: {
      arm(_delay, wake) {
        timerWake = wake;
        return { cancel() {} };
      },
    },
  };
  return {
    ports,
    wake: () => timerWake?.(),
    context: {
      workspaceKey: workspace,
      sourceSessionId: target,
      abort: new AbortController().signal,
      deadlineMs: 100,
    },
  };
}

function poisonGetter(name: string) {
  return Object.defineProperty({}, name, {
    enumerable: true,
    get() {
      throw new Error("getter");
    },
  });
}

describe("session read strict snapshots and projection splitting", () => {
  test("rejects malformed presence snapshots without invoking getters", () => {
    expect(snapshotSessionReadPresence(poisonGetter("sourceVisible"))).toBeUndefined();
    expect(snapshotSessionReadPresence(Object.create({}))).toBeUndefined();
    expect(snapshotSessionReadPresence({ ...visible, extra: true })).toBeUndefined();
    for (const value of [
      { ...visible, sourceVisible: 1 },
      { ...visible, targetVisible: 1 },
      { ...visible, targetStatus: "gone" },
      { ...visible, observedAtMs: -1 },
    ])
      expect(snapshotSessionReadPresence(value)).toBeUndefined();
    expect(snapshotSessionReadPresence({ ...visible, targetStatus: "retry" })).toEqual({
      ...visible,
      targetStatus: "retry",
    });
    expect(snapshotSessionReadPresence({ ...visible, targetStatus: "idle" })).toEqual({
      ...visible,
      targetStatus: "idle",
    });
    expect(sessionReadVisibilityFailure({ ...visible, sourceVisible: false })).toMatchObject({
      error: { code: "caller_not_visible" },
    });
    expect(sessionReadVisibilityFailure({ ...visible, targetVisible: false })).toMatchObject({
      error: { code: "target_not_visible" },
    });
    expect(sessionReadVisibilityFailure(visible)).toBeUndefined();
  });
  test("rejects malformed fixed messages, prototypes, sparse arrays, and duplicate parts", () => {
    expect(snapshotNativeFixedMessage(poisonGetter("kind"))).toBeUndefined();
    expect(snapshotNativeFixedMessage(notFound)).toEqual(notFound);
    expect(snapshotNativeFixedMessage({ ...notFound, extra: 1 })).toBeUndefined();
    expect(snapshotNativeFixedMessage({ kind: "wrong", message: assistant() })).toBeUndefined();
    expect(
      snapshotNativeFixedMessage({ kind: "found", message: assistant() }, "other"),
    ).toBeUndefined();
    const sparse = new Array(1);
    expect(
      snapshotNativeFixedMessage({ kind: "found", message: { ...assistant(), parts: sparse } }),
    ).toBeUndefined();
    const inherited = Object.setPrototypeOf([assistant()], null);
    expect(
      snapshotNativeFixedMessage({ kind: "found", message: { ...assistant(), parts: inherited } }),
    ).toBeUndefined();
    const duplicate = {
      ...assistant(),
      parts: [
        { type: "text", itemKey: "same", text: "x" },
        { type: "tool", itemKey: "same", name: "n", status: "running" },
      ],
    };
    expect(snapshotNativeFixedMessage({ kind: "found", message: duplicate })).toBeUndefined();
    expect(
      snapshotNativeFixedMessage({
        kind: "found",
        message: { type: "user", messageId: "msg_u" },
        projectedTextByteCount: 0,
        rawResponseByteCount: 0,
        examinedPartCount: 0,
      }),
    ).toBeDefined();
    expect(
      snapshotNativeFixedMessage({
        kind: "found",
        message: {
          ...assistant(),
          state: "completed",
          parts: [{ type: "tool", itemKey: "tool", name: "n", status: "error" }],
        },
        projectedTextByteCount: 0,
        rawResponseByteCount: 0,
        examinedPartCount: 1,
      }),
    ).toBeDefined();
  });
  test("splits boundaries at starts, ends, wrapped lines, invalid UTF-8 offsets, and mismatches", async () => {
    const message = assistant("msg_a", `${"x".repeat(16_384)}z`);
    const start = { messageId: "msg_a", itemKey: "text", utf8ByteOffset: 0, prefixSha256: hash };
    expect(splitAnchorProjection(message, start)?.after[0]?.text.length).toBe(4_096);
    const shared = { ...start, utf8ByteOffset: 16_384 };
    const split = splitAnchorProjection(message, shared);
    expect(split?.before.at(-1)?.text.length).toBe(4_096);
    expect(split?.after[0]?.text).toBe("z");
    expect(splitAnchorProjection(message, { ...start, utf8ByteOffset: 99_999 })).toBeUndefined();
    expect(splitAnchorProjection(message, { ...start, messageId: "other" })).toBeUndefined();
    expect(splitAnchorProjection(message, { ...start, itemKey: "other" })).toBeUndefined();
    expect(
      splitAnchorProjection(assistant("msg_a", "🌍"), { ...start, utf8ByteOffset: 1 }),
    ).toBeUndefined();
    expect(await boundaryDigest(digestPort, message, shared)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await boundaryDigest(digestPort, message, { ...shared, itemKey: "bad" }),
    ).toBeUndefined();
    expect(await emptyBoundaryDigest(digestPort)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await encodeSessionReadBoundary(
        digestPort,
        hash,
        target,
        new Map(),
        emptySessionReadPosition,
      ),
    ).toBeString();
    await expect(
      encodeSessionReadBoundary(digestPort, hash, target, new Map(), shared),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("detects packing lookahead by line count, bytes, direction, and the hard cap shortcut", () => {
    const line = (text: string): RenderedProjectionLine => ({
      text,
      start: emptySessionReadPosition,
      end: emptySessionReadPosition,
    });
    expect(hasPackingLookahead([line("a"), line("b")], 1, false)).toBe(true);
    expect(hasPackingLookahead([line("a")], 2, true)).toBe(false);
    expect(hasPackingLookahead([line("x".repeat(65_537))], 2, false)).toBe(true);
    expect(
      hasPackingLookahead(
        Array.from({ length: 502 }, () => line("")),
        500,
        true,
      ),
    ).toBe(true);
  });
});

describe("presence and fixed-anchor fail-closed settlements", () => {
  test.each([
    [{ kind: "expired" }, "deadline_expired"],
    [{ kind: "rejected" }, "native_unavailable"],
    [{ kind: "value", value: poisonGetter("sourceVisible") }, "native_unavailable"],
    [{ kind: "value", value: { ...visible, sourceVisible: false } }, "caller_not_visible"],
    [{ kind: "value", value: { ...visible, targetVisible: false } }, "target_not_visible"],
    [{ kind: "value", value: { ...visible, targetStatus: "unknown" } }, undefined],
  ] as const)("maps presence settlement %#", async (settlement, code) => {
    const result = await observeSessionReadPresence(
      scope(settlement),
      {
        async observeSessionReadPresence() {
          return visible;
        },
      },
      workspace,
      source,
      target,
    );
    expect(result).toMatchObject(
      code ? { ok: false, error: { code } } : { ok: true, value: { targetStatus: "unknown" } },
    );
  });
  test("returns a valid observed presence", async () => {
    expect(
      await observeSessionReadPresence(
        scope(),
        {
          async observeSessionReadPresence() {
            return visible;
          },
        },
        workspace,
        source,
        target,
      ),
    ).toEqual({ ok: true, value: visible });
  });
  test.each([
    ["guard", "caller_not_visible"],
    ["expired", "deadline_expired"],
    ["rejected", "native_unavailable"],
    ["malformed", "native_unavailable"],
    ["missing", "cursor_stale"],
    ["split", "cursor_stale"],
    ["digest-expired", "deadline_expired"],
    ["digest-rejected", "native_unavailable"],
    ["digest-changed", "cursor_stale"],
  ] as const)("fails closed for anchor %s", async (scenario, code) => {
    const message = assistant("msg_a", "one");
    const position = { messageId: "msg_a", itemKey: "text", utf8ByteOffset: 3 };
    const prefixSha256 = (await boundaryDigest(digestPort, message, position)) as Sha256Digest;
    const boundary: SessionReadCursorBoundary = { ...position, prefixSha256 };
    let call = 0;
    const customScope: SessionReadCallScope = {
      signal: new AbortController().signal,
      async run<T>(operation: () => Promise<T>) {
        call += 1;
        if ((scenario === "expired" && call === 1) || (scenario === "digest-expired" && call === 2))
          return { kind: "expired" };
        if (
          (scenario === "rejected" && call === 1) ||
          (scenario === "digest-rejected" && call === 2)
        )
          return { kind: "rejected" };
        return { kind: "value", value: await operation() };
      },
    };
    const result = await readValidatedSessionReadAnchor({
      scope: customScope,
      native: {
        async readMessagePage() {
          throw new Error();
        },
        async readMessage() {
          if (scenario === "malformed") return { bad: true } as never;
          if (scenario === "missing") return notFound;
          return nativeFoundFixture(message);
        },
      },
      digest:
        scenario === "digest-changed"
          ? {
              async sha256() {
                return new Uint8Array(32);
              },
            }
          : digestPort,
      workspace,
      target,
      boundary: scenario === "split" ? { ...boundary, itemKey: "missing" } : boundary,
      effectGuard: async () =>
        scenario === "guard"
          ? { ok: false, error: { code: "caller_not_visible", message: "x", retryable: false } }
          : { ok: true, value: visible },
      work: workWithCalls(),
    });
    expect(result).toMatchObject({ ok: false, error: { code } });
  });
});

describe("bounded transcript traversal", () => {
  const plan = { workspace, target, mode: "tail" as const, limit: 100 };
  const guard = async () => ({ ok: true as const, value: visible });

  test.each([
    ["expired", "deadline_expired"],
    ["rejected", "native_unavailable"],
  ] as const)("maps page %s", async (kind, code) => {
    const result = await traverseSessionRead(
      scope({ kind }),
      {
        async readMessagePage() {
          throw new Error();
        },
        async readMessage() {
          throw new Error();
        },
      },
      plan,
      undefined,
      [],
      workWithCalls(),
      guard,
    );
    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  test("rejects malformed pages, sparse DTOs, duplicates, projections, cursors, and budgets", async () => {
    const cases: unknown[] = [
      poisonGetter("messages"),
      { messages: new Array(1), previousCursor: null, nextCursor: null },
      { messages: [assistant("same"), assistant("same")], previousCursor: null, nextCursor: null },
      {
        messages: [{ ...assistant(), parts: [{ type: "text", itemKey: "text", text: "\ud800" }] }],
        previousCursor: null,
        nextCursor: null,
      },
      nativePageFixture([
        {
          type: "assistant",
          messageId: "msg_collision",
          state: "active",
          parts: [{ type: "text", itemKey: "$assistant", text: "collision" }],
        },
      ]),
      { messages: [], previousCursor: " bad", nextCursor: null },
    ];
    for (const page of cases) {
      const result = await traverseSessionRead(
        scope(),
        {
          async readMessagePage() {
            return page as never;
          },
          async readMessage() {
            throw new Error();
          },
        },
        plan,
        undefined,
        [],
        workWithCalls(),
        guard,
      );
      expect(result).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
    }
    let calls = 0;
    const cycle = await traverseSessionRead(
      scope(),
      {
        async readMessagePage() {
          calls += 1;
          return nativePageFixture([], "cycle");
        },
        async readMessage() {
          throw new Error();
        },
      },
      plan,
      undefined,
      [],
      workWithCalls(),
      guard,
    );
    expect(cycle).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
    expect(calls).toBe(2);
  });

  test("handles empty pages, cursor requests, before/after anchors, stale anchors, and guard failure", async () => {
    const pageNative = (pages: unknown[]) => ({
      async readMessagePage() {
        return pages.shift() as never;
      },
      async readMessage() {
        throw new Error();
      },
    });
    expect(
      await traverseSessionRead(
        scope(),
        pageNative([nativePageFixture([])]),
        plan,
        undefined,
        [],
        workWithCalls(),
        guard,
      ),
    ).toMatchObject({ ok: true, value: { reachedOldest: true, anchorIndex: -1 } });
    const anchor = assistant("anchor", "x");
    const before = assistant("before", "y");
    const page = nativePageFixture([anchor, before]);
    expect(
      await traverseSessionRead(
        scope(),
        pageNative([page]),
        { ...plan, mode: "before", limit: 1 },
        anchor,
        [],
        workWithCalls(),
        guard,
      ),
    ).toMatchObject({ ok: true, value: { anchorIndex: 1 } });
    expect(
      await traverseSessionRead(
        scope(),
        pageNative([page]),
        { ...plan, mode: "after", limit: 1 },
        anchor,
        [],
        workWithCalls(),
        guard,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await traverseSessionRead(
        scope(),
        pageNative([nativePageFixture([])]),
        plan,
        anchor,
        [],
        workWithCalls(),
        guard,
      ),
    ).toMatchObject({ ok: false, error: { code: "cursor_stale" } });
    expect(
      await traverseSessionRead(
        scope(),
        pageNative([]),
        plan,
        undefined,
        [],
        workWithCalls(),
        async () => ({
          ok: false,
          error: { code: "target_not_visible", message: "x", retryable: false },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "target_not_visible" } });
  });
});

describe("readSession orchestration failures", () => {
  test.each([
    [{}, "invalid_arguments"],
    [{ sessionId: target, cursor: "" }, "invalid_arguments"],
    [{ sessionId: target, cursor: "x", direction: "sideways" }, "invalid_arguments"],
    [{ sessionId: target, limit: 0 }, "invalid_arguments"],
    [{ sessionId: target, limit: 501 }, "invalid_arguments"],
    [{ sessionId: target, limit: 1.5 }, "invalid_arguments"],
  ] as const)("rejects malformed arguments %#", async (args, code) => {
    const f = fixture();
    expect(await readSession(f.ports, f.context, args as never)).toMatchObject({
      ok: false,
      error: { code },
    });
  });

  test("rejects getter/prototype arguments and malformed invocation controls", async () => {
    const f = fixture();
    expect(await readSession(f.ports, f.context, poisonGetter("sessionId") as never)).toMatchObject(
      { error: { code: "invalid_arguments" } },
    );
    expect(
      await readSession(f.ports, f.context, Object.create({ sessionId: target })),
    ).toMatchObject({ error: { code: "invalid_arguments" } });
    expect(
      await readSession(f.ports, { ...f.context, abort: {} as never }, { sessionId: target }),
    ).toMatchObject({ error: { code: "invalid_arguments" } });
    expect(
      await readSession(f.ports, { ...f.context, deadlineMs: 1.5 }, { sessionId: target }),
    ).toMatchObject({ error: { code: "invalid_arguments" } });
    expect(await readSession(f.ports, f.context, { sessionId: "bad" })).toMatchObject({
      error: { code: "invalid_arguments" },
    });
  });

  test("observes an abort armed synchronously before the first deadline-scoped operation", async () => {
    const f = fixture();
    f.ports.timer.arm = (_delay, wake) => {
      wake();
      return { cancel() {} };
    };
    expect(await readSession(f.ports, f.context, { sessionId: target })).toMatchObject({
      error: { code: "deadline_expired" },
    });
  });

  test.each(["throw", "bad", "past", "aborted"] as const)(
    "fails clock/deadline %s",
    async (kind) => {
      const f = fixture();
      if (kind === "throw")
        f.ports.clock.nowMs = () => {
          throw new Error();
        };
      if (kind === "bad") f.ports.clock.nowMs = () => 1.5;
      const abort = new AbortController();
      if (kind === "aborted") abort.abort();
      const result = await readSession(
        f.ports,
        { ...f.context, abort: abort.signal, deadlineMs: kind === "past" ? 10 : 100 },
        { sessionId: target },
      );
      expect(result).toMatchObject({
        error: { code: kind === "throw" ? "native_unavailable" : "deadline_expired" },
      });
    },
  );
  test.each(["throw", "bad", "getter"] as const)("rejects malformed timer %s", async (kind) => {
    const f = fixture();
    f.ports.timer.arm = (() => {
      if (kind === "throw") throw new Error();
      if (kind === "getter") return poisonGetter("cancel");
      return {};
    }) as never;
    expect(await readSession(f.ports, f.context, { sessionId: target })).toMatchObject({
      error: { code: "native_unavailable" },
    });
  });

  test("maps workspace digest rejection, cancellation, and a throwing timer cancel", async () => {
    const rejected = fixture();
    rejected.ports.digest.sha256 = async () => {
      throw new Error();
    };
    expect(
      await readSession(rejected.ports, rejected.context, { sessionId: target }),
    ).toMatchObject({ error: { code: "native_unavailable" } });
    const canceled = fixture();
    const pending = readSession(canceled.ports, canceled.context, { sessionId: target });
    canceled.wake();
    expect(await pending).toMatchObject({ error: { code: "deadline_expired" } });
    const close = fixture();
    close.ports.timer.arm = () => ({
      cancel() {
        throw new Error();
      },
    });
    expect((await readSession(close.ports, close.context, { sessionId: target })).ok).toBe(true);
  });

  test.each(["rejected", "malformed", "throw", "expired"] as const)(
    "fails closed for approval %s",
    async (kind) => {
      const f = fixture();
      if (kind === "rejected") f.ports.approval.requestReadApproval = async () => "rejected";
      if (kind === "malformed") f.ports.approval.requestReadApproval = async () => "maybe" as never;
      if (kind === "throw")
        f.ports.approval.requestReadApproval = async () => {
          throw new Error();
        };
      if (kind === "expired") f.ports.approval.requestReadApproval = () => new Promise(() => {});
      const pending = readSession(
        f.ports,
        { ...f.context, sourceSessionId: source },
        { sessionId: target },
      );
      if (kind === "expired") {
        await Promise.resolve();
        f.wake();
      }
      expect(await pending).toMatchObject({
        error: {
          code:
            kind === "rejected"
              ? "permission_denied"
              : kind === "expired"
                ? "deadline_expired"
                : "native_unavailable",
        },
      });
    },
  );
});

describe("readSession cursor digest and deadline failures", () => {
  test("validates empty cursor digests and returns unchanged cursors for empty before/after pages", async () => {
    const f = fixture();
    const first = await readSession(f.ports, f.context, { sessionId: target });
    if (!first.ok) throw new Error("empty cursor setup failed");
    expect(
      (
        await readSession(f.ports, f.context, {
          sessionId: target,
          cursor: first.value.endCursor,
          direction: "after",
        })
      ).ok,
    ).toBe(true);
    const decoded = JSON.parse(
      atob(first.value.endCursor.replaceAll("-", "+").replaceAll("_", "/")),
    );
    decoded.p = "0".repeat(64);
    const stale = encodeSessionReadCursor(decoded.w, target, {
      messageId: decoded.m,
      itemKey: decoded.k,
      utf8ByteOffset: decoded.o,
      prefixSha256: decoded.p,
    });
    expect(
      await readSession(f.ports, f.context, { sessionId: target, cursor: stale }),
    ).toMatchObject({ error: { code: "cursor_stale" } });
  });

  test.each([
    ["empty-encode-reject", "native_unavailable"],
    ["empty-encode-expire", "deadline_expired"],
    ["line-encode-reject", "native_unavailable"],
    ["line-encode-expire", "deadline_expired"],
  ] as const)("maps boundary digest failure %s", async (kind, code) => {
    const withLine = kind.startsWith("line");
    const f = fixture(withLine ? [assistant()] : []);
    let calls = 0;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.ports.digest.sha256 = async (input) => {
      calls += 1;
      if (calls === 2) {
        if (kind.endsWith("reject")) throw new Error();
        entered();
        return new Promise(() => {});
      }
      return digestPort.sha256(input);
    };
    const pending = readSession(f.ports, f.context, { sessionId: target });
    if (kind.endsWith("expire")) {
      await started;
      f.wake();
    }
    expect(await pending).toMatchObject({ error: { code } });
  });

  test.each([
    ["reject", "native_unavailable"],
    ["expire", "deadline_expired"],
  ] as const)("maps supplied cursor digest %s", async (kind, code) => {
    const setup = fixture();
    const empty = await readSession(setup.ports, setup.context, { sessionId: target });
    if (!empty.ok) throw new Error("cursor setup failed");
    const f = fixture();
    let calls = 0;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.ports.digest.sha256 = async (input) => {
      calls += 1;
      if (calls === 2) {
        if (kind === "reject") throw new Error();
        entered();
        return new Promise(() => {});
      }
      return digestPort.sha256(input);
    };
    const pending = readSession(
      f.ports,
      { ...f.context, sourceSessionId: source },
      { sessionId: target, cursor: empty.value.endCursor },
    );
    if (kind === "expire") {
      await started;
      f.wake();
    }
    expect(await pending).toMatchObject({ error: { code } });
  });

  test.each([
    ["reject", "native_unavailable"],
    ["expire", "deadline_expired"],
  ] as const)("maps empty-boundary validation digest %s", async (kind, code) => {
    const setup = fixture();
    const empty = await readSession(setup.ports, setup.context, { sessionId: target });
    if (!empty.ok) throw new Error("cursor setup failed");
    const f = fixture();
    let calls = 0;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.ports.digest.sha256 = async (input) => {
      calls += 1;
      if (calls === 2) {
        if (kind === "reject") throw new Error();
        entered();
        return new Promise(() => {});
      }
      return digestPort.sha256(input);
    };
    const pending = readSession(f.ports, f.context, {
      sessionId: target,
      cursor: empty.value.endCursor,
    });
    if (kind === "expire") {
      await started;
      f.wake();
    }
    expect(await pending).toMatchObject({ error: { code } });
  });

  test("expires while cross-session approval is pending", async () => {
    const f = fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.ports.approval.requestReadApproval = () => {
      entered();
      return new Promise(() => {});
    };
    const pending = readSession(
      f.ports,
      { ...f.context, sourceSessionId: source },
      { sessionId: target },
    );
    await started;
    f.wake();
    expect(await pending).toMatchObject({ error: { code: "deadline_expired" } });
  });
});
