import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { RequestParticipantMutationInput } from "../../../../src/application/request-ports";
import { validateFencingToken } from "../../../../src/domain/ownership";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestClock,
  requestFixture,
  requestFixtureForPayload,
  requestSession,
  requestTemporaryRoot,
  requestTestWorkspace,
  requestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

const hidden = { ok: false, code: "not_found_or_unauthorized" } as const;

function sourceInput(fixture: Awaited<ReturnType<typeof requestFixture>>) {
  return {
    fencingToken: fixture.fencingToken,
    workspaceKey: fixture.request.workspaceKey,
    requestId: fixture.request.id,
    callerSessionId: fixture.request.sourceSessionId,
  };
}

function targetInput(fixture: Awaited<ReturnType<typeof requestFixture>>) {
  return { ...sourceInput(fixture), callerSessionId: fixture.request.targetSessionId };
}

function hiddenValidInputs(
  correct: RequestParticipantMutationInput,
  oppositeSessionId: RequestParticipantMutationInput["callerSessionId"],
  absentRequestId: RequestParticipantMutationInput["requestId"],
): readonly RequestParticipantMutationInput[] {
  return [
    { ...correct, callerSessionId: oppositeSessionId },
    { ...correct, callerSessionId: requestSession("ses_unrelated") },
    { ...correct, requestId: absentRequestId },
    { ...correct, workspaceKey: requestWorkspace("foreign-workspace") },
  ];
}

function malformedInput(
  input: RequestParticipantMutationInput,
  field: "requestId" | "callerSessionId",
): RequestParticipantMutationInput {
  const malformed = { ...input };
  Reflect.set(malformed, field, "bad");
  return malformed;
}

describe("exact participant authorization matrix", () => {
  test("malformed participants are hidden before caller answer or evidence getters are read", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    const malformed = malformedInput(targetInput(fixture), "requestId");
    const answer = {
      ...malformed,
      get answers(): never {
        throw new Error("answers must remain unread");
      },
    };
    const evidence = {
      ...malformed,
      get evidence(): never {
        throw new Error("evidence must remain unread");
      },
    };
    expect(await store.answerAsk(answer)).toEqual(hidden);
    expect(await store.signalWait(evidence)).toEqual(hidden);
    store.close();
  });

  test("answer hides opposite role, unrelated session, absent id, malformed ids, and workspace", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixtureForPayload(token, {
      kind: "ask",
      questions: [{ prompt: "q", options: ["a"] }],
      timeoutSeconds: 30,
    });
    const absent = await requestFixture(token, 2_000);
    await store.createPrepared(fixture);
    const correct = targetInput(fixture);
    for (const input of hiddenValidInputs(
      correct,
      fixture.request.sourceSessionId,
      absent.request.id,
    )) {
      expect(await store.answerAsk({ ...input, answers: [["a"]] })).toEqual(hidden);
    }
    expect(
      await store.answerAsk({ ...malformedInput(correct, "requestId"), answers: [["a"]] }),
    ).toEqual(hidden);
    expect(
      await store.answerAsk({ ...malformedInput(correct, "callerSessionId"), answers: [["a"]] }),
    ).toEqual(hidden);
    expect(await store.answerAsk({ ...correct, answers: [["a"]] })).toMatchObject({ ok: true });
    store.close();
  });

  test("signal hides opposite role, unrelated session, absent id, malformed ids, and workspace", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    const absent = await requestFixture(token, 2_000);
    await store.createPrepared(fixture);
    const correct = targetInput(fixture);
    for (const input of hiddenValidInputs(
      correct,
      fixture.request.sourceSessionId,
      absent.request.id,
    )) {
      expect(await store.signalWait(input)).toEqual(hidden);
    }
    expect(await store.signalWait(malformedInput(correct, "requestId"))).toEqual(hidden);
    expect(await store.signalWait(malformedInput(correct, "callerSessionId"))).toEqual(hidden);
    expect(await store.signalWait(correct)).toMatchObject({ ok: true });
    store.close();
  });

  test("cancel hides opposite role, unrelated session, absent id, malformed ids, and workspace", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    const absent = await requestFixture(token, 2_000);
    await store.createPrepared(fixture);
    const correct = sourceInput(fixture);
    for (const input of hiddenValidInputs(
      correct,
      fixture.request.targetSessionId,
      absent.request.id,
    )) {
      expect(await store.cancelPending(input)).toEqual(hidden);
    }
    expect(await store.cancelPending(malformedInput(correct, "requestId"))).toEqual(hidden);
    expect(await store.cancelPending(malformedInput(correct, "callerSessionId"))).toEqual(hidden);
    expect(await store.cancelPending(correct)).toMatchObject({
      ok: true,
      outcome: "applied",
      resolutionState: "cancelled",
    });
    store.close();
  });

  test("ack hides opposite role, unrelated session, absent id, malformed ids, and workspace", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    const absent = await requestFixture(token, 2_000);
    await store.createPrepared(fixture);
    await store.signalWait(targetInput(fixture));
    const correct = sourceInput(fixture);
    for (const input of hiddenValidInputs(
      correct,
      fixture.request.targetSessionId,
      absent.request.id,
    )) {
      expect(await store.acknowledgeResult(input)).toEqual(hidden);
    }
    expect(await store.acknowledgeResult(malformedInput(correct, "requestId"))).toEqual(hidden);
    expect(await store.acknowledgeResult(malformedInput(correct, "callerSessionId"))).toEqual(
      hidden,
    );
    expect(await store.acknowledgeResult(correct)).toMatchObject({ ok: true, outcome: "applied" });
    store.close();
  });

  test("malformed participant input does not renew the ownership lease", async () => {
    const clock = requestClock();
    const store = openRequestStore({
      nowWallMs: clock.wall,
      nowMonotonicMs: clock.monotonic,
      leaseDurationMs: 1_000,
    });
    const token = await store.acquire();
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    const raw = new Database(store.databasePath, { readonly: true, strict: true });
    const renewedBefore = raw
      .query<{ renewed: number }, []>(
        "SELECT renewed_wall_ms AS renewed FROM ownership WHERE singleton = 1",
      )
      .get()?.renewed;
    clock.set(25_900);
    expect(await store.signalWait(malformedInput(targetInput(fixture), "requestId"))).toEqual(
      hidden,
    );
    const renewedAfter = raw
      .query<{ renewed: number }, []>(
        "SELECT renewed_wall_ms AS renewed FROM ownership WHERE singleton = 1",
      )
      .get()?.renewed;
    expect(renewedAfter).toBe(renewedBefore);
    raw.close(true);
    store.close();
  });
});

