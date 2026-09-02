import type { ArtifactWriter } from "./artifacts";
import { classifyProcess } from "./classification";
import { eventSessionId, parseJsonl } from "./jsonl";
import { runEvaluationProcess } from "./process";
import { scoreScenario } from "./scorer";
import type { EvaluationClassification, ProcessCapture, ScenarioScore, ToolCall } from "./types";

const processDeadlineMs = 180_000;
const participantInitialMessage =
  "Do not process the attached durable request in this turn. Do not call tools. Wait for a later user follow-up.";
const workflowRequest = {
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
} as const;

interface AttemptContext {
  readonly cli: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly artifacts: ArtifactWriter;
  readonly artifactPrefix: string;
}

interface AttemptResult {
  readonly classification: EvaluationClassification;
  readonly scores: Readonly<Record<string, ScenarioScore>>;
}

interface RunResult {
  readonly capture: ProcessCapture;
  readonly score: ScenarioScore;
  readonly sourceSessionId?: string;
}

function completed(calls: readonly ToolCall[], name: string): ToolCall | undefined {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call?.name === name && call.status === "completed") return call;
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function nestedString(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) current = record(current)?.[key];
  return typeof current === "string" ? current : undefined;
}

function nestedNumber(value: unknown, path: readonly string[]): number | undefined {
  let current = value;
  for (const key of path) current = record(current)?.[key];
  return typeof current === "number" && Number.isSafeInteger(current) ? current : undefined;
}

function correlatedScore(score: ScenarioScore, errors: readonly string[]): ScenarioScore {
  const combined = [...score.errors, ...errors];
  return { ...score, passed: combined.length === 0, errors: combined };
}

function inputField(call: ToolCall | undefined, field: string): unknown {
  return record(call?.input)?.[field];
}

function lockCorrelation(score: ScenarioScore): ScenarioScore {
  const published = completed(score.tools, "session_lock_publish");
  const released = completed(score.tools, "session_lock_release");
  const lockID = nestedString(published?.output, ["value", "lock", "lock_id"]);
  const errors: string[] = [];
  if (lockID === undefined) errors.push("lock publish returned no lock_id");
  else if (inputField(released, "lock_id") !== lockID) {
    errors.push("lock release did not use the published lock_id");
  }
  return correlatedScore(score, errors);
}

export function requestStartCorrelation(score: ScenarioScore): {
  readonly score: ScenarioScore;
  readonly requestId?: string;
  readonly targetSessionId?: string;
} {
  const started = completed(score.tools, "session_request_start");
  const requestId = nestedString(started?.output, ["value", "request", "request_id"]);
  const targetSessionId = nestedString(started?.output, ["value", "operation", "session_id"]);
  const errors: string[] = [];
  if (requestId === undefined) errors.push("request start returned no request_id");
  if (targetSessionId === undefined) errors.push("request start returned no session_id");
  if (!hasExactRequestStartJourney(score, requestId, targetSessionId)) {
    errors.push("request start did not complete the exact correlated tool journey");
  }
  return {
    score: correlatedScore(score, errors),
    ...(requestId === undefined ? {} : { requestId }),
    ...(targetSessionId === undefined ? {} : { targetSessionId }),
  };
}

function participantCorrelation(
  score: ScenarioScore,
  requestId: string | undefined,
  sourceScore: ScenarioScore,
): ScenarioScore {
  const list = completed(score.tools, "session_request_list");
  const get = completed(score.tools, "session_request_get");
  const respond = completed(score.tools, "session_respond");
  const errors: string[] = [];
  if (inputField(list, "role") !== "inbox") {
    errors.push("participant did not explicitly list its inbox");
  }
  if (requestId !== undefined && inputField(get, "request_id") !== requestId) {
    errors.push("participant get did not use the durable request_id");
  }
  if (requestId !== undefined && inputField(respond, "request_id") !== requestId) {
    errors.push("participant response did not use the durable request_id");
  }
  if (JSON.stringify(inputField(respond, "answers")) !== JSON.stringify([["pass"]])) {
    errors.push("participant response did not preserve the required answer shape");
  }
  if (!hasExactParticipantJourney(score, requestId)) {
    errors.push("participant did not complete the exact correlated tool journey");
  }
  const correlated = correlatedScore(score, errors);
  if (correlated.passed || !isProactiveParticipantCompletion(score, sourceScore, requestId)) {
    return correlated;
  }
  return { ...score, passed: true, errors: [] };
}

