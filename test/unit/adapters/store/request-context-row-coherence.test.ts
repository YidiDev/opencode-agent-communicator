import { describe, expect, test } from "bun:test";

import { RequestRepository } from "../../../../src/adapters/store/request-repository";
import { hydrateRequest, type RequestRow } from "../../../../src/adapters/store/request-rows";
import { StoreIntegrityError } from "../../../../src/adapters/store/store-types";
import { validateRequestId } from "../../../../src/domain/generated-ids";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("request-context-rows"));
const requestId = valid(validateRequestId(`req_${"1".repeat(32)}`));
const sourceSessionId = valid(validateSessionId("ses_source"));
const targetSessionId = valid(validateSessionId("ses_target"));

function row(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: requestId,
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    nativeMessageId: `msg_${"2".repeat(32)}`,
    deliveryMode: "context",
    deliveryTransport: "context",
    contextState: "prepared",
    contextAwaitingAtMs: null,
    contextAdmittedAtMs: null,
    contextFailedAtMs: null,
    contextCancelledAtMs: null,
    contextUpdatedAtMs: 1,
    linkedStartOperationId: null,
    kind: "wait",
    resolutionState: "pending",
    deliveryState: "prepared",
    resultState: "none",
    payloadByteLength: 1,
    payloadSha256: "a".repeat(64),
    createdAtMs: 1,
    updatedAtMs: 1,
    deadlineAtMs: 10,
    submittedAtMs: null,
    deliveryUnknownAtMs: null,
    admittedAtMs: null,
    promotedAtMs: null,
    deliveryFailedAtMs: null,
    admittedSeq: null,
    promotedSeq: null,
    evidenceObservedAtMs: null,
    resolvedAtMs: null,
    resultByteLength: null,
    resultSha256: null,
    resultAvailableAtMs: null,
    resultExpiresAtMs: null,
    resultExpiredAtMs: null,
    acknowledgedAtMs: null,
    ...overrides,
  };
}

describe("request context row coherence", () => {
  test("hydrates a prepared context row without inventing transition timestamps", () => {
    expect(hydrateRequest(row())).toMatchObject({
      deliveryMode: "context",
      deliveryState: "prepared",
      updatedAtMs: 1,
    });
  });

  test("projects cancellation as terminal delivery failure", () => {
    expect(
      hydrateRequest(
        row({
          contextState: "cancelled",
          contextAwaitingAtMs: 1,
          contextCancelledAtMs: 2,
          contextUpdatedAtMs: 2,
          resolutionState: "cancelled",
          deliveryState: "delivery_failed",
          payloadSha256: null,
          updatedAtMs: 2,
          resolvedAtMs: 2,
        }),
      ),
    ).toMatchObject({
      deliveryState: "delivery_failed",
      deliveryFailedAtMs: 2,
      resolutionState: "cancelled",
    });
  });

  test("rejects unknown context states and context rows attached to native delivery", () => {
    expect(() => hydrateRequest(row({ contextState: "unknown" }))).toThrow(StoreIntegrityError);
    expect(() =>
      hydrateRequest(
        row({ deliveryMode: "steer", deliveryTransport: "steer", contextState: "prepared" }),
      ),
    ).toThrow(StoreIntegrityError);
  });
});

test("request metadata lookups reject malformed identities before querying", () => {
  let queries = 0;
  const subject = new RequestRepository(
    {
      workspaceKey,
      database: {
        query: () => {
          queries += 1;
          return { get: () => undefined };
        },
      },
    } as never,
    {
      assertOrdinaryWorkAllowed: () => undefined,
      assertCurrent: () => undefined,
    } as never,
  );
  expect(
    subject.getRequestMetadata({ fencingToken: 1, workspaceKey, requestId: "malformed" } as never),
  ).toBeUndefined();
  expect(
    subject.getRequestMetadataForRecovery({
      fencingToken: 1,
      workspaceKey,
      requestId: "malformed",
    } as never),
  ).toBeUndefined();
  expect(queries).toBe(0);
});
