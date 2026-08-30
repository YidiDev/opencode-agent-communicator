import { describe, expect, test } from "bun:test";
import { readValidatedSessionReadAnchor } from "../../../src/application/session-read-anchor";
import {
  type SessionReadCallScope,
  traverseSessionRead,
} from "../../../src/application/session-read-pagination";
import { SessionReadWorkBudget } from "../../../src/application/session-read-work";
import { type ProjectionSafeMessage, sessionReadLimits } from "../../../src/domain/session-read";
import type { SessionId } from "../../../src/domain/sessions";
import type { WorkspaceKey } from "../../../src/domain/workspaces";

const workspace = "workspace" as WorkspaceKey;
const target = "ses_target" as SessionId;
const visible = {
  sourceVisible: true,
  targetVisible: true,
  targetStatus: "busy" as const,
  observedAtMs: 1,
};
const scope: SessionReadCallScope = {
  signal: new AbortController().signal,
  async run(operation) {
    return { kind: "value", value: await operation() };
  },
};
const guard = async () => ({ ok: true as const, value: visible });
const plan = { workspace, target, mode: "tail" as const, limit: 100 };

function assistant(messageId: string, text: string): ProjectionSafeMessage {
  return {
    type: "assistant",
    messageId,
    state: "active",
    parts: [{ type: "text", itemKey: "text", text }],
  };
}

