import { expect, test } from "bun:test";
import {
  ParticipantDeletionReconciliationFault,
  reconcileParticipantDeletions,
} from "../../../src/application/participant-deletion-reconciliation";
import { validateNativeMessageId, validateRequestId } from "../../../src/domain/generated-ids";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const fencingToken = value(validateFencingToken(1));
const workspaceKey = value(validateWorkspaceKey("workspace:participant-reconciliation"));
const target = value(validateSessionId("ses_missingTarget"));
const source = value(validateSessionId("ses_missingSource"));

function crossedRequest(
  resolutionState: "target_deleted" | "source_deleted",
  seed = 1,
  reverse = false,
): RequestMetadata {
  const hex = seed.toString(16).padStart(32, "0");
  return {
    id: value(validateRequestId(`req_${hex}`)),
    workspaceKey,
    sourceSessionId: reverse ? target : source,
    targetSessionId: reverse ? source : target,
    nativeMessageId: value(validateNativeMessageId(`msg_${hex}`)),
    kind: "wait",
    resolutionState,
    deliveryState: "prepared",
    resultState: "none",
    payloadByteLength: 1,
    createdAtMs: 1,
    updatedAtMs: 2,
    deadlineAtMs: 10,
    resolvedAtMs: 2,
  };
}

test("reconciles direct absence in store target-first order and leaves unknown evidence untouched", async () => {
  const calls: string[] = [];
  const summary = await reconcileParticipantDeletions(
    {
      lifecycle: { fencingToken },
      workspaceKey,
      notifications: { notifyTerminal: () => undefined },
      presence: {
        async readParticipantPresence(sessionId) {
          calls.push(`get:${sessionId}`);
          return sessionId === source ? "unknown" : "absent";
        },
      },
      requests: {
        async listParticipantDeletionCandidates() {
          calls.push("candidates");
          return { ok: true, sessionIds: [target, source] };
        },
        async deleteParticipantRequests({ deletedSessionId }) {
          calls.push(`delete:${deletedSessionId}`);
          return { ok: true, terminalized: [] };
        },
        async deleteAbsentParticipantRequests({ absentSessionIds }) {
          calls.push(`delete-set:${absentSessionIds.join(",")}`);
          return { ok: true, terminalized: [] };
        },
      },
    },
    new AbortController().signal,
  );
  expect(calls).toEqual(["candidates", `get:${target}`, `get:${source}`, `delete-set:${target}`]);
  expect(summary).toEqual({ candidates: 2, absent: 1, unknown: 1, terminalized: 0 });
});

function options(
  candidateResult: unknown,
  presence: () => Promise<unknown> = async () => "present",
  deletionResult: unknown = { ok: true, terminalized: [] },
  notifyTerminal: (event: never) => void = () => undefined,
) {
  return {
    lifecycle: { fencingToken },
    workspaceKey,
    notifications: { notifyTerminal },
    presence: { readParticipantPresence: presence },
    requests: {
      listParticipantDeletionCandidates: async () => candidateResult,
      deleteParticipantRequests: async () => ({ ok: true as const, terminalized: [] }),
      deleteAbsentParticipantRequests: async () => deletionResult,
    },
  } as never;
}

test("fails closed on malformed, duplicate, and failed candidate query outcomes", async () => {
  for (const result of [
    null,
    { ok: false, code: "ownership_lost" },
    { ok: false, code: "storage_unavailable" },
    { ok: false, code: "future" },
    { ok: true, sessionIds: "invalid" },
    { ok: true, sessionIds: [target, target] },
    { ok: true, sessionIds: ["invalid"] },
  ]) {
    await expect(
      reconcileParticipantDeletions(options(result), new AbortController().signal),
    ).rejects.toBeInstanceOf(ParticipantDeletionReconciliationFault);
  }
  await expect(
    reconcileParticipantDeletions(
      options(Promise.reject(new Error("store"))),
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(ParticipantDeletionReconciliationFault);
});

test("treats thrown presence reads as unknown, validates values, and honors abort", async () => {
  expect(
    await reconcileParticipantDeletions(
      options({ ok: true, sessionIds: [target] }, async () => {
        throw new Error("transport");
      }),
      new AbortController().signal,
    ),
  ).toEqual({ candidates: 1, absent: 0, unknown: 1, terminalized: 0 });
  await expect(
    reconcileParticipantDeletions(
      options({ ok: true, sessionIds: [target] }, async () => "future"),
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(ParticipantDeletionReconciliationFault);
  const aborted = new AbortController();
  aborted.abort();
  expect(
    await reconcileParticipantDeletions(
      options({ ok: true, sessionIds: [target] }),
      aborted.signal,
    ),
  ).toEqual({ candidates: 1, absent: 0, unknown: 0, terminalized: 0 });
});

test("bounds a hostile presence promise that ignores cancellation", async () => {
  const controller = new AbortController();
  let started = false;
  const reconciliation = reconcileParticipantDeletions(
    options({ ok: true, sessionIds: [target] }, () => {
      started = true;
      return new Promise(() => undefined);
    }),
    controller.signal,
  );
  while (!started) await Promise.resolve();
  controller.abort("test");
  expect(await reconciliation).toEqual({
    candidates: 1,
    absent: 0,
    unknown: 0,
    terminalized: 0,
  });
});

test("validates committed batch metadata against complete-set target-first membership", async () => {
  const notified: string[] = [];
  const base = options(
    { ok: true, sessionIds: [source, target] },
    async () => "absent",
    {
      ok: true,
      terminalized: [crossedRequest("target_deleted"), crossedRequest("target_deleted", 2, true)],
    },
    (event: { resolutionState: string }) => notified.push(event.resolutionState),
  );
  expect(await reconcileParticipantDeletions(base, new AbortController().signal)).toEqual({
    candidates: 2,
    absent: 2,
    unknown: 0,
    terminalized: 2,
  });
  expect(notified).toEqual(["target_deleted", "target_deleted"]);

  const hostile = options({ ok: true, sessionIds: [source, target] }, async () => "absent", {
    ok: true,
    terminalized: [crossedRequest("source_deleted")],
  });
  await expect(
    reconcileParticipantDeletions(hostile, new AbortController().signal),
  ).rejects.toBeInstanceOf(ParticipantDeletionReconciliationFault);
});
