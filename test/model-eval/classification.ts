import type { EvaluationClassification, ProcessCapture, ScenarioScore } from "./types";

const ratePattern =
  /\bhttp(?:\s+status)?\s*429\b|\bstatus(?:\s+code)?["':=\s]+429\b|rate[ _-]?limit|too many requests|quota exceeded/i;
const unavailablePattern =
  /\bhttp(?:\s+status)?\s*(?:408|425|500|502|503|504)\b|\bstatus(?:\s+code)?["':=\s]+(?:408|425|500|502|503|504)\b|timed? out|econnreset|enotfound|network error|provider unavailable|process timed out/i;
const removedPattern =
  /model (?:not found|does not exist|removed)|unknown model|invalid model|\b404\b[^\n]*model/i;

export function classifyProcess(process: ProcessCapture): EvaluationClassification | undefined {
  const diagnostic = `${process.stderr}\n${process.stdout}`;
  if (ratePattern.test(diagnostic)) return "rate_limited";
  if (removedPattern.test(diagnostic)) return "model_removed";
  if (unavailablePattern.test(diagnostic)) return "provider_unavailable";
  return undefined;
}

export function classifyScores(
  scores: Readonly<Record<string, ScenarioScore>>,
): EvaluationClassification {
  return Object.values(scores).every((score) => score.passed) ? "passed" : "behavior_failed";
}

export function isTransient(classification: EvaluationClassification): boolean {
  return classification === "provider_unavailable" || classification === "rate_limited";
}