describe("session read immutable work bounds", () => {
  test("refuses a native call beyond the invocation ceiling", () => {
    const work = new SessionReadWorkBudget();
    for (let index = 0; index < 96; index += 1) expect(work.chargeNativeCall()).toBe(true);
    expect(work.chargeNativeCall()).toBe(false);
  });

  test("charges raw response bytes across the whole invocation", () => {
    const work = new SessionReadWorkBudget();
    const half = sessionReadLimits.maxNativeResponseBytesExamined / 2;
    expect(
      work.chargeRaw({ messages: 0, projectedTextBytes: 0, rawResponseBytes: half, parts: 0 }),
    ).toBe(true);
    expect(
      work.chargeRaw({ messages: 0, projectedTextBytes: 0, rawResponseBytes: half, parts: 0 }),
    ).toBe(true);
    expect(
      work.chargeRaw({ messages: 0, projectedTextBytes: 0, rawResponseBytes: 1, parts: 0 }),
    ).toBe(false);
  });

  test("reuses cached projections and charges an explicit replacement", () => {
    const work = new SessionReadWorkBudget();
    const first = work.project(assistant("cached", "first"));
    const reused = work.project(assistant("cached", "changed"));
    expect(first.ok).toBe(true);
    expect(reused.ok).toBe(true);
    if (!first.ok || !reused.ok) return;
    expect(reused.lines).toBe(first.lines);
    const replaced = work.project(assistant("cached", "changed"), true);
    expect(replaced.ok && replaced.lines.map((line) => line.text)).toContain("changed");
  });

  test("fails projection before exceeding per-message and invocation rendered-line ceilings", () => {
    const perMessage = new SessionReadWorkBudget().project(
      assistant("bomb", "\n".repeat(1_000_000)),
    );
    expect(perMessage.ok).toBe(false);

    const work = new SessionReadWorkBudget();
    const maximum = "x\n".repeat(8_189);
    for (let index = 0; index < 4; index += 1) {
      expect(work.project(assistant(`full_${index}`, maximum)).ok).toBe(true);
    }
    expect(work.project({ type: "user", messageId: "over" }).ok).toBe(false);
  });

  test("fails closed when the charged final fixed anchor would exceed the parts budget", async () => {
    const work = new SessionReadWorkBudget();
    expect(
      work.chargeRaw({ messages: 2, projectedTextBytes: 0, rawResponseBytes: 0, parts: 8_192 }),
    ).toBe(true);
    expect(work.project(assistant("anchor", "x")).ok).toBe(true);
    let fixedCalls = 0;
    const result = await readValidatedSessionReadAnchor({
      scope,
      native: {
        async readMessagePage() {
          throw new Error();
        },
        async readMessage() {
          fixedCalls += 1;
          return {
            kind: "found",
            message: assistant("anchor", "x"),
            projectedTextByteCount: 1,
            rawResponseByteCount: 0,
            examinedPartCount: 8_193,
          } as const;
        },
      },
      digest: {
        async sha256() {
          return new Uint8Array(32);
        },
      },
      workspace,
      target,
      boundary: {
        messageId: "anchor",
        itemKey: "text",
        utf8ByteOffset: 1,
        prefixSha256: "0".repeat(64) as never,
      },
      effectGuard: guard,
      work,
      replaceProjection: true,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
    expect(fixedCalls).toBe(1);
  });

  test("fails fixed anchors at native-call and projection ceilings", async () => {
    const boundary = {
      messageId: "anchor",
      itemKey: "text",
      utf8ByteOffset: 0,
      prefixSha256: "0".repeat(64) as never,
    };
    const invoke = (work: SessionReadWorkBudget, message: ProjectionSafeMessage) =>
      readValidatedSessionReadAnchor({
        scope,
        native: {
          async readMessagePage() {
            throw new Error();
          },
          async readMessage() {
            return {
              kind: "found",
              message,
              projectedTextByteCount:
                message.type === "assistant" && message.parts[0]?.type === "text"
                  ? new TextEncoder().encode(message.parts[0].text).length
                  : 0,
              rawResponseByteCount: 0,
              examinedPartCount: message.type === "assistant" ? message.parts.length : 0,
            } as const;
          },
        },
        digest: {
          async sha256() {
            return new Uint8Array(32);
          },
        },
        workspace,
        target,
        boundary,
        effectGuard: guard,
        work,
      });

    const callsExhausted = new SessionReadWorkBudget();
    for (let index = 0; index < 96; index += 1) callsExhausted.chargeNativeCall();
    expect(await invoke(callsExhausted, assistant("anchor", "x"))).toMatchObject({
      ok: false,
      error: { code: "native_unavailable" },
    });
    expect(
      await invoke(new SessionReadWorkBudget(), assistant("anchor", "\n".repeat(1_000_000))),
    ).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
  });
});

describe("session read traversal work bounds", () => {
  test("stops before a response would exceed the cumulative raw-byte budget", async () => {
    let calls = 0;
    const ceilings: number[] = [];
    const result = await traverseSessionRead(
      scope,
      {
        async readMessagePage(request) {
          calls += 1;
          ceilings.push(request.maximumResponseBytes ?? -1);
          return {
            messages: [],
            examinedMessageIds: [],
            examinedMessageCount: 0,
            projectedTextByteCount: 0,
            rawResponseByteCount: sessionReadLimits.maxNativeResponseBytes,
            examinedPartCount: 0,
            previousCursor: null,
            nextCursor: `raw_${calls}`,
          };
        },
        async readMessage() {
          throw new Error();
        },
      },
      plan,
      undefined,
      [],
      new SessionReadWorkBudget(),
      guard,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
    expect(calls).toBe(8);
    expect(ceilings).toEqual(Array(8).fill(sessionReadLimits.maxNativeResponseBytes));
  });

  test("rejects adjacent-page overlap consisting only of omitted raw message IDs", async () => {
    let calls = 0;
    const result = await traverseSessionRead(
      scope,
      {
        async readMessagePage() {
          calls += 1;
          return {
            messages: [],
            examinedMessageIds: ["msg_omitted_overlap"],
            examinedMessageCount: 1,
            projectedTextByteCount: 0,
            rawResponseByteCount: 0,
            examinedPartCount: 0,
            previousCursor: null,
            nextCursor: calls === 1 ? "next" : null,
          };
        },
        async readMessage() {
          throw new Error();
        },
      },
      plan,
      undefined,
      [],
      new SessionReadWorkBudget(),
      guard,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
    expect(calls).toBe(2);
  });

  test("charges omitted raw entries and stops before examining message 513", async () => {
    let calls = 0;
    const result = await traverseSessionRead(
      scope,
      {
        async readMessagePage() {
          calls += 1;
          return {
            messages: [],
            examinedMessageIds: Array.from(
              { length: 8 },
              (_, index) => `omitted_${calls}_${index}`,
            ),
            examinedMessageCount: 8,
            projectedTextByteCount: 0,
            rawResponseByteCount: 0,
            examinedPartCount: 0,
            previousCursor: null,
            nextCursor: `omitted_${calls}`,
          };
        },
        async readMessage() {
          throw new Error();
        },
      },
      plan,
      undefined,
      [],
      new SessionReadWorkBudget(),
      guard,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
    expect(calls).toBe(64);
  });

  test("rejects impossible examined counts and projected-message counts", async () => {
    for (const page of [
      {
        messages: [],
        examinedMessageIds: Array.from({ length: 9 }, (_, index) => `raw_${index}`),
        examinedMessageCount: 9,
        projectedTextByteCount: 0,
        rawResponseByteCount: 0,
        examinedPartCount: 0,
        previousCursor: null,
        nextCursor: null,
      },
      {
        messages: [assistant("counted", "x")],
        examinedMessageIds: ["counted"],
        examinedMessageCount: 0,
        projectedTextByteCount: 1,
        rawResponseByteCount: 0,
        examinedPartCount: 1,
        previousCursor: null,
        nextCursor: null,
      },
    ]) {
      const result = await traverseSessionRead(
        scope,
        {
          async readMessagePage() {
            return page;
          },
          async readMessage() {
            throw new Error();
          },
        },
        plan,
        undefined,
        [],
        new SessionReadWorkBudget(),
        guard,
      );
      expect(result).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
    }
  });

  test("fails before projecting a page beyond the 8 MiB text-byte ceiling", async () => {
    const huge = "界".repeat(1_000_000);
    const messages = [
      assistant("huge_1", huge),
      assistant("huge_2", huge),
      assistant("huge_3", huge),
    ];
    const result = await traverseSessionRead(
      scope,
      {
        async readMessagePage() {
          return {
            messages,
            examinedMessageIds: messages.map((message) => message.messageId),
            examinedMessageCount: 3,
            projectedTextByteCount: 9_000_000,
            rawResponseByteCount: 0,
            examinedPartCount: 3,
            previousCursor: null,
            nextCursor: "more",
          };
        },
        async readMessage() {
          throw new Error();
        },
      },
      plan,
      undefined,
      [],
      new SessionReadWorkBudget(),
      guard,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "native_unavailable" } });
  });
});
