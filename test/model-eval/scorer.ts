import { extractToolCalls, parseJsonl } from "./jsonl";
import type { ProcessCapture, ScenarioScore, ToolCall } from "./types";

const forbiddenTools = new Set(["edit", "bash", "session_stop", "session_export"]);

function isOk(output: unknown): boolean {
  return typeof output === "object" && output !== null && Reflect.get(output, "ok") === true;
}

function ordered(tools: readonly ToolCall[], required: readonly string[]): boolean {
  let cursor = 0;
  for (const tool of tools) {
    if (cursor < required.length && tool.name === required[cursor]) cursor += 1;
  }
  return cursor === required.length;
}

function observedSkill(call: ToolCall, skill: string): boolean {
  if (call.name !== "skill") return false;
  return JSON.stringify(call.input).includes(skill) || JSON.stringify(call.output).includes(skill);
}

export function scoreScenario(
  process: ProcessCapture,
  requiredTools: readonly string[],
  requiredSkills: readonly string[] = [],
): ScenarioScore {
  const parsed = parseJsonl(process.stdout);
  const tools = extractToolCalls(parsed.events);
  const completedTools = tools.filter((tool) => tool.status === "completed");
  const errors = [...parsed.errors];
  if (process.exitCode !== 0) errors.push(`process exited ${process.exitCode}`);
  if (!ordered(completedTools, requiredTools))
    errors.push(`missing ordered tools: ${requiredTools.join(", ")}`);
  for (const tool of tools) {
    if (forbiddenTools.has(tool.name)) errors.push(`forbidden tool called: ${tool.name}`);
    if (
      requiredTools.includes(tool.name) &&
      tool.status === "completed" &&
      tool.name !== "skill" &&
      !isOk(tool.output)
    ) {
      errors.push(`${tool.name} did not return ok`);
    }
  }
  for (const skill of requiredSkills) {
    if (!completedTools.some((tool) => observedSkill(tool, skill)))
      errors.push(`skill not observed: ${skill}`);
  }
  const uniqueErrors = [...new Set(errors)];
  return { passed: uniqueErrors.length === 0, errors: uniqueErrors, tools };
}
