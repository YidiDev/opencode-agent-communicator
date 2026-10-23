import { describe, expect, test } from "bun:test";
import {
  snapshotNativeFixedMessage,
  snapshotNativeMessagePage,
} from "../../../src/application/session-read-boundaries";
import { type ProjectionSafeMessage, sessionReadLimits } from "../../../src/domain/session-read";
import { nativePageFixture } from "../../support/session-read-fixtures";

function assistant(messageId = "message", text = "x"): ProjectionSafeMessage {
  return {
    type: "assistant",
    messageId,
    state: "active",
    parts: [{ type: "text", itemKey: "text", text }],
  };
}

describe("session read strict DTO snapshots", () => {
  test("accepts only a boolean earlier-context marker and still rejects unknown keys", () => {
    const exact = nativePageFixture([assistant()]);
    for (const value of [true, false])
      expect(
        snapshotNativeMessagePage({ ...exact, earlierContextUnavailable: value }, 1024),
      ).toBeDefined();
    for (const value of [undefined, null, 1, "true"])
      expect(
        snapshotNativeMessagePage({ ...exact, earlierContextUnavailable: value }, 1024),
      ).toBeUndefined();
    expect(snapshotNativeMessagePage({ ...exact, unknown: true }, 1024)).toBeUndefined();
  });
  test("validates exact page counts", () => {
    const exact = nativePageFixture([assistant("exact")]);
    expect(snapshotNativeMessagePage(exact, 8_388_608)).toBeDefined();
    expect(
      snapshotNativeMessagePage({ ...exact, examinedPartCount: 0 }, 8_388_608),
    ).toBeUndefined();
    expect(
      snapshotNativeMessagePage({ ...exact, examinedMessageIds: [] }, 8_388_608),
    ).toBeUndefined();
    expect(
      snapshotNativeMessagePage(
        { ...exact, examinedMessageIds: ["omitted", "exact"], examinedMessageCount: 2 },
        8_388_608,
      ),
    ).toBeDefined();
    expect(
      snapshotNativeMessagePage(
        { ...exact, examinedMessageIds: ["exact", "omitted"], examinedMessageCount: 2 },
        8_388_608,
      ),
    ).toBeDefined();
    const ordered = nativePageFixture([assistant("first"), assistant("second")]);
    expect(
      snapshotNativeMessagePage({ ...ordered, examinedMessageIds: ["second", "first"] }, 8_388_608),
    ).toBeUndefined();
    expect(
      snapshotNativeMessagePage({ ...exact, projectedTextByteCount: 0 }, 8_388_608),
    ).toBeUndefined();
    expect(
      snapshotNativeMessagePage(
        { ...exact, rawResponseByteCount: sessionReadLimits.maxNativeResponseBytes + 1 },
        8_388_608,
      ),
    ).toBeUndefined();
    expect(
      snapshotNativeMessagePage(
        { ...exact, messages: [assistant("bad"), assistant("bad")] },
        8_388_608,
      ),
    ).toBeUndefined();
  });

  test("validates fixed-message identity and measured work exactly", () => {
    const exact = {
      kind: "found",
      message: assistant("exact"),
      projectedTextByteCount: 1,
      rawResponseByteCount: 7,
      examinedPartCount: 1,
    } as const;
    expect(snapshotNativeFixedMessage(exact, "exact", 7)).toBeDefined();
    expect(snapshotNativeFixedMessage(exact, "other", 7)).toBeUndefined();
    expect(snapshotNativeFixedMessage({ ...exact, projectedTextByteCount: 0 })).toBeUndefined();
    expect(snapshotNativeFixedMessage({ ...exact, examinedPartCount: 0 })).toBeUndefined();
    expect(snapshotNativeFixedMessage(exact, "exact", 6)).toBeUndefined();
  });

  test("rejects reserved structural item keys at the direct-port boundary", () => {
    for (const itemKey of ["$user", "$assistant", "$assistant-state"]) {
      expect(
        snapshotNativeFixedMessage({
          kind: "found",
          message: { ...assistant(), parts: [{ type: "text", itemKey, text: "collision" }] },
          projectedTextByteCount: 9,
          rawResponseByteCount: 0,
          examinedPartCount: 1,
        }),
      ).toBeUndefined();
    }
  });

  test("rejects deeply malformed projected messages and parts", () => {
    for (const message of [
      { ...assistant(), messageId: "bad id" },
      { ...assistant(), parts: [{ type: "future", itemKey: "part" }] },
      { ...assistant(), parts: [{ type: "text", itemKey: "bad key", text: "x" }] },
      { ...assistant(), parts: new Array(1) },
    ]) {
      expect(
        snapshotNativeFixedMessage({
          kind: "found",
          message,
          projectedTextByteCount: 0,
          rawResponseByteCount: 0,
          examinedPartCount: 1,
        }),
      ).toBeUndefined();
    }
  });
});
