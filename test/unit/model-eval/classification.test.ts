import { expect, test } from "bun:test";

import { classifyProcess, classifyScores, isTransient } from "../../model-eval/classification";

const failedScore = { passed: false, errors: ["missing tool"], tools: [] } as const;
const passedScore = { passed: true, errors: [], tools: [] } as const;

test("classifies provider diagnostics with stable precedence", () => {
  expect(classifyProcess({ exitCode: 1, stdout: "", stderr: "HTTP 429 too many requests" })).toBe(
    "rate_limited",
  );
  expect(
    classifyProcess({ exitCode: 1, stdout: "", stderr: "HTTP 503 provider unavailable" }),
  ).toBe("provider_unavailable");
  expect(classifyProcess({ exitCode: 1, stdout: "unknown model", stderr: "" })).toBe(
    "model_removed",
  );
  expect(classifyProcess({ exitCode: 1, stdout: "bad tool choice", stderr: "" })).toBeUndefined();
  expect(
    classifyProcess({
      exitCode: 0,
      stdout:
        '{"updated_at_ms":1787971849155,"status_observed_at_ms":1787971851637,"tokens":{"total":408}}',
      stderr: "",
    }),
  ).toBeUndefined();
});

test("classifies behavior scores and only retries transient provider outcomes", () => {
  expect(classifyScores({ smoke: passedScore })).toBe("passed");
  expect(classifyScores({ smoke: failedScore })).toBe("behavior_failed");
  expect(isTransient("rate_limited")).toBe(true);
  expect(isTransient("provider_unavailable")).toBe(true);
  expect(isTransient("behavior_failed")).toBe(false);
  expect(isTransient("model_removed")).toBe(false);
});
