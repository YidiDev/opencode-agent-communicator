import { expect, test } from "bun:test";

import { prepareSubmittedRetainedResult } from "../../../src/application/request-result-preparation";

const context = {
  abort: new AbortController().signal,
  deadlineMs: 100,
};

test("retained-result preparation accepts canonical content and rejects malformed content", async () => {
  const ports = {
    clock: { nowMs: () => 1 },
    digest: { sha256: async () => new Uint8Array(32).fill(1) },
  };
  expect(await prepareSubmittedRetainedResult(ports, context, { kind: "wait" })).toMatchObject({
    ok: true,
    value: { serialized: '{"kind":"wait"}' },
  });
  expect(await prepareSubmittedRetainedResult(ports, context, { kind: "unknown" })).toMatchObject({
    ok: false,
    error: { code: "storage_unavailable" },
  });
});

test("retained-result preparation contains digest rejection after rechecking control", async () => {
  const result = await prepareSubmittedRetainedResult(
    {
      clock: { nowMs: () => 1 },
      digest: {
        sha256: async () => {
          throw new Error("digest unavailable");
        },
      },
    },
    context,
    { kind: "wait" },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
});
