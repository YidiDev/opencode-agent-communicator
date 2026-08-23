import { describe, expect, test } from "bun:test";

import { requestLimits } from "../../../src/domain/request-constants";
import {
  validateAskQuestion,
  validateAskRequestPayload,
  validateAskRequestResult,
  validatePendingRequestPayload,
  validateRetainedAskRequestResult,
  validateRetainedRequestResult,
  validateWaitRequestPayload,
  validateWaitRequestResult,
} from "../../../src/domain/request-content";
import type { AskQuestion, AskRequestPayload } from "../../../src/domain/request-types";
import {
  containsUnsafeRequestTextControl,
  requestTextControlPolicy,
} from "../../../src/domain/request-validation";

function required<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

function customQuestion(overrides: Partial<AskQuestion> = {}): AskQuestion {
  return { prompt: "Choose", options: [], multiple: false, allowCustom: true, ...overrides };
}

function swappingArray<Value>(first: Value, later: Value) {
  let reads = 0;
  const array = new Proxy([first], {
    get(target, property, receiver) {
      if (property === "0") {
        reads += 1;
        return reads === 1 ? first : later;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { array, reads: () => reads };
}

function exactSizeAskPayload(): unknown {
  const questions: {
    prompt: string;
    options: string[];
    multiple: boolean;
    allowCustom: boolean;
  }[] = Array.from({ length: 4 }, () => ({
    prompt: "x",
    options: [],
    multiple: false,
    allowCustom: true,
  }));
  const initial = { kind: "ask", questions, timeoutSeconds: 1 };
  let remaining =
    requestLimits.canonicalContentBytes - new TextEncoder().encode(JSON.stringify(initial)).length;
  for (const question of questions) {
    const addition = Math.min(remaining, requestLimits.promptBytes - 1);
    question.prompt += "x".repeat(addition);
    remaining -= addition;
  }
  if (remaining !== 0) throw new Error("boundary fixture capacity is wrong");
  return initial;
}

describe("request payload validation", () => {
  test("applies defaults without trimming, normalization, or reordering", () => {
    const result = validateAskQuestion({ prompt: "  Café\n", options: ["β", "alpha"] });
    expect(result).toMatchObject({
      ok: true,
      value: { prompt: "  Café\n", options: ["β", "alpha"], multiple: false, allowCustom: false },
    });
  });

  test("supports zero options only with custom text and rejects duplicate exact labels", () => {
    expect(validateAskQuestion({ prompt: "p", options: [], allowCustom: true }).ok).toBe(true);
    expect(validateAskQuestion({ prompt: "p", options: [] }).ok).toBe(false);
    expect(validateAskQuestion({ prompt: "p", options: ["x", "x"] }).ok).toBe(false);
    expect(validateAskQuestion({ prompt: "p", options: ["x", "X"] }).ok).toBe(true);
  });

  test("enforces counts, integer timeout, unsafe controls, and exact shapes", () => {
    const question = customQuestion();
    for (const timeoutSeconds of [1, 3600]) {
      expect(
        validateAskRequestPayload({ kind: "ask", questions: [question], timeoutSeconds }).ok,
      ).toBe(true);
    }
    for (const timeoutSeconds of [0, 1.5, 3601]) {
      expect(
        validateAskRequestPayload({ kind: "ask", questions: [question], timeoutSeconds }).ok,
      ).toBe(false);
    }
    expect(validateAskRequestPayload({ kind: "ask", questions: [], timeoutSeconds: 1 }).ok).toBe(
      false,
    );
    expect(
      validateAskRequestPayload({
        kind: "ask",
        questions: Array(11).fill(question),
        timeoutSeconds: 1,
      }).ok,
    ).toBe(false);
    expect(validateAskQuestion({ prompt: "bad\0text", options: ["x"] }).ok).toBe(false);
    expect(validateAskQuestion({ prompt: "x", options: ["bad\u0001"] }).ok).toBe(false);
    expect(validateAskQuestion({ prompt: "x", options: ["y"], extra: true }).ok).toBe(false);
    expect(validateAskQuestion({ prompt: "x", options: Array(21).fill("option") }).ok).toBe(false);
    expect(validateAskQuestion({ prompt: "x", options: ["y"], multiple: "no" }).ok).toBe(false);
    expect(
      validateAskRequestPayload({ kind: "wait", questions: [question], timeoutSeconds: 1 }).ok,
    ).toBe(false);
  });

  test("measures multibyte text and canonical JSON at exact UTF-8 boundaries", () => {
    expect(
      validateAskQuestion({ prompt: "é".repeat(requestLimits.promptBytes / 2), options: ["x"] }).ok,
    ).toBe(true);
    expect(
      validateAskQuestion({
        prompt: `${"é".repeat(requestLimits.promptBytes / 2)}a`,
        options: ["x"],
      }).ok,
    ).toBe(false);
    const exact = validateAskRequestPayload(exactSizeAskPayload());
    expect(exact).toMatchObject({ ok: true, byteLength: requestLimits.canonicalContentBytes });
    if (!exact.ok) throw new Error(exact.message);
    const oversized = { ...exact.value, questions: [...exact.value.questions, customQuestion()] };
    expect(validateAskRequestPayload(oversized).ok).toBe(false);
  });

  test("validates answer count, cardinality, labels, custom text, duplicates, and order", () => {
    const payload: AskRequestPayload = {
      kind: "ask",
      timeoutSeconds: 10,
      questions: [
        customQuestion({ options: ["a", "b"], allowCustom: false }),
        customQuestion({ options: ["x"], multiple: true }),
      ],
    };
    expect(validateAskRequestResult({ kind: "ask", answers: [[], []] }, payload).ok).toBe(true);
    const ordered = validateAskRequestResult(
      { kind: "ask", answers: [["b"], ["custom", "x"]] },
      payload,
    );
    expect(ordered).toMatchObject({ ok: true, value: { answers: [["b"], ["custom", "x"]] } });
    expect(validateAskRequestResult({ kind: "ask", answers: [["a", "b"], []] }, payload).ok).toBe(
      false,
    );
    expect(validateAskRequestResult({ kind: "ask", answers: [["unknown"], []] }, payload).ok).toBe(
      false,
    );
    expect(
      validateAskRequestResult({ kind: "ask", answers: [[], ["same", "same"]] }, payload).ok,
    ).toBe(false);
    expect(validateAskRequestResult({ kind: "ask", answers: [[]] }, payload).ok).toBe(false);
    expect(
      validateAskRequestResult({ kind: "ask", answers: [[], Array(21).fill("custom")] }, payload)
        .ok,
    ).toBe(false);
  });

  test("runtime-validates authoritative questions before accepting a response", () => {
    const mutable = {
      kind: "ask",
      questions: [{ prompt: "Q", options: ["yes"], multiple: false, allowCustom: false }],
      timeoutSeconds: 1,
    };
    expect(validateAskRequestResult({ kind: "ask", answers: [["yes"]] }, mutable).ok).toBe(true);
    mutable.questions[0]?.options.splice(0);
    expect(validateAskRequestResult({ kind: "ask", answers: [["yes"]] }, mutable).ok).toBe(false);
    expect(
      validateAskRequestResult(
        { kind: "ask", answers: [["yes"]] },
        { kind: "wait", milestone: "wrong", timeoutSeconds: 1 },
      ).ok,
    ).toBe(false);
    expect(validateRetainedAskRequestResult({ kind: "ask", answers: [["arbitrary"]] }).ok).toBe(
      true,
    );
  });

  test("rejects centralized C1 and bidi controls without normalizing ordinary Unicode", () => {
    const listed = [
      ...Array.from({ length: 0x20 }, (_, index) => index + 0x80),
      ...requestTextControlPolicy.rejectedCodePoints,
      0x202a,
      0x202b,
      0x202c,
      0x202d,
      0x202e,
      ...Array.from({ length: 10 }, (_, index) => index + 0x2066),
    ];
    for (const codePoint of listed) {
      const control = String.fromCodePoint(codePoint);
      expect(containsUnsafeRequestTextControl(control)).toBe(true);
      expect(validateAskQuestion({ prompt: `safe${control}text`, options: ["x"] }).ok).toBe(false);
    }
    const labels = ["é", "e\u0301", "東京", "🚀"];
    const result = validateAskQuestion({ prompt: "Unicode", options: labels });
    expect(result).toMatchObject({ ok: true, value: { options: labels } });
  });
});

describe("request caller-owned array isolation", () => {
  test("snapshots external arrays by index without invoking caller iterators", () => {
    const options = ["yes"];
    const questions = [{ prompt: "Q", options }];
    const innerAnswers = ["yes"];
    const answers = [innerAnswers];
    for (const array of [options, questions, innerAnswers, answers]) {
      Object.defineProperty(array, Symbol.iterator, {
        value() {
          throw new Error("caller iterator must not run");
        },
      });
    }
    const payload = { kind: "ask", questions, timeoutSeconds: 1 };
    expect(validateAskRequestPayload(payload).ok).toBe(true);
    expect(validateAskRequestResult({ kind: "ask", answers }, payload).ok).toBe(true);
    expect(validateRetainedAskRequestResult({ kind: "ask", answers }).ok).toBe(true);
  });

  test("reads proxied array indices once and cannot swap validated controls", () => {
    let safeReads = 0;
    const safeThenControl = new Proxy(["safe"], {
      get(target, property, receiver) {
        if (property === "0") {
          safeReads += 1;
          return safeReads === 1 ? "safe" : "\u2066";
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const accepted = validateAskQuestion({ prompt: "Q", options: safeThenControl });
    expect(accepted).toMatchObject({ ok: true, value: { options: ["safe"] } });
    expect(safeReads).toBe(1);

    let controlReads = 0;
    const controlThenSafe = new Proxy(["safe"], {
      get(target, property, receiver) {
        if (property === "0") {
          controlReads += 1;
          return controlReads === 1 ? "\u206f" : "safe";
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(validateAskQuestion({ prompt: "Q", options: controlThenSafe }).ok).toBe(false);
    expect(controlReads).toBe(1);
  });

  test("snapshots question and outer/inner answer indices exactly once", () => {
    const options = swappingArray("yes", "\u206f");
    const questions = swappingArray(
      { prompt: "Q", options: options.array },
      { prompt: "bad\u206f", options: ["yes"] },
    );
    const innerAnswers = swappingArray("yes", "\u206f");
    const outerAnswers = swappingArray(innerAnswers.array, ["\u206f"]);
    const payload = { kind: "ask", questions: questions.array, timeoutSeconds: 1 };
    expect(validateAskRequestResult({ kind: "ask", answers: outerAnswers.array }, payload).ok).toBe(
      true,
    );
    expect(questions.reads()).toBe(1);
    expect(options.reads()).toBe(1);
    expect(outerAnswers.reads()).toBe(1);
    expect(innerAnswers.reads()).toBe(1);
  });

  test("preserves omitted evidence separately from explicitly empty evidence", () => {
    expect(required(validateWaitRequestResult({ kind: "wait" }))).toEqual({ kind: "wait" });
    expect(required(validateWaitRequestResult({ kind: "wait", evidence: "" }))).toEqual({
      kind: "wait",
      evidence: "",
    });
    expect(validateWaitRequestResult({ kind: "wait", evidence: "\0" }).ok).toBe(false);
    expect(validateWaitRequestPayload({ kind: "wait", milestone: "m", timeoutSeconds: 1 }).ok).toBe(
      true,
    );
    expect(validateWaitRequestPayload({ kind: "ask", milestone: "m", timeoutSeconds: 1 }).ok).toBe(
      false,
    );
    expect(validateWaitRequestPayload({ kind: "wait", milestone: "m", timeoutSeconds: 0 }).ok).toBe(
      false,
    );
    expect(validateWaitRequestPayload({ kind: "wait", milestone: "", timeoutSeconds: 1 }).ok).toBe(
      false,
    );
    const wait = required(
      validateWaitRequestPayload({ kind: "wait", milestone: "m", timeoutSeconds: 1 }),
    );
    expect(validatePendingRequestPayload(wait).ok).toBe(true);
    expect(validatePendingRequestPayload({ kind: "other" }).ok).toBe(false);
    expect(
      validatePendingRequestPayload({
        kind: "wait",
        milestone: "m",
        timeoutSeconds: 1,
        extra: true,
      }).ok,
    ).toBe(false);
    expect(validateRetainedRequestResult({ kind: "wait", evidence: "done" }).ok).toBe(true);
    expect(validateWaitRequestResult({ kind: "ask" }).ok).toBe(false);
  });
});
