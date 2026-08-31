import { afterEach, describe, expect, test } from "bun:test";

import { createSessionStartPolicy } from "../../../src/domain/session-start-policy";
import {
  immediateRequestSchema,
  sessionAskArgumentsSchema,
  sessionRequestSendArgumentsSchema,
  sessionSignalArgumentsSchema,
} from "../../../src/tools/request-contracts";
import { createSessionRequestSendTool } from "../../../src/tools/session-request-send";
import { createSessionRequestStartTool } from "../../../src/tools/session-request-start";
import { blockingRequestFixture } from "../../support/blocking-request-fixture";
import {
  cleanupRequestStoreRoots,
  requestDigestPort,
  requestTestWorkspace,
} from "../../support/request-store";

afterEach(cleanupRequestStoreRoots);

const signal = () => new AbortController().signal;

describe("request contract coverage", () => {
  test("refines ask defaults and malformed session, content, and signal inputs", () => {
    expect(
      immediateRequestSchema.safeParse({
        kind: "ask",
        questions: [{ prompt: "Choose", options: ["one"] }],
        timeout_seconds: 30,
      }).success,
    ).toBe(true);
    expect(
      immediateRequestSchema.safeParse({
        kind: "ask",
        questions: [{ prompt: "Choose", options: [] }],
        timeout_seconds: 30,
      }).success,
    ).toBe(false);
    expect(
      sessionAskArgumentsSchema.safeParse({
        session_id: "ses_target",
        questions: [{ prompt: "Choose", options: ["one"] }],
        timeout_seconds: 30,
      }).success,
    ).toBe(true);
    expect(
      sessionRequestSendArgumentsSchema.safeParse({
        session_id: "bad",
        content: "unsafe\u0000",
        request: { kind: "wait", milestone: "done", timeout_seconds: 30 },
      }).success,
    ).toBe(false);
    expect(
      sessionSignalArgumentsSchema.safeParse({ request_id: `req_${"a".repeat(32)}` }).success,
    ).toBe(true);
  });
});

describe("immediate request tool coverage", () => {
  test("request-send maps ask defaults and rejects invalid target and caller IDs", async () => {
    const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
    const tool = createSessionRequestSendTool(
      {
        readiness: { ...setup.ports.readiness, fencingToken: setup.token },
        membership: setup.ports.membership,
        requests: setup.ports.requests,
        scheduler: setup.ports.scheduler,
        nativeQueue: { queueMessage: async () => ({ kind: "unknown" }) },
        contexts: setup.store,
        contextRuntime: setup.contextRuntime,
        activity: setup.ports.activity,
        participantOperations: setup.ports.participantOperations,
        ownership: setup.store,
        clock: setup.ports.clock,
        ids: setup.ports.ids,
        digest: requestDigestPort,
      },
      {
        workspaceKey: requestTestWorkspace(),
        fencingToken: setup.token,
        invocationDeadlineMs: () => 90_000,
      },
      { message: "allow", ask: "allow", wait: "allow" },
    );

    const created = JSON.parse(
      await tool.execute(
        {
          session_id: setup.target,
          content: "Choose an option.",
          request: {
            kind: "ask",
            questions: [{ prompt: "Choose", options: ["one"] }],
            timeout_seconds: 30,
          },
        },
        { sessionID: setup.source, abort: signal() },
      ),
    );
    expect(created).toMatchObject({
      ok: true,
      value: { kind: "ask", delivery_mode: "context", delivery_state: "context_admitted" },
    });

    const invalidTarget = JSON.parse(
      await tool.execute(
        {
          session_id: "bad",
          content: "Choose an option.",
          request: { kind: "wait", milestone: "done", timeout_seconds: 30 },
        },
        { sessionID: setup.source, abort: signal() },
      ),
    );
    expect(invalidTarget).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });

    const invalidCaller = JSON.parse(
      await tool.execute(
        {
          session_id: setup.target,
          content: "Choose an option.",
          request: { kind: "wait", milestone: "done", timeout_seconds: 30 },
        },
        { sessionID: "bad", abort: signal() },
      ),
    );
    expect(invalidCaller).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  test("request-start publishes coherent operation and request details after native rejection", async () => {
    const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
    const tool = createSessionRequestStartTool(
      {
        readiness: { ...setup.ports.readiness, fencingToken: setup.token },
        membership: setup.ports.membership,
        starts: setup.store.starts,
        requests: setup.store,
        requestStarts: setup.store,
        scheduler: setup.ports.scheduler,
        nativeStart: {
          createRootSession: async () => "definitive_rejection",
          reconcileRootSession: async () => "matching",
          updateSessionTitle: async () => "updated",
          admitInitialMessage: async () => "admitted",
        },
        ownership: setup.store,
        clock: setup.ports.clock,
        ids: setup.ports.ids,
        digest: requestDigestPort,
        policy: createSessionStartPolicy({ decision: "allow" }),
      },
      {
        workspaceKey: requestTestWorkspace(),
        fencingToken: setup.token,
        invocationDeadlineMs: () => 90_000,
      },
      { ask: "allow", wait: "allow" },
    );

    const rejected = JSON.parse(
      await tool.execute(
        {
          idempotency_key: "coverage-rejection",
          initial_message: "Choose an option.",
          request: {
            kind: "ask",
            questions: [{ prompt: "Choose", options: ["one"] }],
            timeout_seconds: 30,
          },
        },
        { sessionID: setup.source, abort: signal() },
      ),
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        details: {
          operation: { creation_state: "failed" },
          request: { kind: "ask", delivery_mode: "initial" },
        },
      },
    });

    const invalidCaller = JSON.parse(
      await tool.execute(
        {
          idempotency_key: "invalid-caller",
          initial_message: "Wait for completion.",
          request: { kind: "wait", milestone: "done", timeout_seconds: 30 },
        },
        { sessionID: "bad", abort: signal() },
      ),
    );
    expect(invalidCaller).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });
});
