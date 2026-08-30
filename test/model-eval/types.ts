export const evaluationClassifications = [
  "passed",
  "behavior_failed",
  "provider_unavailable",
  "rate_limited",
  "model_removed",
  "harness_failed",
] as const;

export type EvaluationClassification = (typeof evaluationClassifications)[number];

export interface ProcessCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ToolCall {
  readonly name: string;
  readonly status: string;
  readonly input: unknown;
  readonly output: unknown;
}

export interface ScenarioScore {
  readonly passed: boolean;
  readonly errors: readonly string[];
  readonly tools: readonly ToolCall[];
}

export interface EvaluationResult {
  readonly classification: EvaluationClassification;
  readonly selectedModel?: string;
  readonly attempts: number;
  readonly scenarios: Readonly<Record<string, ScenarioScore>>;
  readonly message: string;
}
