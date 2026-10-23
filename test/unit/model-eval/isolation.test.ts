import { expect, test } from "bun:test";
import { createEvaluationIsolation } from "../../model-eval/isolation";

test("model evaluation configures the actual installed source directory, not its entry file", async () => {
  const isolation = await createEvaluationIsolation(
    "/private/consumer/node_modules/opencode-agent-communicator/src/index.ts",
    "reviewed-test-model",
  );
  try {
    expect(isolation.config.plugin).toEqual([
      [
        "file:///private/consumer/node_modules/opencode-agent-communicator/src",
        expect.objectContaining({ policies: expect.objectContaining({ start: "allow" }) }),
      ],
    ]);
    expect(isolation.environment.XDG_STATE_HOME).toStartWith(isolation.root);
  } finally {
    await isolation.remove();
  }
});
