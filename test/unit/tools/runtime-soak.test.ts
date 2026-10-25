import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { V2Event } from "@opencode/client";
import {
  recordSoakCompactions,
  requireSoakCompactionCoverage,
  soakCompactionSummary,
} from "../../soak/compaction";
import { assertContinuousObservation, SoakAssertion, soakOutcome } from "../../soak/evidence";
import { observeSoakStep } from "../../soak/host";
import { decodeBlockingFixture, decodeSoakCall, soakMarker } from "../../soak/provider";
import { waitForSoakReceipt } from "../../soak/tool-receipt";

test("soak receipts use live session/call correlation even when compaction removes structured context", async () => {
  const success = {
    type: "session.tool.success",
    data: {
      sessionID: "fixture",
      id: "soak_nonce",
      content: [{ type: "text", text: '{"ok":true}' }],
    },
  };
  let closed = false;
  async function* events(values: unknown[]) {
    try {
      for (const value of values) yield value as V2Event;
    } finally {
      closed = true;
    }
  }
  const content = await waitForSoakReceipt(
    events([
      { ...success, data: { ...success.data, sessionID: "other" } },
      { ...success, data: { ...success.data, id: "other" } },
      success,
    ]),
    "fixture",
    "soak_nonce",
  );
  expect(JSON.stringify(content)).toBe(JSON.stringify(success.data.content));
  expect(closed).toBe(true);
  await expect(waitForSoakReceipt(events([]), "fixture", "soak_nonce")).rejects.toThrow(
    "controlled soak assertion",
  );
  await expect(
    waitForSoakReceipt(
      events([{ ...success, type: "session.tool.failed" }]),
      "fixture",
      "soak_nonce",
    ),
  ).rejects.toThrow("controlled soak assertion");
  const nonce = crypto.randomUUID();
  expect(
    decodeSoakCall({
      messages: [
        {
          role: "user",
          content: soakMarker + JSON.stringify({ name: "session_list", arguments: {}, nonce }),
        },
      ],
      tools: [{ function: { name: "session_list" } }],
    })?.nonce,
  ).toBe(nonce);
});

test("soak compaction metrics deduplicate completed compactions and fail on native failure", () => {
  const seen = new Set<string>();
  const completed = { type: "compaction", id: "fixture", status: "completed" };
  recordSoakCompactions(seen, [completed, completed, { type: "user", id: "other" }]);
  expect(seen.size).toBe(1);
  expect(() => recordSoakCompactions(seen, [{ ...completed, status: "failed" }])).toThrow(
    "controlled soak assertion",
  );
  const bounded = new Set(Array.from({ length: 1024 }, (_, index) => `fixture${index}`));
  expect(() => recordSoakCompactions(bounded, [completed])).toThrow("controlled soak assertion");
  expect(() => requireSoakCompactionCoverage(false, [1, 1])).not.toThrow();
  expect(() => requireSoakCompactionCoverage(true, [0, 0])).not.toThrow();
  for (const counts of [[0, 1], [1, 0], [1], [NaN, 1], [1.5, 1], [1025, 1]])
    expect(() => requireSoakCompactionCoverage(false, counts)).toThrow("controlled soak assertion");
});

test("soak provider honors compaction templates and resumes only an unfinished retained user turn", () => {
  const command = soakMarker + JSON.stringify({ name: "session_read", arguments: { limit: 2 } });
  const body = (content: string) => ({
    messages: [{ role: "user", content }],
    tools: [{ function: { name: "session_read" } }],
  });
  const checkpoint = (recent: string) =>
    `<conversation-checkpoint>\n<summary>${command}</summary>\n<recent-context>\n${recent}\n</recent-context>\n</conversation-checkpoint>`;
  for (const prefix of [
    "You MUST summarize the conversation above into a structured summary",
    "Update the existing checkpoint in the conversation above into one consolidated summary.",
    "The previous response did not fill in the required summary template.",
  ]) {
    const summary = soakCompactionSummary(body(prefix));
    expect(summary).toContain("## Objective");
    expect(summary).toContain("## Next Move");
    expect(decodeSoakCall(body(prefix))).toBeUndefined();
  }
  expect(soakCompactionSummary(body(command))).toBeUndefined();
  expect(decodeSoakCall(body(checkpoint(`[User]: ${command}`)))?.name).toBe("session_read");
  for (const recent of [
    "",
    `[Assistant]: ${command}`,
    `[User]: ${command}\n[Assistant]: done`,
    `[User]: ${command}\n[Assistant tool call]: session_read({})\n[Tool result]: done`,
  ])
    expect(decodeSoakCall(body(checkpoint(recent)))).toBeUndefined();
  expect(decodeSoakCall({ ...body(checkpoint(`[User]: ${command}`)), tools: [] })).toBeUndefined();
  const envelope = {
    protocol: "opencode-session-communicator/v1",
    request_id: "req_fixture",
    operation: "wait",
    payload: { milestone: "synthetic-blocking-ready" },
  };
  expect(
    decodeBlockingFixture({
      messages: [{ role: "user", content: checkpoint(`[User]: ${JSON.stringify(envelope)}`) }],
      tools: [{ function: { name: "session_signal" } }],
    })?.name,
  ).toBe("session_signal");
});

test("soak diagnostics retain only controlled stages and allowlisted failure kinds", async () => {
  expect(await observeSoakStep("session_list:wait", async () => 7)).toBe(7);
  for (const name of [
    "Error",
    "AbortError",
    "TimeoutError",
    "TypeError",
    "SyntaxError",
    "secret-name",
  ]) {
    const failure = new Error("private payload /home/private secret-token");
    failure.name = name;
    const result = await observeSoakStep("session_list:wait", async () => {
      throw failure;
    }).catch((error) => error);
    expect(result).toBeInstanceOf(SoakAssertion);
    expect(result.step).toBe(`session_list:wait:${name === "secret-name" ? "Error" : name}`);
    expect(result.message).not.toContain("private");
  }
  const assertion = new SoakAssertion("observation:continuity_or_clock_invalid");
  expect(
    await observeSoakStep("session_list:wait", async () => {
      throw assertion;
    }).catch((error) => error),
  ).toBe(assertion);
});

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
  try {
    assertContinuousObservation(previous, { elapsedMs: 2000, wallMs: 200_000 }, 10_000);
    throw new Error("Expected a continuity failure");
  } catch (failure) {
    expect(failure).toBeInstanceOf(SoakAssertion);
    expect((failure as SoakAssertion).step).toBe("observation:continuity_or_clock_invalid");
    expect((failure as SoakAssertion).observation).toEqual({
      monotonic_delta_ms: 1000,
      wall_delta_ms: 100_000,
      maximum_gap_ms: 10_000,
    });
  }
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
