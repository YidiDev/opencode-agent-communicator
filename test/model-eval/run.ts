import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { resolveExactProjectCli } from "../live/harness/cli";
import { runBoundedProcess } from "../live/harness/process";
import { ArtifactWriter } from "./artifacts";
import { discoverModels, selectModels } from "./catalog";
import { classifyProcess, isTransient } from "./classification";
import { createEvaluationIsolation } from "./isolation";
import { packAndInstall } from "./package-install";
import { runScenarios } from "./scenarios";
import type { EvaluationResult, ScenarioScore } from "./types";

const repository = resolve(import.meta.dir, "../..");

async function captureVersions(cli: string, artifacts: ArtifactWriter): Promise<void> {
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", NO_COLOR: "1" };
  const [openCode, npm, bun] = await Promise.all([
    runBoundedProcess({
      command: cli,
      arguments: ["--version"],
      cwd: repository,
      environment,
      deadlineMs: 30_000,
    }),
    runBoundedProcess({
      command: "npm",
      arguments: ["--version"],
      cwd: repository,
      environment,
      deadlineMs: 30_000,
    }),
    runBoundedProcess({
      command: "bun",
      arguments: ["--version"],
      cwd: repository,
      environment,
      deadlineMs: 30_000,
    }),
  ]);
  await artifacts.json("versions.json", {
    opencode: openCode.stdout.trim(),
    npm: npm.stdout.trim(),
    bun: bun.stdout.trim(),
    node: process.version,
  });
}

async function evaluate(): Promise<EvaluationResult> {
  const artifacts = new ArtifactWriter();
  await artifacts.initialize();
  await Promise.all([
    artifacts.json("versions.json", { status: "not-collected" }),
    artifacts.json("pack-report.json", { status: "not-created" }),
    artifacts.text("pack-sha256.txt", "not-created\n"),
    artifacts.json("npm-ls.json", { status: "not-run" }),
    artifacts.json("available-models.json", []),
    artifacts.json("selected-models.json", []),
    artifacts.json("sanitized-config.json", { status: "not-created" }),
  ]);
  let privateRoot: string | undefined;
  let attempts = 0;
  let selectedModel: string | undefined;
  let scores: Readonly<Record<string, ScenarioScore>> = {};
  let result: EvaluationResult | undefined;
  try {
    const cli = await resolveExactProjectCli(repository);
    await captureVersions(cli, artifacts);
    privateRoot = await mkdtemp(`${tmpdir()}/opencode-model-eval-package-`);
    const installed = await packAndInstall(repository, privateRoot, artifacts);
    const catalog = await discoverModels();
    const selection = selectModels(catalog, process.env.OPENCODE_FREE_MODEL);
    await artifacts.json("available-models.json", selection.available);
    await artifacts.json("selected-models.json", selection.selected);
    if (selection.selected.length === 0) {
      result = {
        classification: "model_removed",
        attempts,
        scenarios: scores,
        message: "No reviewed free model is available.",
      };
      return result;
    }

    for (const model of selection.selected.slice(0, 2)) {
      attempts += 1;
      selectedModel = model;
      const isolation = await createEvaluationIsolation(installed.entry, model);
      await artifacts.json(`attempt-${attempts}-config.json`, isolation.config);
      await artifacts.json("sanitized-config.json", isolation.config);
      try {
        const attempt = await runScenarios({
          cli,
          cwd: isolation.project,
          environment: isolation.environment,
          artifacts,
          artifactPrefix: `attempt-${attempts}`,
        });
        scores = attempt.scores;
        result = {
          classification: attempt.classification,
          selectedModel: model,
          attempts,
          scenarios: scores,
          message:
            attempt.classification === "passed"
              ? "All required behaviors passed."
              : "Evaluation did not pass.",
        };
        if (!isTransient(attempt.classification) || attempts >= selection.selected.length)
          return result;
      } finally {
        await isolation.remove();
      }
    }
    return (
      result ?? {
        classification: "harness_failed",
        attempts,
        scenarios: scores,
        message: "No provider attempt ran.",
      }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const classified = classifyProcess({ exitCode: 1, stdout: "", stderr: message });
    const failureResult: EvaluationResult = {
      classification:
        classified ?? (message.includes("no longer present") ? "model_removed" : "harness_failed"),
      ...(selectedModel === undefined ? {} : { selectedModel }),
      attempts,
      scenarios: scores,
      message,
    };
    result = failureResult;
    return failureResult;
  } finally {
    if (privateRoot !== undefined)
      await rm(privateRoot, { recursive: true, force: true, maxRetries: 3 });
    await artifacts.result(
      result ?? {
        classification: "harness_failed",
        attempts,
        scenarios: scores,
        message: "Evaluator terminated unexpectedly.",
      },
    );
  }
}

const result = await evaluate();
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.classification === "passed" ? 0 : 1;
