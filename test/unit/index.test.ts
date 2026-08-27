import { describe, expect, test } from "bun:test";
import { communicatorToolIds } from "../../src/composition/tools";
import sessionCommunicatorPlugin from "../../src/index";

describe("package entrypoint", () => {
  test("exports the production initializer and freezes the exact public tool manifest", () => {
    expect(sessionCommunicatorPlugin).toBeInstanceOf(Function);
    expect(communicatorToolIds).toEqual([
      "session_list",
      "session_send",
      "session_delivery_get",
      "session_ask",
      "session_respond",
      "session_wait",
      "session_signal",
      "session_request_list",
      "session_request_get",
      "session_request_ack",
      "session_request_cancel",
      "session_stop",
      "session_start",
      "session_export",
    ]);
    expect(Object.isFrozen(communicatorToolIds)).toBe(true);
  });
});
