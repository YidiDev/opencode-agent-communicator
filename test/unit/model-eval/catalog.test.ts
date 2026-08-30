import { expect, test } from "bun:test";

import { selectModels } from "../../model-eval/catalog";

test("selects reviewed available free models in policy order", () => {
  const selection = selectModels({
    data: [
      { id: "mimo-v2.5-free" },
      { id: "unreviewed-free" },
      { id: "opencode/nemotron-3.5-lightning-free" },
    ],
  });

  expect(selection.selected).toEqual(["nemotron-3.5-lightning-free", "mimo-v2.5-free"]);
  expect(selection.available).toEqual([
    "mimo-v2.5-free",
    "opencode/nemotron-3.5-lightning-free",
    "unreviewed-free",
  ]);
});

test("validates an explicit model against both allowlist and live catalog", () => {
  expect(
    selectModels({ data: [{ id: "mimo-v2.5-free" }] }, "opencode/mimo-v2.5-free").selected,
  ).toEqual(["mimo-v2.5-free"]);
  expect(() => selectModels({ data: [{ id: "other" }] }, "other")).toThrow("allowlist");
  expect(() => selectModels({ data: [] }, "mimo-v2.5-free")).toThrow("no longer present");
});

test("rejects malformed catalog payloads", () => {
  expect(() => selectModels({ models: [] })).toThrow("data array");
  expect(() => selectModels(null)).toThrow("not an object");
});
