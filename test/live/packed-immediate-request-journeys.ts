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

interface ImmediateJourneyFixture {
  createSession(title: string, label: string): Promise<string>;
  messages(
    sessionID: string,
    label: string,
  ): Promise<readonly { readonly parts: readonly unknown[] }[]>;
}

function toolPart(messages: readonly { readonly parts: readonly unknown[] }[], id: string) {
  return messages
    .flatMap((message) => message.parts)
    .reverse()
    .find(
      (value): value is { tool: string; state: { status: string; output?: string } } =>
        typeof value === "object" && value !== null && Reflect.get(value, "tool") === id,
    );
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

async function waitForCompletedTool(
  fixture: ImmediateJourneyFixture,
  sessionID: string,
  toolID: string,
  label: string,
): Promise<Record<string, unknown>> {
  const deadline = performance.now() + liveDeadlineMs;
  while (performance.now() < deadline) {
    const part = toolPart(await fixture.messages(sessionID, `${label} messages`), toolID);
    if (part?.state.status === "completed" && typeof part.state.output === "string") {
      return JSON.parse(part.state.output) as Record<string, unknown>;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`${label} did not complete ${toolID}`);
}

async function waitForTranscript(
  fixture: ImmediateJourneyFixture,
  sessionID: string,
  text: string,
): Promise<void> {
  const deadline = performance.now() + liveDeadlineMs;
  while (performance.now() < deadline) {
    if (JSON.stringify(await fixture.messages(sessionID, "target transcript")).includes(text))
      return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`target transcript did not contain ${JSON.stringify(text)}`);
}

function requiredNestedString(value: unknown, path: readonly string[], label: string): string {
  let current = value;
  for (const key of path) current = Reflect.get((current as object) ?? {}, key);
  if (typeof current !== "string") throw new Error(`${label} returned no ${path.join(".")}`);
  return current;
}

export async function runImmediateRequestJourneys(
  fixture: ImmediateJourneyFixture,
  invoker: Invoker,
): Promise<void> {
  const askTarget = await fixture.createSession(
    "Packed request-send target",
    "request-send target",
  );
  const sent = await invoker.begin(
    "session_request_send",
    `production-session-request-send-ask:${askTarget}`,
  );
  const sentOutput = await withinLiveDeadline(sent.output(), "request-send completion");
  expect(sentOutput).toMatchObject({
    ok: true,
    value: {
      role: "source",
      kind: "ask",
      delivery_mode: "queue",
      source_session_id: sent.sessionID,
      target_session_id: askTarget,
    },
  });
  const sentRequestID = requiredNestedString(sentOutput, ["value", "request_id"], "request-send");
  expect(
    await waitForCompletedTool(fixture, askTarget, "session_respond", "request-send target"),
  ).toMatchObject({ ok: true, value: { request_id: sentRequestID, state: "answered" } });
  expect(
    await invoker.invoke(
      "session_request_get",
      `production-request-get:${sentRequestID}`,
      sent.sessionID,
    ),
  ).toMatchObject({
    ok: true,
    value: {
      outcome: "available_result",
      metadata: { request_id: sentRequestID, delivery_mode: "queue", result_state: "available" },
      result: { kind: "ask", answers: [["yes"]] },
    },
  });
  expect(
    await invoker.invoke(
      "session_request_ack",
      `production-request-ack:${sentRequestID}`,
      sent.sessionID,
    ),
  ).toMatchObject({ ok: true, value: { request_id: sentRequestID, state: "acknowledged" } });

  const cancelTarget = await fixture.createSession(
    "Packed request cancellation target",
    "request cancellation target",
  );
  const pending = await invoker.begin(
    "session_request_send",
    `production-session-request-send-cancel:${cancelTarget}`,
  );
  const pendingOutput = await withinLiveDeadline(
    pending.output(),
    "pending request-send completion",
  );
  expect(pendingOutput).toMatchObject({
    ok: true,
    value: { delivery_mode: "queue", resolution_state: "pending" },
  });
  const pendingRequestID = requiredNestedString(
    pendingOutput,
    ["value", "request_id"],
    "pending request-send",
  );
  await waitForTranscript(fixture, cancelTarget, "diagnostic complete");
  expect(
    await invoker.invoke(
      "session_request_cancel",
      `production-request-cancel:${pendingRequestID}`,
      pending.sessionID,
    ),
  ).toMatchObject({ ok: true, value: { request_id: pendingRequestID, state: "cancelled" } });

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
  expect(
    await invoker.invoke("session_signal", "production-process-wait-request", startedSessionID),
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
