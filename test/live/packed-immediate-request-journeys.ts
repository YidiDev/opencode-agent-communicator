import { expect } from "bun:test";

import { liveDeadlineMs } from "./harness/constants";

interface Invocation {
  readonly sessionID: string;
  output(): Promise<Record<string, unknown>>;
}

interface Invoker {
  begin(id: string, marker: string, existingSessionID?: string): Promise<Invocation>;
  invoke(id: string, marker: string, existingSessionID?: string): Promise<Record<string, unknown>>;
}

interface InitialRequestFixture {
  waitForIdle(sessionID: string): Promise<void>;
}

async function withinLiveDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), liveDeadlineMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requiredNestedString(value: unknown, path: readonly string[], label: string): string {
  let current = value;
  for (const key of path) current = Reflect.get((current as object) ?? {}, key);
  if (typeof current !== "string") throw new Error(`${label} returned no ${path.join(".")}`);
  return current;
}

export async function runImmediateRequestJourneys(
  fixture: InitialRequestFixture,
  invoker: Invoker,
): Promise<void> {
  const started = await invoker.begin(
    "session_request_start",
    "production-session-request-start-wait",
  );
  const startedOutput = await withinLiveDeadline(started.output(), "request-start completion");
  expect(startedOutput).toMatchObject({
    ok: true,
    value: {
      operation: {
        source_session_id: started.sessionID,
        idempotency_key: "packed-live-request-start",
        creation_state: "created",
        admission_state: "admitted",
      },
      request: {
        role: "source",
        kind: "wait",
        delivery_mode: "initial",
        source_session_id: started.sessionID,
      },
    },
  });
  const operationID = requiredNestedString(
    startedOutput,
    ["value", "operation", "operation_id"],
    "request-start",
  );
  const startedSessionID = requiredNestedString(
    startedOutput,
    ["value", "operation", "session_id"],
    "request-start",
  );
  const startedRequestID = requiredNestedString(
    startedOutput,
    ["value", "request", "request_id"],
    "request-start",
  );
  expect(Reflect.get(Reflect.get(startedOutput, "value") as object, "request")).toMatchObject({
    linked_start_operation_id: operationID,
    target_session_id: startedSessionID,
  });
  await fixture.waitForIdle(startedSessionID);
  expect(
    await withinLiveDeadline(
      invoker.invoke("session_signal", "production-process-wait-request", startedSessionID),
      "request-start signal completion",
    ),
  ).toMatchObject({ ok: true, value: { request_id: startedRequestID, state: "reached" } });
  expect(
    await invoker.invoke(
      "session_request_get",
      `production-request-get:${startedRequestID}`,
      started.sessionID,
    ),
  ).toMatchObject({
    ok: true,
    value: {
      outcome: "available_result",
      metadata: {
        request_id: startedRequestID,
        linked_start_operation_id: operationID,
        delivery_mode: "initial",
      },
      result: { kind: "wait", evidence: "artifact://packed-live" },
    },
  });
  expect(
    await invoker.invoke(
      "session_request_ack",
      `production-request-ack:${startedRequestID}`,
      started.sessionID,
    ),
  ).toMatchObject({ ok: true, value: { request_id: startedRequestID, state: "acknowledged" } });
}
