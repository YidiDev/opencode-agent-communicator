import { requestLimits } from "./request-constants";
import type {
  AskQuestion,
  AskRequestPayload,
  AskRequestResult,
  PendingRequestPayload,
  RetainedRequestResult,
  WaitRequestPayload,
  WaitRequestResult,
} from "./request-types";
import {
  canonicalBytes,
  isExactRecord,
  type RequestValidation,
  snapshotArray,
  validBoundedText,
  validOptionalText,
  withinCanonicalLimit,
} from "./request-validation";

function invalid<Value>(message: string): RequestValidation<Value> {
  return { ok: false, message };
}

function valid<Value>(value: Value): RequestValidation<Value> {
  const bytes = canonicalBytes(value);
  return withinCanonicalLimit(bytes)
    ? { ok: true, value, bytes, byteLength: bytes.length }
    : invalid(`canonical JSON must not exceed ${requestLimits.canonicalContentBytes} UTF-8 bytes.`);
}

function timeoutIsValid(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= requestLimits.minimumTimeoutSeconds &&
    value <= requestLimits.maximumTimeoutSeconds
  );
}

function includesExact(values: readonly string[], candidate: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === candidate) return true;
  }
  return false;
}

function hasDuplicate(values: readonly string[]): boolean {
  for (let index = 0; index < values.length; index += 1) {
    for (let previous = 0; previous < index; previous += 1) {
      if (values[index] === values[previous]) return true;
    }
  }
  return false;
}

export function validateAskQuestion(value: unknown): RequestValidation<AskQuestion> {
  if (!isExactRecord(value, ["prompt", "options"], ["multiple", "allowCustom"])) {
    return invalid("question must contain only prompt, options, multiple, and allowCustom.");
  }
  const prompt = value.prompt;
  const optionsInput = snapshotArray(value.options, requestLimits.maximumOptionsPerQuestion);
  const multiple = value.multiple ?? false;
  const allowCustom = value.allowCustom ?? false;
  if (!validBoundedText(prompt, requestLimits.promptBytes)) {
    return invalid("prompt must be non-empty, safe text within the UTF-8 byte limit.");
  }
  if (!optionsInput) {
    return invalid(
      `options must contain at most ${requestLimits.maximumOptionsPerQuestion} labels.`,
    );
  }
  if (typeof multiple !== "boolean" || typeof allowCustom !== "boolean") {
    return invalid("multiple and allowCustom must be booleans.");
  }
  if (optionsInput.length === 0 && !allowCustom) {
    return invalid("a question without options must allow custom answers.");
  }
  const options: string[] = [];
  for (let index = 0; index < optionsInput.length; index += 1) {
    const option = optionsInput[index];
    if (!validBoundedText(option, requestLimits.optionBytes)) {
      return invalid("option labels must be non-empty, safe text within the UTF-8 byte limit.");
    }
    options.push(option);
  }
  if (hasDuplicate(options)) {
    return invalid("option labels must be unique exact strings.");
  }
  return valid({ prompt, options, multiple, allowCustom });
}

export function validateAskRequestPayload(value: unknown): RequestValidation<AskRequestPayload> {
  if (!isExactRecord(value, ["kind", "questions", "timeoutSeconds"]) || value.kind !== "ask") {
    return invalid("ask payload has an invalid shape.");
  }
  const questionsInput = snapshotArray(value.questions, requestLimits.maximumQuestions);
  const timeoutSeconds = value.timeoutSeconds;
  if (!questionsInput || questionsInput.length < requestLimits.minimumQuestions) {
    return invalid(
      `questions must contain ${requestLimits.minimumQuestions}..${requestLimits.maximumQuestions} items.`,
    );
  }
  if (!timeoutIsValid(timeoutSeconds)) {
    return invalid(
      `timeoutSeconds must be an integer from ${requestLimits.minimumTimeoutSeconds} through ${requestLimits.maximumTimeoutSeconds}.`,
    );
  }
  const questions: AskQuestion[] = [];
  for (let index = 0; index < questionsInput.length; index += 1) {
    const candidate = questionsInput[index];
    const question = validateAskQuestion(candidate);
    if (!question.ok) return invalid(question.message);
    questions.push(question.value);
  }
  return valid({ kind: "ask", questions, timeoutSeconds });
}

export function validateWaitRequestPayload(value: unknown): RequestValidation<WaitRequestPayload> {
  if (!isExactRecord(value, ["kind", "milestone", "timeoutSeconds"]) || value.kind !== "wait") {
    return invalid("wait payload has an invalid shape.");
  }
  const milestone = value.milestone;
  const timeoutSeconds = value.timeoutSeconds;
  if (!validBoundedText(milestone, requestLimits.milestoneBytes)) {
    return invalid("milestone must be non-empty, safe text within the UTF-8 byte limit.");
  }
  if (!timeoutIsValid(timeoutSeconds)) {
    return invalid(
      `timeoutSeconds must be an integer from ${requestLimits.minimumTimeoutSeconds} through ${requestLimits.maximumTimeoutSeconds}.`,
    );
  }
  return valid({ kind: "wait", milestone, timeoutSeconds });
}

