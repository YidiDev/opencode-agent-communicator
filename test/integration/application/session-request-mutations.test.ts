import { afterEach, expect, test } from "bun:test";

import { respondToSessionRequest } from "../../../src/application/respond-to-session-request";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestDigestPort,
  requestFixtureForPayload,
} from "../../support/request-store";

afterEach(cleanupRequestStoreRoots);

test("application response path leaves authoritative option validation inside the transaction", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const fixture = await requestFixtureForPayload(token, {
    kind: "ask",
    questions: [{ prompt: "Choose", options: ["exact"], multiple: false }],
    timeoutSeconds: 30,
  });
  expect(await store.createPrepared(fixture)).toMatchObject({ ok: true });
  const notifications: unknown[][] = [];
  const ports = {
    clock: { nowMs: () => 0 },
    digest: requestDigestPort,
    membership: {
      readCurrentRoots: async () => ({
        sourceTitle: undefined,
        sourceVisible: true,
        targetVisible: false,
      }),
    },
    requests: store,
    notifications: {
      notifyTerminal: (...args: unknown[]): undefined => {
        notifications.push(args);
        return undefined;
      },
    },
  };
  const context = {
    workspaceKey: fixture.request.workspaceKey,
    callerSessionId: fixture.request.targetSessionId,
    fencingToken: token,
    abort: new AbortController().signal,
    deadlineMs: 1_000_000_000,
  };

  expect(
    await respondToSessionRequest(ports, context, {
      request_id: fixture.request.id,
      answers: [["not-an-option"]],
    }),
  ).toMatchObject({ ok: false, error: { code: "state_conflict" } });
  expect(notifications).toEqual([]);

  expect(
    await respondToSessionRequest(ports, context, {
      request_id: fixture.request.id,
      answers: [["exact"]],
    }),
  ).toMatchObject({
    ok: true,
    value: { request_id: fixture.request.id, state: "answered" },
  });
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.[0]).toEqual({
    requestId: fixture.request.id,
    kind: "ask",
    resolutionState: "answered",
    resolvedAtMs: 25_000,
    retainedResult: { kind: "ask", answers: [["exact"]] },
  });
  await store.close();
});
