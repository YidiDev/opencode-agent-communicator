import { expect, test } from "bun:test";

import { correlateWorkflowScores, requestStartCorrelation } from "../../model-eval/scenarios";
import type { ScenarioScore, ToolCall } from "../../model-eval/types";

const requestId = "req_0123456789abcdef0123456789abcdef";
const operationId = "op_0123456789abcdef0123456789abcdef";
const sourceSessionId = "ses_source";
const targetSessionId = "ses_target";
const request = {
  kind: "ask",
  timeout_seconds: 120,
  questions: [
    {
      prompt: "Choose the evaluation result",
      options: ["pass", "fail"],
      multiple: false,
      allow_custom: false,
    },
  ],
};

function call(name: string, input: unknown, output: unknown): ToolCall {
  return { name, status: "completed", input, output };
}

function sourceScore(answers: readonly (readonly string[])[] = [["pass"]]): ScenarioScore {
  return {
    passed: true,
    errors: [],
    tools: [
      call("skill", { name: "session-communication" }, "loaded session-communication"),
      call(
        "session_request_list",
        { role: "outbox" },
        { ok: true, value: { items: [{ request_id: requestId }] } },
      ),
      call(
        "session_request_get",
        { request_id: requestId },
        {
          ok: true,
          value: {
            outcome: "available_result",
            metadata: { request_id: requestId },
            result: { kind: "ask", answers },
          },
        },
      ),
      call(
        "session_request_ack",
        { request_id: requestId },
        {
          ok: true,
          value: { request_id: requestId, state: "acknowledged", acknowledged_at_ms: 1 },
        },
      ),
    ],
  };
}

function normalParticipant(): ScenarioScore {
  return {
    passed: true,
    errors: [],
    tools: [
      call("skill", { name: "session-request-participant" }, "loaded session-request-participant"),
      call(
        "session_request_list",
        { role: "inbox" },
        { ok: true, value: { items: [{ request_id: requestId }] } },
      ),
      call(
        "session_request_get",
        { request_id: requestId },
        {
          ok: true,
          value: {
            outcome: "pending_payload",
            metadata: { request_id: requestId },
            payload: request,
          },
        },
      ),
      call(
        "session_respond",
        { request_id: requestId, answers: [["pass"]] },
        {
          ok: true,
          value: { request_id: requestId, state: "answered", answered_at_ms: 1 },
        },
      ),
    ],
  };
}

function startScore(inputRequest: unknown = request): ScenarioScore {
  return {
    passed: true,
    errors: [],
    tools: [
      call(
        "session_request_start",
        {
          idempotency_key: "eval-workflow-target",
          title: "Evaluation participant",
          initial_message:
            "Do not process the attached durable request in this turn. Do not call tools. Wait for a later user follow-up.",
          request: inputRequest,
        },
        {
          ok: true,
          value: {
            operation: {
              operation_id: operationId,
              source_session_id: sourceSessionId,
              session_id: targetSessionId,
            },
            request: {
              request_id: requestId,
              kind: "ask",
              role: "source",
              linked_start_operation_id: operationId,
              source_session_id: sourceSessionId,
              target_session_id: targetSessionId,
            },
          },
        },
      ),
    ],
  };
}

function proactiveParticipant(tools?: readonly ToolCall[]): ScenarioScore {
  return {
    passed: false,
    errors: [
      "missing ordered tools: skill, session_request_list, session_request_get, session_respond",
    ],
    tools: tools ?? [
      call("skill", { name: "session-request-participant" }, "loaded session-request-participant"),
      call("session_request_list", { role: "inbox" }, { ok: true, value: { items: [] } }),
    ],
  };
}

test("accepts a clean proactive participant completion proven by source recovery", () => {
  const result = correlateWorkflowScores(proactiveParticipant(), sourceScore(), requestId);

  expect(result.participant).toMatchObject({ passed: true, errors: [] });
  expect(result.source).toMatchObject({ passed: true, errors: [] });
});

test("accepts the exact scripted participant and source journeys", () => {
  const result = correlateWorkflowScores(normalParticipant(), sourceScore(), requestId);

  expect(result.participant).toMatchObject({ passed: true, errors: [] });
  expect(result.source).toMatchObject({ passed: true, errors: [] });
});

