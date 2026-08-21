import { describe, expect, test } from "bun:test";

import { mergedActivityStatus } from "../../../../src/adapters/native/opencode-1-18-21-sessions";
import { validateSessionId } from "../../../../src/domain/sessions";

const validated = validateSessionId("ses_truth");
if (!validated.ok) throw new Error("invalid fixture");
const sessionId = validated.value;

describe("OpenCode 1.18.21 merged activity truth table", () => {
  test.each([
    ["absent from both", undefined, undefined, "idle"],
    ["legacy idle and V2 absent", { type: "idle" }, undefined, "idle"],
    ["legacy busy and V2 absent", { type: "busy" }, undefined, "busy"],
    [
      "legacy retry and V2 absent",
      { type: "retry", attempt: 0, message: "later", next: 0 },
      undefined,
      "retry",
    ],
    ["legacy absent and V2 running", undefined, { type: "running" }, "busy"],
    ["legacy idle and V2 running", { type: "idle" }, { type: "running" }, "busy"],
    ["legacy malformed and V2 running", { type: "bad" }, { type: "running" }, "busy"],
    ["legacy busy owns malformed V2", { type: "busy" }, { type: "bad" }, "busy"],
    [
      "legacy retry owns malformed V2",
      { type: "retry", attempt: 1, message: "later", next: 2 },
      null,
      "retry",
    ],
    ["legacy absent and V2 malformed", undefined, { type: "bad" }, "unknown"],
    ["legacy idle and V2 malformed", { type: "idle" }, [], "unknown"],
    ["both malformed", { type: "bad" }, "running", "unknown"],
    ["legacy malformed and V2 absent", { type: "bad" }, undefined, "unknown"],
  ] as const)("classifies %s", (_label, legacy, active, expected) => {
    const statuses = legacy === undefined ? {} : { [sessionId]: legacy };
    const activeMap = active === undefined ? {} : { [sessionId]: active };
    expect(mergedActivityStatus(statuses, activeMap, sessionId)).toBe(expected);
  });

  test.each([
    { type: "retry", attempt: -1, message: "later", next: 1 },
    { type: "retry", attempt: 1.5, message: "later", next: 1 },
    { type: "retry", attempt: Number.MAX_SAFE_INTEGER + 1, message: "later", next: 1 },
    { type: "retry", attempt: 1, message: 2, next: 1 },
    { type: "retry", attempt: 1, message: "later", next: -1 },
    { type: "retry", attempt: 1, message: "later", next: Number.POSITIVE_INFINITY },
  ])("rejects malformed legacy retry %#", (legacy) => {
    expect(mergedActivityStatus({ [sessionId]: legacy }, {}, sessionId)).toBe("unknown");
  });
});
