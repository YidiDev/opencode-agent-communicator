import { describe, expect, test } from "bun:test";
import {
  snapshotNativeFixedMessage,
  snapshotNativeMessagePage,
} from "../../../src/application/session-read-boundaries";
import type { ProjectionSafeMessage } from "../../../src/domain/session-read";
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
  test("validates exact page counts", () => {
    const exact = nativePageFixture([assistant("exact")]);
    expect(snapshotNativeMessagePage(exact, 8_388_608)).toBeDefined();
    expect(
      snapshotNativeMessagePage({ ...exact, examinedPartCount: 0 }, 8_388_608),
    ).toBeUndefined();
    expect(
      snapshotNativeMessagePage({ ...exact, projectedTextByteCount: 0 }, 8_388_608),
    ).toBeUndefined();
    expect(
      snapshotNativeMessagePage(
        { ...exact, messages: [assistant("bad"), assistant("bad")] },
        8_388_608,
      ),
    ).toBeUndefined();
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
          examinedPartCount: 1,
        }),
      ).toBeUndefined();
    }
  });
});
