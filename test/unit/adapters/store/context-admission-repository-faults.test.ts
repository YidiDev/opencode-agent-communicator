import { expect, test } from "bun:test";

import { ContextAdmissionRepository } from "../../../../src/adapters/store/context-admission-repository";
import {
  failContextAdmissionRows,
  isExactContextEnvelope,
  settleParticipantContextRows,
} from "../../../../src/adapters/store/context-admission-repository-shared";
import { StoreIntegrityError } from "../../../../src/adapters/store/store-types";
import { validateDeliveryId, validateRequestId } from "../../../../src/domain/generated-ids";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("context-repository-faults"));
const sourceSessionId = valid(validateSessionId("ses_source"));
const targetSessionId = valid(validateSessionId("ses_target"));
const deliveryId = valid(validateDeliveryId(`dlv_${"1".repeat(32)}`));
const requestId = valid(validateRequestId(`req_${"2".repeat(32)}`));

function admissionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: deliveryId,
    kind: "message",
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    state: "awaiting_context",
    contentByteLength: 2,
    contentSha256: "a".repeat(64),
    createdAtMs: 1,
    updatedAtMs: 1,
    awaitingContextAtMs: 1,
    contextAdmittedAtMs: null,
    failedAtMs: null,
    cancelledAtMs: null,
    claimedFencingToken: null,
    ...overrides,
  };
}

function repository(database: unknown) {
  return new ContextAdmissionRepository(
    {
      workspaceKey,
      nowWallMs: () => 10,
      maximumPageCount: 100,
      database,
    } as never,
    { assertOrdinaryWorkAllowed: () => undefined } as never,
  );
}

test("fails closed on malformed stored admission metadata", () => {
  const subject = repository({
    query: () => ({ get: () => admissionRow({ id: "malformed" }) }),
  });
  expect(() => subject.get({ fencingToken: 1, workspaceKey, id: deliveryId } as never)).toThrow(
    StoreIntegrityError,
  );
});

test("validates request-context linkage and envelope integrity before insertion", () => {
  const subject = repository({ run: () => ({ changes: 1 }) });
  const request = {
    id: requestId,
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    createdAtMs: 1,
  } as never;
  expect(() =>
    subject.insertRequestInTransaction(request, {
      requestId: valid(validateRequestId(`req_${"3".repeat(32)}`)),
      envelopeJson: "{}",
      contentByteLength: 2,
      contentSha256: "a".repeat(64),
    } as never),
  ).toThrow("request context admission was malformed");
  expect(() =>
    subject.insertRequestInTransaction(request, {
      requestId,
      envelopeJson: "not-json",
      contentByteLength: 8,
      contentSha256: "a".repeat(64),
    } as never),
  ).toThrow("request context admission was malformed");
});

test("rejects malformed reminder aggregates and result identities", () => {
  const invoke = (count: unknown, result: unknown) =>
    repository({
      query: (sql: string) => ({
        get: () => (sql.includes("advisory_locks") ? { count } : undefined),
        all: () => [result],
      }),
    }).readReminders({
      fencingToken: 1,
      workspaceKey,
      targetSessionId,
      resultLimit: 1,
    } as never);

  expect(() => invoke(-1, { requestId, kind: "wait" })).toThrow(
    "lock reminder count was malformed",
  );
  expect(() => invoke(0, { requestId: "malformed", kind: "wait" })).toThrow(
    "result reminder was malformed",
  );
  expect(() => invoke(0, { requestId, kind: "other" })).toThrow("result reminder was malformed");
  expect(invoke(0, { requestId, kind: "ask" })).toEqual({
    activeLockCount: 0,
    availableResults: [{ requestId, kind: "ask" }],
  });
});

test("detects claim compare-and-swap and post-read failures", () => {
  let selects = 0;
  const claim = (changes: number, after: unknown) =>
    repository({
      transaction: (operation: () => unknown) => ({ immediate: operation }),
      query: (sql: string) => ({
        get: () => {
          if (sql.includes("state = 'awaiting_context'")) return admissionRow();
          selects += 1;
          return after;
        },
      }),
      run: () => ({ changes }),
    }).claim({
      fencingToken: 1,
      workspaceKey,
      targetSessionId,
      items: [{ id: deliveryId, kind: "message", contentSha256: "a".repeat(64) }],
    } as never);

  expect(() => claim(0, undefined)).toThrow("context claim CAS failed");
  expect(() => claim(1, admissionRow())).toThrow("context claim result was malformed");
  expect(selects).toBeGreaterThan(0);
});

test("classifies absent create postconditions as state conflicts", () => {
  const subject = repository({
    transaction: (operation: () => unknown) => ({ immediate: operation }),
    run: () => ({ changes: 1 }),
    query: (sql: string) => ({
      get: () => (sql.includes("page_count") ? { pageCount: 1 } : undefined),
    }),
  });
  expect(
    subject.createMessage({
      fencingToken: 1,
      id: deliveryId,
      workspaceKey,
      sourceSessionId,
      targetSessionId,
      envelopeJson: "{}",
      contentByteLength: 2,
      contentSha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      createdAtMs: 1,
    } as never),
  ).toEqual({ ok: false, code: "state_conflict" });
});

test("fails closed when context settlement postconditions are not durable", () => {
  const context = {
    workspaceKey,
    nowWallMs: () => 10,
    maximumPageCount: 100,
    database: {
      run: () => ({ changes: 1 }),
      query: () => ({ get: () => admissionRow() }),
    },
  } as never;
  expect(() =>
    failContextAdmissionRows(context, [admissionRow()] as never, workspaceKey, 1 as never, 10),
  ).toThrow("Context failure was lost");
  expect(() =>
    settleParticipantContextRows(
      context,
      [admissionRow()] as never,
      workspaceKey,
      1 as never,
      10,
      new Set([targetSessionId]),
    ),
  ).toThrow("Participant context settlement was lost");
});

test("terminalizes request context for either deleted participant role", () => {
  const run = (terminalIds: ReadonlySet<string>) => {
    let state = "awaiting_context";
    const row = () =>
      admissionRow({
        id: requestId,
        kind: "request",
        state,
        updatedAtMs: state === "awaiting_context" ? 1 : 10,
        failedAtMs: state === "failed" ? 10 : null,
        cancelledAtMs: state === "cancelled" ? 10 : null,
      });
    const context = {
      workspaceKey,
      nowWallMs: () => 10,
      maximumPageCount: 100,
      database: {
        run: (sql: string, parameters: unknown[]) => {
          if (sql.includes("UPDATE context_admissions")) state = parameters[0] as string;
          return { changes: 1 };
        },
        query: (sql: string) => ({
          get: () => (sql.includes(" AS count") ? { count: 0 } : row()),
        }),
      },
    } as never;
    return settleParticipantContextRows(
      context,
      [row()] as never,
      workspaceKey,
      1 as never,
      10,
      terminalIds,
    );
  };
  expect(run(new Set([targetSessionId]))).toMatchObject([{ state: "failed" }]);
  expect(run(new Set([sourceSessionId]))).toMatchObject([{ state: "cancelled" }]);
  expect(isExactContextEnvelope(1, 1, "a".repeat(64))).toBe(false);
});
