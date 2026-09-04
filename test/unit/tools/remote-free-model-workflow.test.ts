import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

interface WorkflowTrigger {
  readonly schedule: readonly [{ readonly cron: string }];
  readonly workflow_dispatch: { readonly inputs: Record<string, unknown> };
}

test("free-model evaluation is scheduled and manual evidence, not a pull-request gate", async () => {
  const source = await readFile(".github/workflows/remote-free-model-e2e.yml", "utf8");
  const workflow = Bun.YAML.parse(source) as { readonly on?: unknown };
  const trigger = workflow.on as WorkflowTrigger;

  expect(Object.keys(trigger).sort()).toEqual(["schedule", "workflow_dispatch"]);
  expect(trigger.schedule).toEqual([{ cron: "23 5 * * 1" }]);
  expect(Object.keys(trigger.workflow_dispatch.inputs)).toEqual(["model"]);
});
