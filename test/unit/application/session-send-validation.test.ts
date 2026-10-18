import { describe, expect, test } from "bun:test";

import {
  sendVisibilityFailure,
  validateSendArguments,
} from "../../../src/application/session-send-validation";

describe("session send validation", () => {
  test.each([
    [{ session_id: 7, content: "hello" }, "session"],
    [{ session_id: "ses_target", content: 7 }, "content"],
    [{ session_id: "ses_target", content: "hello", delivery: "queue" }, "delivery mode"],
  ])("rejects malformed arguments %#", (args, message) => {
    const result = validateSendArguments(args);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    if (!result.ok) expect(result.error.message.toLowerCase()).toContain(message);
  });

  test.each([
    [undefined, "user"],
    ["context", "context"],
    ["user", "user"],
  ] as const)("accepts delivery %s as %s", (delivery, expected) => {
    const result = validateSendArguments({ session_id: "ses_target", content: "hé", delivery });
    expect(result).toMatchObject({
      ok: true,
      value: { target: "ses_target", content: "hé", byteLength: 3, delivery: expected },
    });
    if (result.ok) expect([...result.value.bytes]).toEqual([104, 195, 169]);
  });

  test.each([
    [{ sourceVisible: false, targetVisible: true, sourceTitle: undefined }, "caller_not_visible"],
    [{ sourceVisible: true, targetVisible: false, sourceTitle: undefined }, "target_not_visible"],
  ] as const)("reports visibility failure %#", (membership, code) => {
    expect(sendVisibilityFailure(membership)).toMatchObject({ ok: false, error: { code } });
  });

  test("accepts two visible roots", () => {
    expect(
      sendVisibilityFailure({ sourceVisible: true, targetVisible: true, sourceTitle: "Source" }),
    ).toBeUndefined();
  });
});