export function validatePendingRequestPayload(
  value: unknown,
): RequestValidation<PendingRequestPayload> {
  if (!isExactRecord(value, ["kind"], ["questions", "milestone", "timeoutSeconds"])) {
    return invalid("pending request payload has an invalid shape.");
  }
  const kind = value.kind;
  if (kind === "ask") return validateAskRequestPayload(value);
  if (kind === "wait") return validateWaitRequestPayload(value);
  return invalid("request kind must be ask or wait.");
}

function validateAnswerArrays(value: unknown): RequestValidation<AskRequestResult> {
  if (!isExactRecord(value, ["kind", "answers"]) || value.kind !== "ask") {
    return invalid("ask result has an invalid shape.");
  }
  const input = snapshotArray(value.answers, requestLimits.maximumQuestions);
  if (!input || input.length < requestLimits.minimumQuestions) {
    return invalid("answers must contain 1..10 question arrays.");
  }
  const answers: string[][] = [];
  for (let outerIndex = 0; outerIndex < input.length; outerIndex += 1) {
    const candidate = snapshotArray(input[outerIndex], requestLimits.maximumAnswersPerQuestion);
    if (!candidate) {
      return invalid("each answer array must contain 0..20 bounded safe strings.");
    }
    const answerSnapshot: string[] = [];
    for (let innerIndex = 0; innerIndex < candidate.length; innerIndex += 1) {
      const answer = candidate[innerIndex];
      if (!validBoundedText(answer, requestLimits.customAnswerBytes)) {
        return invalid("each answer array must contain 0..20 bounded safe strings.");
      }
      answerSnapshot.push(answer);
    }
    if (hasDuplicate(answerSnapshot)) {
      return invalid("selected answers must be unique.");
    }
    answers.push(answerSnapshot);
  }
  return valid({ kind: "ask", answers });
}

function answerMatchesQuestion(answer: string, question: AskQuestion): boolean {
  return includesExact(question.options, answer) || question.allowCustom;
}

export function validateAskResponseAgainstPendingPayload(
  value: unknown,
  authoritativePayload: unknown,
): RequestValidation<AskRequestResult> {
  const payload = validateAskRequestPayload(authoritativePayload);
  if (!payload.ok) return invalid(`authoritative ask payload is invalid: ${payload.message}`);
  const result = validateAnswerArrays(value);
  if (!result.ok) return result;
  if (result.value.answers.length !== payload.value.questions.length) {
    return invalid("answers must contain one array per question.");
  }
  for (let index = 0; index < result.value.answers.length; index += 1) {
    const answers = result.value.answers[index];
    const question = payload.value.questions[index];
    if (!question || !answers) return invalid("authoritative question is absent.");
    const maximum = question.multiple ? requestLimits.maximumAnswersPerQuestion : 1;
    if (answers.length > maximum) return invalid(`answer cardinality must be 0..${maximum}.`);
    for (let answerIndex = 0; answerIndex < answers.length; answerIndex += 1) {
      const answer = answers[answerIndex];
      if (answer === undefined || !answerMatchesQuestion(answer, question)) {
        return invalid("an answer is neither an exact option nor permitted custom text.");
      }
    }
  }
  return result;
}

export const validateAskRequestResult = validateAskResponseAgainstPendingPayload;
export const validateRetainedAskRequestResult = validateAnswerArrays;

export function validateWaitRequestResult(value: unknown): RequestValidation<WaitRequestResult> {
  if (!isExactRecord(value, ["kind"], ["evidence"]) || value.kind !== "wait") {
    return invalid("wait result has an invalid shape.");
  }
  const evidence = value.evidence;
  if (evidence !== undefined && !validOptionalText(evidence, requestLimits.evidenceBytes)) {
    return invalid("evidence must be safe text within the UTF-8 byte limit when present.");
  }
  return evidence === undefined ? valid({ kind: "wait" }) : valid({ kind: "wait", evidence });
}

export function validateRetainedRequestResult(
  value: unknown,
): RequestValidation<RetainedRequestResult> {
  if (!isExactRecord(value, ["kind"], ["answers", "evidence"])) {
    return invalid("retained request result has an invalid shape.");
  }
  if (value.kind === "ask") return validateAnswerArrays(value);
  if (value.kind === "wait") return validateWaitRequestResult(value);
  return invalid("retained result kind must be ask or wait.");
}
