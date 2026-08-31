import { expect, test } from "bun:test";

import type { ContextAdmissionPersistencePort } from "../../../src/application/context-admission-ports";
import type { ContextAdmissionRegistration } from "../../../src/application/context-admission-runtime";
import { waitForContextAdmission } from "../../../src/application/wait-for-context-admission";
import type { ContextAdmissionMetadata } from "../../../src/domain/context-admissions";
import { validateDeliveryId, validateRequestId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { validateFencingToken } from "../../../src/domain/ownership";
import type { RequestMetadata } from "../../../src/domain/request-types";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { requestFixture } from "../../support/request-store";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

function never<Value>(): Promise<Value> {
  return new Promise(() => {});
}

const fencingToken = valid(validateFencingToken(1));
const workspaceKey = valid(validateWorkspaceKey("context-wait"));
const id = valid(validateDeliveryId(`dlv_${"c".repeat(32)}`));
const admission: ContextAdmissionMetadata = {
  id,
  kind: "message",
  workspaceKey,
  sourceSessionId: valid(validateSessionId("ses_source")),
  targetSessionId: valid(validateSessionId("ses_target")),
  state: "awaiting_context",
  contentByteLength: 1,
  contentSha256: "d".repeat(64) as Sha256Digest,
  createdAtMs: 1,
  updatedAtMs: 1,
  awaitingContextAtMs: 1,
};

function settled(state: "context_admitted" | "cancelled" | "failed"): ContextAdmissionMetadata {
  return state === "context_admitted"
    ? {
        ...admission,
        state,
        updatedAtMs: 2,
        contextAdmittedAtMs: 2,
        claimedFencingToken: fencingToken,
      }
    : state === "cancelled"
      ? { ...admission, state, updatedAtMs: 2, cancelledAtMs: 2 }
      : { ...admission, state, updatedAtMs: 2, failedAtMs: 2 };
}

async function terminalParent(
  resolutionState: "target_stopped" | "source_stopped" | "target_deleted" | "source_deleted",
): Promise<RequestMetadata> {
  const fixture = await requestFixture(
    fencingToken,
    1,
    admission.sourceSessionId,
    admission.targetSessionId,
    workspaceKey,
  );
  const { payloadSha256: _payloadSha256, ...request } = fixture.request;
  return {
    ...request,
    deliveryMode: "context",
    resolutionState,
    updatedAtMs: 2,
    resolvedAtMs: 2,
  } as RequestMetadata;
}

function fixture(input: {
  readonly winner: "context_admitted" | "cancelled";
  readonly cancelThrows?: boolean;
}) {
  let reads = 0;
  let detached = 0;
  const contexts: ContextAdmissionPersistencePort = {
    createContextMessage: async () => ({ ok: false, code: "state_conflict" }),
    getContextAdmission: async () => {
      reads += 1;
      return reads === 1 ? admission : settled(input.winner);
    },
    listPendingContext: async () => [],
    claimPendingContext: async () => [],
    readContextReminders: async () => ({ activeLockCount: 0, availableResults: [] }),
    cancelContextAdmission: async () => {
      if (input.cancelThrows) throw new Error("ambiguous cancellation");
      return input.winner === "cancelled"
        ? { ok: true, admission: settled("cancelled") }
        : { ok: false, code: "state_conflict" };
    },
    failPendingContextForParticipant: async () => [],
    failUncertainContextOnStartup: async () => [],
  };
  const registration: ContextAdmissionRegistration = {
    outcome: new Promise(() => {}),
    detach: () => {
      detached += 1;
    },
  };
  return { contexts, registration, detached: () => detached };
}

test("reports success when transform admission wins the local deadline race", async () => {
  const value = fixture({ winner: "context_admitted" });
  const result = await waitForContextAdmission(
    { contexts: value.contexts },
    {
      fencingToken,
      workspaceKey,
      admission,
      registration: value.registration,
      abort: new AbortController().signal,
      deadlineMs: Date.now() - 1,
    },
  );
  expect(result).toMatchObject({ ok: true, value: { state: "context_admitted" } });
  expect(value.detached()).toBe(1);
});

test("reports deadline only after durable cancellation wins", async () => {
  const value = fixture({ winner: "cancelled" });
  const result = await waitForContextAdmission(
    { contexts: value.contexts },
    {
      fencingToken,
      workspaceKey,
      admission,
      registration: value.registration,
      abort: new AbortController().signal,
      deadlineMs: Date.now() - 1,
    },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "deadline_expired" } });
});

