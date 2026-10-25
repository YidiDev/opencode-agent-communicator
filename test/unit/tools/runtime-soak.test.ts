import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertContinuousObservation, soakOutcome } from "../../soak/evidence";
import { decodeBlockingFixture, decodeSoakCall, soakMarker } from "../../soak/provider";

test("soak evidence cannot qualify smoke, short, gapped or unverified runs as stable", () => {
  const valid = {
    smoke: false,
    requestedMs: 48 * 3_600_000,
    elapsedMs: 48 * 3_600_000,
    samples: 577,
    restarts: 1,
    companionsPassed: true,
  };
  expect(soakOutcome(valid)).toBe("passed");
  expect(soakOutcome({ ...valid, smoke: true })).toBe("smoke_passed");
  for (const change of [
    { elapsedMs: valid.elapsedMs - 1 },
    { requestedMs: 1000, elapsedMs: 1000 },
    { elapsedMs: NaN },
    { requestedMs: Infinity },
    { samples: 0 },
    { samples: 1.5 },
    { restarts: 0 },
    { restarts: 2 },
    { companionsPassed: false },
  ])
    expect(() => soakOutcome({ ...valid, ...change })).toThrow();
});

test("soak runner refuses to overwrite an existing evidence directory before installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "communicator-soak-evidence-"));
  try {
    const existing = join(root, "existing");
    await mkdir(existing);
    const original = '{"result":"passed","unchanged":true}\n';
    await writeFile(join(existing, "summary.json"), original);
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../soak/runner.ts"),
        "--artifact",
        join(root, "absent-artifact"),
        "--output",
        existing,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(1);
    expect(await readFile(join(existing, "summary.json"), "utf8")).toBe(original);
    expect(await readdir(root)).toEqual(["existing"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("soak provider responds automatically only to marked blocking fixtures, not immediate requests", () => {
  const envelope = {
    protocol: "opencode-session-communicator/v1",
    request_id: "req_fixture",
    operation: "ask",
    payload: { questions: [{ prompt: "Synthetic blocking soak choice" }] },
  };
  const tools = [
    { function: { name: "session_respond" } },
    { function: { name: "session_signal" } },
  ];
  const body = (value: unknown) => ({
    tools,
    messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify(value) }] }],
  });
  expect(decodeBlockingFixture(body(envelope))).toEqual({
    name: "session_respond",
    arguments: JSON.stringify({ request_id: "req_fixture", answers: [["yes"]] }),
  });
  expect(
    decodeBlockingFixture(
      body({ ...envelope, operation: "wait", payload: { milestone: "synthetic-blocking-ready" } }),
    )?.name,
  ).toBe("session_signal");
  expect(
    decodeBlockingFixture(
      body({ ...envelope, payload: { questions: [{ prompt: "Synthetic fixture choice" }] } }),
    ),
  ).toBeUndefined();
  expect(decodeBlockingFixture({ ...body(envelope), tools: [] })).toBeUndefined();
  expect(decodeBlockingFixture(body({ ...envelope, request_id: "invalid" }))).toBeUndefined();
  expect(decodeBlockingFixture(null)).toBeUndefined();
});

test("soak observation detects wall-clock jumps, missing intervals and invalid clocks", () => {
  const previous = { elapsedMs: 1000, wallMs: 100_000 };
  expect(() =>
    assertContinuousObservation(previous, { elapsedMs: 2000, wallMs: 101_000 }, 10_000),
  ).not.toThrow();
  for (const current of [
    { elapsedMs: 999, wallMs: 101_000 },
    { elapsedMs: 12_000, wallMs: 111_000 },
    { elapsedMs: 2000, wallMs: 200_000 },
    { elapsedMs: 2000, wallMs: 0 },
    { elapsedMs: NaN, wallMs: 101_000 },
  ])
    expect(() => assertContinuousObservation(previous, current, 10_000)).toThrow();
  expect(() => assertContinuousObservation(previous, previous, 0)).toThrow();
});

test("soak provider only calls explicitly advertised communicator tools for the latest user command", () => {
  const command = { name: "session_lock_list", arguments: {} };
  const body = {
    tools: [{ function: { name: command.name } }],
    messages: [{ role: "user", content: soakMarker + JSON.stringify(command) }],
  };
  expect(decodeSoakCall(body)).toEqual({ name: command.name, arguments: "{}" });
  expect(
    decodeSoakCall({
      ...body,
      messages: [
        { role: "user", content: [{ type: "text", text: soakMarker + JSON.stringify(command) }] },
      ],
    }),
  ).toEqual({ name: command.name, arguments: "{}" });
  for (const candidate of [
    null,
    {},
    { ...body, tools: [] },
    { ...body, messages: [] },
    { ...body, messages: [...body.messages, { role: "tool", content: "result" }] },
    { ...body, messages: [{ role: "user", content: "Synthetic queued peer payload" }] },
  ])
    expect(decodeSoakCall(candidate)).toBeUndefined();
  for (const call of [
    { name: "shell", arguments: {} },
    { name: command.name, arguments: [] },
    null,
  ])
    expect(() =>
      decodeSoakCall({
        ...body,
        messages: [{ role: "user", content: soakMarker + JSON.stringify(call) }],
      }),
    ).toThrow();
});