function sourceCorrelation(score: ScenarioScore, requestId: string | undefined): ScenarioScore {
  const list = completed(score.tools, "session_request_list");
  const get = completed(score.tools, "session_request_get");
  const ack = completed(score.tools, "session_request_ack");
  const errors: string[] = [];
  if (inputField(list, "role") !== "outbox") {
    errors.push("source did not explicitly list its outbox");
  }
  if (requestId !== undefined && inputField(get, "request_id") !== requestId) {
    errors.push("source get did not use the durable request_id");
  }
  if (requestId !== undefined && inputField(ack, "request_id") !== requestId) {
    errors.push("source acknowledgement did not use the durable request_id");
  }
  if (!hasExpectedSourceResult(get, requestId)) {
    errors.push("source did not recover the required pass answer");
  }
  if (!hasExactSourceJourney(score, requestId)) {
    errors.push("source did not complete the exact correlated tool journey");
  }
  return correlatedScore(score, errors);
}

function hasExactCompletedTools(score: ScenarioScore, names: readonly string[]): boolean {
  return (
    score.tools.length === names.length &&
    score.tools.every((tool, index) => tool.name === names[index] && tool.status === "completed")
  );
}

function hasOnlyKeys(value: Record<string, unknown> | undefined, keys: readonly string[]): boolean {
  return (
    value !== undefined && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function hasExpectedWorkflowRequest(value: unknown): boolean {
  const request = record(value);
  const questions = request?.questions;
  if (
    request === undefined ||
    !hasOnlyKeys(request, ["kind", "timeout_seconds", "questions"]) ||
    request.kind !== "ask" ||
    request.timeout_seconds !== 120 ||
    !Array.isArray(questions) ||
    questions.length !== 1
  ) {
    return false;
  }
  const question = record(questions[0]);
  if (question === undefined) return false;
  return (
    hasOnlyKeys(question, ["prompt", "options", "multiple", "allow_custom"]) &&
    question.prompt === "Choose the evaluation result" &&
    JSON.stringify(question.options) === JSON.stringify(["pass", "fail"]) &&
    question.multiple === false &&
    question.allow_custom === false
  );
}

function hasExactRequestStartJourney(
  score: ScenarioScore,
  requestId: string | undefined,
  targetSessionId: string | undefined,
): boolean {
  if (
    requestId === undefined ||
    targetSessionId === undefined ||
    !hasExactCompletedTools(score, ["session_request_start"])
  ) {
    return false;
  }
  const started = score.tools[0];
  const operationId = nestedString(started?.output, ["value", "operation", "operation_id"]);
  const sourceSessionId = nestedString(started?.output, [
    "value",
    "operation",
    "source_session_id",
  ]);
  if (operationId === undefined || sourceSessionId === undefined) return false;
  return (
    inputField(started, "idempotency_key") === "eval-workflow-target" &&
    inputField(started, "title") === "Evaluation participant" &&
    inputField(started, "initial_message") === participantInitialMessage &&
    hasExpectedWorkflowRequest(inputField(started, "request")) &&
    nestedString(started?.output, ["value", "operation", "session_id"]) === targetSessionId &&
    nestedString(started?.output, ["value", "request", "request_id"]) === requestId &&
    nestedString(started?.output, ["value", "request", "kind"]) === "ask" &&
    nestedString(started?.output, ["value", "request", "role"]) === "source" &&
    nestedString(started?.output, ["value", "request", "linked_start_operation_id"]) ===
      operationId &&
    nestedString(started?.output, ["value", "request", "source_session_id"]) === sourceSessionId &&
    nestedString(started?.output, ["value", "request", "target_session_id"]) === targetSessionId
  );
}

function listContainsRequest(call: ToolCall | undefined, role: string, requestId: string): boolean {
  const items = record(record(call?.output)?.value)?.items;
  return (
    inputField(call, "role") === role &&
    record(call?.output)?.ok === true &&
    Array.isArray(items) &&
    items.some((item) => record(item)?.request_id === requestId)
  );
}

function hasExactParticipantJourney(score: ScenarioScore, requestId: string | undefined): boolean {
  if (
    requestId === undefined ||
    !hasExactCompletedTools(score, [
      "skill",
      "session_request_list",
      "session_request_get",
      "session_respond",
    ])
  ) {
    return false;
  }
  const [, list, get, respond] = score.tools;
  return (
    listContainsRequest(list, "inbox", requestId) &&
    inputField(get, "request_id") === requestId &&
    nestedString(get?.output, ["value", "outcome"]) === "pending_payload" &&
    nestedString(get?.output, ["value", "metadata", "request_id"]) === requestId &&
    hasExpectedWorkflowRequest(record(record(get?.output)?.value)?.payload) &&
    inputField(respond, "request_id") === requestId &&
    JSON.stringify(inputField(respond, "answers")) === JSON.stringify([["pass"]]) &&
    nestedString(respond?.output, ["value", "request_id"]) === requestId &&
    nestedString(respond?.output, ["value", "state"]) === "answered" &&
    nestedNumber(respond?.output, ["value", "answered_at_ms"]) !== undefined
  );
}

function hasExpectedSourceResult(
  get: ToolCall | undefined,
  requestId: string | undefined,
): boolean {
  return (
    requestId !== undefined &&
    inputField(get, "request_id") === requestId &&
    nestedString(get?.output, ["value", "outcome"]) === "available_result" &&
    nestedString(get?.output, ["value", "metadata", "request_id"]) === requestId &&
    nestedString(get?.output, ["value", "result", "kind"]) === "ask" &&
    JSON.stringify(record(record(get?.output)?.value)?.result) ===
      JSON.stringify({ kind: "ask", answers: [["pass"]] })
  );
}

function hasExactSourceJourney(score: ScenarioScore, requestId: string | undefined): boolean {
  if (
    requestId === undefined ||
    !hasExactCompletedTools(score, [
      "skill",
      "session_request_list",
      "session_request_get",
      "session_request_ack",
    ])
  ) {
    return false;
  }
  const [, list, get, ack] = score.tools;
  return (
    listContainsRequest(list, "outbox", requestId) &&
    hasExpectedSourceResult(get, requestId) &&
    inputField(ack, "request_id") === requestId &&
    nestedString(ack?.output, ["value", "request_id"]) === requestId &&
    nestedString(ack?.output, ["value", "state"]) === "acknowledged" &&
    nestedNumber(ack?.output, ["value", "acknowledged_at_ms"]) !== undefined
  );
}

function isProactiveParticipantCompletion(
  participantScore: ScenarioScore,
  sourceScore: ScenarioScore,
  requestId: string | undefined,
): boolean {
  const expectedIncompleteError =
    "missing ordered tools: skill, session_request_list, session_request_get, session_respond";
  if (
    !sourceScore.passed ||
    participantScore.errors.some((error) => error !== expectedIncompleteError) ||
    participantScore.tools.length !== 2
  ) {
    return false;
  }
  const [skill, list] = participantScore.tools;
  const items = record(record(list?.output)?.value)?.items;
  return (
    skill?.name === "skill" &&
    skill.status === "completed" &&
    inputField(skill, "name") === "session-request-participant" &&
    list?.name === "session_request_list" &&
    list.status === "completed" &&
    inputField(list, "role") === "inbox" &&
    Array.isArray(items) &&
    items.length === 0 &&
    hasExpectedSourceResult(completed(sourceScore.tools, "session_request_get"), requestId)
  );
}

export function correlateWorkflowScores(
  participantScore: ScenarioScore,
  sourceScore: ScenarioScore,
  requestId: string | undefined,
): { readonly participant: ScenarioScore; readonly source: ScenarioScore } {
  const source = sourceCorrelation(sourceScore, requestId);
  return {
    participant: participantCorrelation(participantScore, requestId, source),
    source,
  };
}

async function run(
  context: AttemptContext,
  name: string,
  prompt: string,
  requiredTools: readonly string[],
  requiredSkills: readonly string[] = [],
  sessionId?: string,
): Promise<RunResult> {
  const capture = await runEvaluationProcess({
    command: context.cli,
    arguments: [
      "run",
      "--agent",
      "build",
      "--format",
      "json",
      ...(sessionId === undefined ? [] : ["--session", sessionId]),
      prompt,
    ],
    cwd: context.cwd,
    environment: context.environment,
    deadlineMs: processDeadlineMs,
  });
  await context.artifacts.process(`${context.artifactPrefix}-${name}`, capture);
  const parsed = parseJsonl(capture.stdout);
  const sourceSessionId = eventSessionId(parsed.events);
  return {
    capture,
    score: scoreScenario(capture, requiredTools, requiredSkills),
    ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
  };
}

function transient(runResult: RunResult): EvaluationClassification | undefined {
  return classifyProcess(runResult.capture);
}

export async function runScenarios(context: AttemptContext): Promise<AttemptResult> {
  const scores: Record<string, ScenarioScore> = {};
  const execute = async (
    name: string,
    prompt: string,
    tools: readonly string[],
    skills: readonly string[] = [],
    sessionId?: string,
  ): Promise<RunResult> => {
    const result = await run(context, name, prompt, tools, skills, sessionId);
    scores[name] = result.score;
    return result;
  };

  const smoke = await execute(
    "smoke",
    "Your complete task is to call session_list exactly once. After its result, reply EVAL_SMOKE_COMPLETE. The only permitted tool is session_list.",
    ["session_list"],
  );
  const smokeFailure = transient(smoke);
  if (smokeFailure !== undefined) return { classification: smokeFailure, scores };

  const communication = await execute(
    "communication",
    "Perform exactly these steps in order: first load the session-communication skill; second call session_list exactly once; third reply EVAL_COMMUNICATION_COMPLETE. Do not invoke any other tool.",
    ["skill", "session_list"],
    ["session-communication"],
  );
  const communicationFailure = transient(communication);
  if (communicationFailure !== undefined) return { classification: communicationFailure, scores };

  const managed = await execute(
    "managed-session",
    "Call session_start exactly once with idempotency_key eval-communication, title Eval child, and initial_message Reply briefly without tools. After its result, reply EVAL_MANAGED_COMPLETE. The only permitted tool is session_start.",
    ["session_start"],
  );
  const managedFailure = transient(managed);
  if (managedFailure !== undefined) return { classification: managedFailure, scores };

  const locks = await execute(
    "locks",
    "Perform exactly these steps in order: load the session-locks skill; call session_lock_list; publish one lock titled Model evaluation, description Read-only protocol evaluation, instructions No workspace mutation, ttl_seconds 120; use its returned lock_id to release it; reply EVAL_LOCKS_COMPLETE. Invoke no other tools.",
    ["skill", "session_lock_list", "session_lock_publish", "session_lock_release"],
    ["session-locks"],
  );
  scores.locks = lockCorrelation(locks.score);
  const lockFailure = transient(locks);
  if (lockFailure !== undefined) return { classification: lockFailure, scores };

  const create = await execute(
    "workflow-create",
    `Call session_request_start exactly once with idempotency_key eval-workflow-target, title Evaluation participant, and initial_message ${JSON.stringify(participantInitialMessage)}. The request argument must be a nested JSON object, never a string or escaped JSON: ${JSON.stringify(workflowRequest)}. After its result, reply EVAL_TARGET_CREATED. The only permitted tool is session_request_start.`,
    ["session_request_start"],
  );
  const createFailure = transient(create);
  if (createFailure !== undefined) return { classification: createFailure, scores };
  const started = requestStartCorrelation(create.score);
  scores["workflow-create"] = started.score;
  const targetSessionId = started.targetSessionId;
  const sourceSessionId = create.sourceSessionId;
  if (targetSessionId === undefined || sourceSessionId === undefined) {
    return { classification: "behavior_failed", scores };
  }

  const participant = await execute(
    "workflow-participant",
    'Perform exactly these steps in order: load the session-request-participant skill; call session_request_list with role "inbox"; use the listed request_id with session_request_get; use that same request_id with session_respond and answers [["pass"]]; reply EVAL_PARTICIPANT_COMPLETE. Invoke no other tools.',
    ["skill", "session_request_list", "session_request_get", "session_respond"],
    ["session-request-participant"],
    targetSessionId,
  );
  const participantFailure = transient(participant);
  if (participantFailure !== undefined) return { classification: participantFailure, scores };

  const recover = await execute(
    "workflow-source-recover",
    'Perform exactly these steps in order: load the session-communication skill; call session_request_list with role "outbox"; use the listed request_id with session_request_get; use that same request_id with session_request_ack; reply EVAL_SOURCE_COMPLETE. Invoke no other tools.',
    ["skill", "session_request_list", "session_request_get", "session_request_ack"],
    ["session-communication"],
    sourceSessionId,
  );
  const recoverFailure = transient(recover);
  if (recoverFailure !== undefined) return { classification: recoverFailure, scores };
  const workflow = correlateWorkflowScores(participant.score, recover.score, started.requestId);
  scores["workflow-participant"] = workflow.participant;
  scores["workflow-source-recover"] = workflow.source;

  return {
    classification: Object.values(scores).every((score) => score.passed)
      ? "passed"
      : "behavior_failed",
    scores,
  };
}