test("does not reclassify ambiguous cancellation as a deadline", async () => {
  const value = fixture({ winner: "cancelled", cancelThrows: true });
  const result = await waitForContextAdmission(
    { contexts: value.contexts },
    {
      fencingToken,
      workspaceKey,
      admission,
      registration: value.registration,
      abort: new AbortController().signal,
      deadlineMs: Date.now() - 1,
    },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});

test("classifies durable terminal and missing states without waiting", async () => {
  for (const [current, code] of [
    [settled("failed"), "target_idle"],
    [settled("cancelled"), "deadline_expired"],
    [undefined, "state_conflict"],
  ] as const) {
    const value = fixture({ winner: "cancelled" });
    value.contexts.getContextAdmission = async () => current;
    const result = await waitForContextAdmission(
      { contexts: value.contexts },
      {
        fencingToken,
        workspaceKey,
        admission,
        registration: value.registration,
        abort: new AbortController().signal,
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(value.detached()).toBe(1);
  }

  const value = fixture({ winner: "context_admitted" });
  value.contexts.getContextAdmission = async () => settled("context_admitted");
  expect(
    await waitForContextAdmission(
      { contexts: value.contexts },
      {
        fencingToken,
        workspaceKey,
        admission,
        registration: value.registration,
        abort: new AbortController().signal,
      },
    ),
  ).toMatchObject({ ok: true, value: { state: "context_admitted" } });
});

test("re-reads durable state after an unbounded local settlement", async () => {
  const value = fixture({ winner: "context_admitted" });
  const registration: ContextAdmissionRegistration = {
    ...value.registration,
    outcome: Promise.resolve({
      outcome: "settled",
      event: { id, kind: "message", state: "context_admitted" },
    }),
  };
  const result = await waitForContextAdmission(
    { contexts: value.contexts },
    {
      fencingToken,
      workspaceKey,
      admission,
      registration,
      abort: new AbortController().signal,
    },
  );
  expect(result).toMatchObject({ ok: true, value: { state: "context_admitted" } });
});

test("fails closed when local settlement rejects or remains durably ambiguous", async () => {
  const rejected = fixture({ winner: "cancelled" });
  const rejectedRegistration: ContextAdmissionRegistration = {
    ...rejected.registration,
    outcome: Promise.reject(new Error("runtime failed")),
  };
  expect(
    await waitForContextAdmission(
      { contexts: rejected.contexts },
      {
        fencingToken,
        workspaceKey,
        admission,
        registration: rejectedRegistration,
        abort: new AbortController().signal,
      },
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });

  const ambiguous = fixture({ winner: "cancelled" });
  ambiguous.contexts.getContextAdmission = async () => admission;
  expect(
    await waitForContextAdmission(
      { contexts: ambiguous.contexts },
      {
        fencingToken,
        workspaceKey,
        admission,
        registration: ambiguous.registration,
        abort: new AbortController().signal,
        deadlineMs: Date.now() - 1,
      },
    ),
  ).toMatchObject({ ok: false, error: { code: "admission_unknown" } });
});

test.each(["initial", "final"] as const)(
  "bounds a never-settling %s context read",
  async (phase) => {
    const value = fixture({ winner: "context_admitted" });
    let reads = 0;
    value.contexts.getContextAdmission = async () => {
      reads += 1;
      if (phase === "initial" || reads > 1) return never();
      return admission;
    };
    const registration: ContextAdmissionRegistration = {
      ...value.registration,
      outcome: Promise.resolve({
        outcome: "settled",
        event: { id, kind: "message", state: "context_admitted" },
      }),
    };
    expect(
      await waitForContextAdmission(
        { contexts: value.contexts },
        {
          fencingToken,
          workspaceKey,
          admission,
          registration,
          abort: new AbortController().signal,
          deadlineMs: Date.now() + 10,
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    expect(value.detached()).toBe(1);
  },
);

test.each(["cancellation", "reconciliation"] as const)(
  "bounds never-settling deadline %s I/O",
  async (phase) => {
    const value = fixture({ winner: "cancelled" });
    if (phase === "cancellation") {
      value.contexts.cancelContextAdmission = () => never();
    } else {
      let reads = 0;
      value.contexts.getContextAdmission = async () => (reads++ === 0 ? admission : never());
    }
    expect(
      await waitForContextAdmission(
        { contexts: value.contexts },
        {
          fencingToken,
          workspaceKey,
          admission,
          registration: value.registration,
          abort: new AbortController().signal,
          deadlineMs: Date.now() - 1,
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    expect(value.detached()).toBe(1);
  },
);

test.each([
  ["target_stopped", "target_stopped"],
  ["source_stopped", "source_stopped"],
  ["target_deleted", "target_deleted"],
  ["source_deleted", "source_deleted"],
] as const)(
  "maps a request context cancelled by a claim race to authoritative %s",
  async (resolutionState, code) => {
    const parent = await terminalParent(resolutionState);
    const requestAdmission = {
      ...settled("cancelled"),
      id: parent.id,
      kind: "request" as const,
    };
    const value = fixture({ winner: "cancelled" });
    value.contexts.getContextAdmission = async () => requestAdmission;
    const result = await waitForContextAdmission(
      {
        contexts: value.contexts,
        requests: { getRequestMetadata: async () => parent },
      },
      {
        fencingToken,
        workspaceKey,
        admission: requestAdmission,
        registration: value.registration,
        abort: new AbortController().signal,
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code } });
  },
);

test.each([
  ["target_stopped", "target_stopped"],
  ["target_deleted", "target_deleted"],
] as const)(
  "does not report deadline when %s wins against caller cancellation and context claim",
  async (resolutionState, code) => {
    const parent = await terminalParent(resolutionState);
    const awaiting = {
      ...admission,
      id: parent.id,
      kind: "request" as const,
    };
    const cancelled = {
      ...awaiting,
      state: "cancelled" as const,
      updatedAtMs: 2,
      cancelledAtMs: 2,
    };
    let reads = 0;
    const value = fixture({ winner: "cancelled" });
    value.contexts.getContextAdmission = async () => (reads++ === 0 ? awaiting : cancelled);
    value.contexts.cancelContextAdmission = async () => ({
      ok: false,
      code: "state_conflict",
    });
    const result = await waitForContextAdmission(
      {
        contexts: value.contexts,
        requests: { getRequestMetadata: async () => parent },
      },
      {
        fencingToken,
        workspaceKey,
        admission: awaiting,
        registration: value.registration,
        abort: new AbortController().signal,
        deadlineMs: Date.now() - 1,
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code } });
  },
);

test("fails closed when a cancelled request context has unavailable or incoherent parent state", async () => {
  const requestId = valid(validateRequestId(`req_${"f".repeat(32)}`));
  const requestAdmission = {
    ...settled("cancelled"),
    id: requestId,
    kind: "request" as const,
  };
  for (const parent of [undefined, { id: requestId, resolutionState: "pending" }]) {
    const value = fixture({ winner: "cancelled" });
    value.contexts.getContextAdmission = async () => requestAdmission;
    const result = await waitForContextAdmission(
      {
        contexts: value.contexts,
        requests: { getRequestMetadata: async () => parent as RequestMetadata | undefined },
      },
      {
        fencingToken,
        workspaceKey,
        admission: requestAdmission,
        registration: value.registration,
        abort: new AbortController().signal,
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  }
});

test("bounds a never-settling terminal parent read", async () => {
  const parent = await terminalParent("target_stopped");
  const requestAdmission = {
    ...settled("cancelled"),
    id: parent.id,
    kind: "request" as const,
  };
  const value = fixture({ winner: "cancelled" });
  value.contexts.getContextAdmission = async () => requestAdmission;
  expect(
    await waitForContextAdmission(
      {
        contexts: value.contexts,
        requests: { getRequestMetadata: () => never() },
      },
      {
        fencingToken,
        workspaceKey,
        admission: requestAdmission,
        registration: value.registration,
        abort: new AbortController().signal,
        deadlineMs: Date.now() + 10,
      },
    ),
  ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  expect(value.detached()).toBe(1);
});
