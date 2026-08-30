import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { EvaluationResult, ProcessCapture } from "./types";

function sanitize(text: string): string {
  return text
    .replace(
      /(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)(["'=:\s]+)[^\s,"'}]+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/bearer\s+[a-z0-9._~+/-]+/gi, "Bearer [REDACTED]");
}

export class ArtifactWriter {
  readonly root: string;

  constructor(path = process.env.MODEL_EVAL_ARTIFACT_DIR ?? "model-eval-artifacts") {
    this.root = resolve(path);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }

  async text(name: string, value: string): Promise<void> {
    const path = resolve(this.root, name);
    await writeFile(path, sanitize(value), { mode: 0o600 });
    await chmod(path, 0o600);
  }

  async json(name: string, value: unknown): Promise<void> {
    await this.text(name, `${JSON.stringify(value, undefined, 2)}\n`);
  }

  async process(name: string, capture: ProcessCapture): Promise<void> {
    await Promise.all([
      this.text(`${name}.stdout.jsonl`, capture.stdout),
      this.text(`${name}.stderr.log`, capture.stderr),
    ]);
  }

  async result(result: EvaluationResult): Promise<void> {
    await this.json("result.json", result);
    const rows = Object.entries(result.scenarios).map(
      ([name, score]) =>
        `| ${name} | ${score.passed ? "passed" : "failed"} | ${score.errors.join("; ") || "-"} |`,
    );
    await this.text(
      "summary.md",
      [
        "# OpenCode free-model evaluation",
        "",
        `- Classification: ${result.classification}`,
        `- Model: ${result.selectedModel ?? "none"}`,
        `- Provider attempts: ${result.attempts}`,
        `- Detail: ${result.message}`,
        "",
        "| Scenario | Result | Detail |",
        "| --- | --- | --- |",
        ...rows,
        "",
      ].join("\n"),
    );
  }
}