describe("terminal fencing and workspace ownership", () => {
  test("every terminal method and result expiry returns the exact stale-fence code", async () => {
    const store = openRequestStore();
    const token = await store.acquire();
    const stale = validateFencingToken(Number(token) + 1);
    if (!stale.ok) throw new Error(stale.message);
    const fixture = await requestFixture(token);
    await store.createPrepared(fixture);
    expect(await store.signalWait({ ...targetInput(fixture), fencingToken: stale.value })).toEqual({
      ok: false,
      code: "ownership_lost",
    });
    expect(
      await store.answerAsk({ ...targetInput(fixture), fencingToken: stale.value, answers: [[]] }),
    ).toEqual({ ok: false, code: "ownership_lost" });
    expect(
      await store.cancelPending({ ...sourceInput(fixture), fencingToken: stale.value }),
    ).toEqual({
      ok: false,
      code: "ownership_lost",
    });
    expect(
      await store.acknowledgeResult({ ...sourceInput(fixture), fencingToken: stale.value }),
    ).toEqual({ ok: false, code: "ownership_lost" });
    expect(
      await store.expireAvailableResults({
        fencingToken: stale.value,
        workspaceKey: requestTestWorkspace(),
        limit: 1,
      }),
    ).toEqual({ ok: false, code: "ownership_lost" });
    store.close();
  });

  test("ownership takeover fences the old generation and identical participants cannot cross workspaces", async () => {
    const clock = requestClock();
    const stateDirectory = `${requestTemporaryRoot("request-takeover-")}/state`;
    const first = openRequestStore({
      stateDirectory,
      nowWallMs: clock.wall,
      nowMonotonicMs: clock.monotonic,
      leaseDurationMs: 1_000,
      takeoverGraceMs: 0,
    });
    const firstToken = await first.acquire();
    const fixture = await requestFixture(firstToken);
    await first.createPrepared(fixture);
    clock.set(26_001);
    const second = openRequestStore({
      stateDirectory,
      nowWallMs: clock.wall,
      nowMonotonicMs: clock.monotonic,
      leaseDurationMs: 1_000,
      takeoverGraceMs: 0,
    });
    const secondToken = await second.acquire();
    expect(await first.signalWait(targetInput(fixture))).toEqual({
      ok: false,
      code: "ownership_lost",
    });
    expect(
      await second.signalWait({ ...targetInput(fixture), fencingToken: secondToken }),
    ).toMatchObject({ ok: true });
    first.close();
    second.close();

    const foreign = openRequestStore({ workspaceKey: requestWorkspace("foreign-workspace") });
    const foreignToken = await foreign.acquire();
    expect(
      await foreign.signalWait({
        ...targetInput(fixture),
        fencingToken: foreignToken,
        workspaceKey: requestTestWorkspace(),
      }),
    ).toEqual(hidden);
    foreign.close();
  });
});
