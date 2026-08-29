import { expect, test } from "bun:test";

import { extractToolCalls, parseJsonl } from "../../model-eval/jsonl";
import { scoreScenario } from "../../model-eval/scorer";

function event(tool: string, output: unknown, input: unknown = {}): string {
  return JSON.stringify({
    sessionID: "ses_source",
    part: { tool, state: { status: "completed", input, output: JSON.stringify(output) } },
  });
}

test("parses JSONL deterministically and decodes tool outputs", () => {
  const parsed = parseJsonl(`${event("session_list", { ok: true, value: [] })}\nnot-json\n`);
  expect(parsed.errors).toEqual(["line 2 is invalid JSON"]);
  expect(extractToolCalls(parsed.events)).toEqual([
    {
      name: "session_list",
      status: "completed",
      input: {},
      output: { ok: true, value: [] },
    },
  ]);
});

test("scores completed ordered calls, ok outputs, and observable skills", () => {
  const stdout = [
    event("skill", "loaded session-communication", { name: "session-communication" }),
    event("session_start", { ok: true, value: { session_id: "ses_target" } }),
    event("session_list", { ok: true, value: [] }),
  ].join("\n");
  const score = scoreScenario(
    { exitCode: 0, stdout, stderr: "" },
    ["skill", "session_start", "session_list"],
    ["session-communication"],
  );
  expect(score.passed).toBe(true);
  expect(score.errors).toEqual([]);
});

test("rejects malformed, out-of-order, non-ok, and forbidden calls", () => {
  const stdout = [
    event("session_list", { ok: true }),
    event("bash", { ok: true }),
    event("session_start", { ok: false }),
    "bad",
  ].join("\n");
  const score = scoreScenario({ exitCode: 2, stdout, stderr: "" }, [
    "session_start",
    "session_list",
  ]);
  expect(score.passed).toBe(false);
  expect(score.errors).toContain("line 4 is invalid JSON");
  expect(score.errors).toContain("process exited 2");
  expect(score.errors).toContain("forbidden tool called: bash");
  expect(score.errors).toContain("session_start did not return ok");
});
