import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { requestLimits } from "../../../../src/domain/request-constants";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestFixture,
  requestFixtureForPayload,
  requestTestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

function targetInput(fixture: Awaited<ReturnType<typeof requestFixtureForPayload>>) {
  return {
    fencingToken: fixture.fencingToken,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
    callerSessionId: fixture.request.targetSessionId,
  };
}

function storedResult(databasePath: string, requestId: string) {
  const database = new Database(databasePath, { readonly: true, strict: true });
  const row = database
    .query<{ resultJson: string; bytes: number; digest: string }, [string]>(
      `SELECT rr.result_json AS resultJson, r.result_byte_length AS bytes,
         r.result_sha256 AS digest FROM requests AS r
       JOIN request_results AS rr ON rr.request_id = r.id WHERE r.id = ?`,
    )
    .get(requestId);
  database.close(true);
  if (!row) throw new Error("expected a retained result row");
  return row;
}

describe("ask terminal validation and canonical identity", () => {
  test("preserves exact option case and answer order and canonicalizes omitted question defaults", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixtureForPayload(token, {
      kind: "ask",
      questions: [
        { prompt: "Case", options: ["A", "a"], multiple: true },
        { prompt: "Optional", options: ["yes"], allowCustom: true },
      ],
      timeoutSeconds: 30,
    });
    expect(fixture.payloadJson).toBe(
      '{"kind":"ask","questions":[{"prompt":"Case","options":["A","a"],"multiple":true,"allowCustom":false},{"prompt":"Optional","options":["yes"],"multiple":false,"allowCustom":true}],"timeoutSeconds":30}',
    );
    expect(await store.createPrepared(fixture)).toMatchObject({ ok: true });
    const applied = await store.answerAsk({ ...targetInput(fixture), answers: [["a", "A"], []] });
    expect(applied).toMatchObject({
      ok: true,
      outcome: "applied",
      request: { kind: "ask", resolutionState: "answered" },
      result: { kind: "ask", answers: [["a", "A"], []] },
    });
    const expected = '{"kind":"ask","answers":[["a","A"],[]]}';
    const row = storedResult(store.databasePath, fixture.request.id);
    expect(row).toEqual({
      resultJson: expected,
      bytes: new TextEncoder().encode(expected).length,
      digest: createHash("sha256").update(expected).digest("hex"),
    });
    store.close();
  });

  test("rejects custom-disabled, case mismatch, duplicates, wrong count, and cardinality", async () => {
    const invalidAnswers: readonly string[][][] = [
      [["custom"], []],
      [["AA"], []],
      [["A", "A"], []],
      [["A"]],
      [["A"], ["yes", "other"]],
    ];
    for (const [index, answers] of invalidAnswers.entries()) {
      const store = openRequestStore();
      const token = await store.acquire();
      const fixture = await requestFixtureForPayload(
        token,
        {
          kind: "ask",
          questions: [
            { prompt: "Exact", options: ["A", "a"], multiple: true, allowCustom: false },
            { prompt: "Single", options: ["yes"], multiple: false, allowCustom: true },
          ],
          timeoutSeconds: 30,
        },
        { identitySeed: 10 + index },
      );
      await store.createPrepared(fixture);
      expect(await store.answerAsk({ ...targetInput(fixture), answers })).toMatchObject({
        ok: false,
        code: "state_conflict",
        request: { resolutionState: "pending" },
      });
      store.close();
    }
  });

  test("accepts empty unanswered arrays, custom-enabled text, and single/multiple boundaries", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixtureForPayload(token, {
      kind: "ask",
      questions: [
        { prompt: "Custom", options: [], allowCustom: true },
        { prompt: "Many", options: ["x", "y"], multiple: true, allowCustom: false },
        { prompt: "Unanswered", options: ["z"] },
      ],
      timeoutSeconds: 30,
    });
    await store.createPrepared(fixture);
    expect(
      await store.answerAsk({
        ...targetInput(fixture),
        answers: [["free form ✓"], ["y", "x"], []],
      }),
    ).toMatchObject({
      ok: true,
      result: { kind: "ask", answers: [["free form ✓"], ["y", "x"], []] },
    });
    store.close();
  });

  test("rejects unsafe and oversized answer content without retaining result bytes", async () => {
    for (const [index, answer] of ["unsafe\u0000text", "é".repeat(2_049)].entries()) {
      const store = openRequestStore();
      const token = await store.acquire();
      const fixture = await requestFixtureForPayload(
        token,
        {
          kind: "ask",
          questions: [{ prompt: "Custom", options: [], allowCustom: true }],
          timeoutSeconds: 30,
        },
        { identitySeed: 30 + index },
      );
      await store.createPrepared(fixture);
      expect(await store.answerAsk({ ...targetInput(fixture), answers: [[answer]] })).toMatchObject(
        {
          ok: false,
          code: "state_conflict",
          request: { resultState: "none" },
        },
      );
      const database = new Database(store.databasePath, { readonly: true, strict: true });
      expect(
        database
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM request_results WHERE request_id = ?",
          )
          .get(fixture.request.id)?.count,
      ).toBe(0);
      database.close(true);
      store.close();
    }
  });
});

