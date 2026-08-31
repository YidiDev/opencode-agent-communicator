import type { ArtifactWriter } from "./artifacts";
import { classifyProcess } from "./classification";
import { eventSessionId, outputField, parseJsonl } from "./jsonl";
import { runEvaluationProcess } from "./process";
import { scoreScenario } from "./scorer";
import type { EvaluationClassification, ProcessCapture, ScenarioScore, ToolCall } from "./types";

const processDeadlineMs = 180_000;

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

function sendCorrelation(
  score: ScenarioScore,
  targetSessionId: string,
): { readonly score: ScenarioScore; readonly requestId?: string } {
  const sent = completed(score.tools, "session_request_send");
  const requestId = nestedString(sent?.output, ["value", "request_id"]);
  const errors: string[] = [];
  if (requestId === undefined) errors.push("request send returned no request_id");
  if (inputField(sent, "session_id") !== targetSessionId) {
    errors.push("request send did not target the created participant");
  }
  return {
    score: correlatedScore(score, errors),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function participantCorrelation(
  score: ScenarioScore,
  requestId: string | undefined,
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
  return correlatedScore(score, errors);
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
  return correlatedScore(score, errors);
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
    "Call session_start exactly once with idempotency_key eval-workflow-target, title Evaluation participant, and initial_message Wait for a durable request and do not call tools yet. After its result, reply EVAL_TARGET_CREATED. The only permitted tool is session_start.",
    ["session_start"],
  );
  const createFailure = transient(create);
  if (createFailure !== undefined) return { classification: createFailure, scores };
  const start = completed(create.score.tools, "session_start");
  const targetSessionId = start === undefined ? undefined : outputField(start, "session_id");
  const sourceSessionId = create.sourceSessionId;
  if (targetSessionId === undefined || sourceSessionId === undefined) {
    return { classification: "behavior_failed", scores };
  }

  const send = await execute(
    "workflow-send",
    `Call session_request_send exactly once for session_id ${targetSessionId}. Set content to Answer the evaluation choice safely. The request argument must be a nested JSON object, never a string or escaped JSON: {"kind":"ask","timeout_seconds":120,"questions":[{"prompt":"Choose the evaluation result","options":["pass","fail"],"multiple":false,"allow_custom":false}]}. After its result, reply EVAL_REQUEST_SENT. Do not call other tools.`,
    ["session_request_send"],
    [],
    sourceSessionId,
  );
  const sendFailure = transient(send);
  if (sendFailure !== undefined) return { classification: sendFailure, scores };
  const sent = sendCorrelation(send.score, targetSessionId);
  scores["workflow-send"] = sent.score;

  const participant = await execute(
    "workflow-participant",
    'Perform exactly these steps in order: load the session-request-participant skill; call session_request_list with role "inbox"; use the listed request_id with session_request_get; use that same request_id with session_respond and answers [["pass"]]; reply EVAL_PARTICIPANT_COMPLETE. Invoke no other tools.',
    ["skill", "session_request_list", "session_request_get", "session_respond"],
    ["session-request-participant"],
    targetSessionId,
  );
  const participantFailure = transient(participant);
  if (participantFailure !== undefined) return { classification: participantFailure, scores };
  scores["workflow-participant"] = participantCorrelation(participant.score, sent.requestId);

  const recover = await execute(
    "workflow-source-recover",
    'Perform exactly these steps in order: load the session-communication skill; call session_request_list with role "outbox"; use the listed request_id with session_request_get; use that same request_id with session_request_ack; reply EVAL_SOURCE_COMPLETE. Invoke no other tools.',
    ["skill", "session_request_list", "session_request_get", "session_request_ack"],
    ["session-communication"],
    sourceSessionId,
  );
  const recoverFailure = transient(recover);
  if (recoverFailure !== undefined) return { classification: recoverFailure, scores };
  scores["workflow-source-recover"] = sourceCorrelation(recover.score, sent.requestId);

  return {
    classification: Object.values(scores).every((score) => score.passed)
      ? "passed"
      : "behavior_failed",
    scores,
  };
}