test("accepts the exact request-start journey", () => {
  expect(requestStartCorrelation(startScore()).score).toMatchObject({ passed: true, errors: [] });
});

test("rejects proactive completion without the required recovered answer", () => {
  const result = correlateWorkflowScores(
    proactiveParticipant(),
    sourceScore([["fail"]]),
    requestId,
  );

  expect(result.participant.passed).toBe(false);
  expect(result.source.errors).toContain("source did not recover the required pass answer");
});

test("rejects a malformed participant payload", () => {
  const participant = normalParticipant();
  const malformed = {
    ...participant,
    tools: participant.tools.map((tool) =>
      tool.name === "session_request_get"
        ? call(
            "session_request_get",
            { request_id: requestId },
            {
              ok: true,
              value: { outcome: "pending_payload", metadata: { request_id: requestId } },
            },
          )
        : tool,
    ),
  };
  const result = correlateWorkflowScores(malformed, sourceScore(), requestId);

  expect(result.participant.errors).toContain(
    "participant did not complete the exact correlated tool journey",
  );
});

test("rejects malformed or extra request-start activity", () => {
  const malformed = requestStartCorrelation(startScore({ ...request, timeout_seconds: 121 })).score;
  const base = startScore();
  const extra = requestStartCorrelation({
    ...base,
    tools: [
      ...base.tools,
      call("session_request_list", { role: "outbox" }, { ok: true, value: { items: [] } }),
    ],
  }).score;

  expect(malformed.errors).toContain(
    "request start did not complete the exact correlated tool journey",
  );
  expect(extra.errors).toContain(
    "request start did not complete the exact correlated tool journey",
  );
});

test("rejects request-start output without operation correlation identifiers", () => {
  const base = startScore();
  const started = base.tools[0];
  if (started === undefined) throw new Error("start fixture has no tool call");
  const malformed = requestStartCorrelation({
    ...base,
    tools: [
      call(started.name, started.input, {
        ok: true,
        value: {
          operation: { source_session_id: sourceSessionId, session_id: targetSessionId },
          request: {
            request_id: requestId,
            kind: "ask",
            role: "source",
            source_session_id: sourceSessionId,
            target_session_id: targetSessionId,
          },
        },
      }),
    ],
  }).score;

  expect(malformed.errors).toContain(
    "request start did not complete the exact correlated tool journey",
  );
});

test("rejects extra participant tools in the proactive path", () => {
  const participant = proactiveParticipant([
    ...proactiveParticipant().tools,
    call("session_request_list", { role: "outbox" }, { ok: true, value: { items: [] } }),
  ]);
  const result = correlateWorkflowScores(participant, sourceScore(), requestId);

  expect(result.participant.passed).toBe(false);
});

test("rejects extra tools in the normal participant and source journeys", () => {
  const participant = {
    ...normalParticipant(),
    tools: [
      ...normalParticipant().tools,
      call("session_request_list", { role: "inbox" }, { ok: true, value: { items: [] } }),
    ],
  };
  const source = {
    ...sourceScore(),
    tools: [
      ...sourceScore().tools,
      call("session_request_list", { role: "outbox" }, { ok: true, value: { items: [] } }),
    ],
  };
  const result = correlateWorkflowScores(participant, source, requestId);

  expect(result.participant.errors).toContain(
    "participant did not complete the exact correlated tool journey",
  );
  expect(result.source.errors).toContain(
    "source did not complete the exact correlated tool journey",
  );
});

test("rejects a malformed acknowledgement result", () => {
  const source = sourceScore();
  const malformed = {
    ...source,
    tools: source.tools.map((tool) =>
      tool.name === "session_request_ack"
        ? call(
            "session_request_ack",
            { request_id: requestId },
            { ok: true, value: { request_id: requestId, state: "acknowledged" } },
          )
        : tool,
    ),
  };
  const result = correlateWorkflowScores(normalParticipant(), malformed, requestId);

  expect(result.source.errors).toContain(
    "source did not complete the exact correlated tool journey",
  );
});