describe("wait terminal validation and return discriminants", () => {
  test("distinguishes omitted evidence, explicit empty evidence, and bounded UTF-8 text", async () => {
    const cases: readonly [number, string | undefined, string][] = [
      [40, undefined, '{"kind":"wait"}'],
      [41, "", '{"kind":"wait","evidence":""}'],
      [
        42,
        "é".repeat(requestLimits.evidenceBytes / 2),
        `{"kind":"wait","evidence":"${"é".repeat(requestLimits.evidenceBytes / 2)}"}`,
      ],
    ];
    for (const [seed, evidence, expectedJson] of cases) {
      const store = openRequestStore();
      const token = await store.acquire();
      const fixture = await requestFixture(token, 1_000 + seed);
      await store.createPrepared(fixture);
      const result =
        evidence === undefined
          ? await store.signalWait({ ...targetInput(fixture) })
          : await store.signalWait({ ...targetInput(fixture), evidence });
      expect(result).toMatchObject({ ok: true, outcome: "applied", result: { kind: "wait" } });
      if (!result.ok) throw new Error("wait result unexpectedly failed");
      expect(result.request.kind).toBe("wait");
      expect(result.request.resolutionState).toBe("reached");
      expect(storedResult(store.databasePath, fixture.request.id).resultJson).toBe(expectedJson);
      store.close();
    }
  });

  test("rejects unsafe/oversized evidence and wrong-kind answer/signal operations", async () => {
    for (const [seed, evidence] of [
      [50, "bad\u0000"],
      [51, "é".repeat(2_049)],
    ] as const) {
      const store = openRequestStore();
      const token = await store.acquire();
      const fixture = await requestFixture(token, seed);
      await store.createPrepared(fixture);
      expect(await store.signalWait({ ...targetInput(fixture), evidence })).toMatchObject({
        ok: false,
        code: "state_conflict",
        request: { resolutionState: "pending" },
      });
      expect(await store.answerAsk({ ...targetInput(fixture), answers: [[]] })).toMatchObject({
        ok: false,
        code: "state_conflict",
        request: { resolutionState: "pending" },
      });
      store.close();
    }

    const store = openRequestStore();
    const token = await store.acquire();
    const ask = await requestFixtureForPayload(token, {
      kind: "ask",
      questions: [{ prompt: "q", options: ["a"] }],
      timeoutSeconds: 30,
    });
    await store.createPrepared(ask);
    expect(await store.signalWait(targetInput(ask))).toMatchObject({
      ok: false,
      code: "state_conflict",
      request: { resolutionState: "pending" },
    });
    store.close();
  });

  test("returns answered ask only and reached wait only at runtime", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const ask = await requestFixtureForPayload(token, {
      kind: "ask",
      questions: [{ prompt: "q", options: ["a"] }],
      timeoutSeconds: 30,
    });
    await store.createPrepared(ask);
    const answered = await store.answerAsk({ ...targetInput(ask), answers: [["a"]] });
    expect(answered).toMatchObject({
      ok: true,
      request: { kind: "ask", resolutionState: "answered" },
      result: { kind: "ask" },
    });
    expect(answered).not.toHaveProperty("workspaceKey");
    expect(answered).not.toHaveProperty("payload");
    expect(answered).not.toHaveProperty("digest");
    expect(requestTestWorkspace()).toBe(ask.request.workspaceKey);
    store.close();
  });
});
