import { expect, setDefaultTimeout, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpencodeClient, type SessionDurableEvent } from "@opencode-ai/sdk/v2/client";

import { cleanupAll } from "./harness/cleanup";
import { resolveExactProjectCli } from "./harness/cli";
import {
  alternateTestModelID,
  diagnosticProviderCallID,
  exactOpenCodeVersion,
  liveDeadlineMs,
  testModelID,
  testProviderID,
} from "./harness/constants";
import { readEvidence, waitForEvidence } from "./harness/evidence";
import type { IsolatedOpenCodeState } from "./harness/isolation";
import { createIsolatedOpenCodeState } from "./harness/isolation";
import { launchManagedProcess, type ManagedProcess, waitForOutputLine } from "./harness/process";
import { launchDeterministicProvider, type ProviderHarness } from "./harness/provider";

setDefaultTimeout(liveDeadlineMs * 8);

type Client = ReturnType<typeof createOpencodeClient>;

interface Fixture {
  readonly baseUrl: string;
  readonly client: Client;
  readonly isolation: IsolatedOpenCodeState;
  readonly provider: ProviderHarness;
  readonly serve: ManagedProcess;
  close(): Promise<void>;
}

function successful<T>(
  result: { readonly data: T | undefined; readonly error?: unknown; readonly response: Response },
  label: string,
): NonNullable<T> {
  if (result.error !== undefined || result.data === undefined) {
    throw new Error(`${label} failed (${result.response.status}): ${JSON.stringify(result.error)}`);
  }
  return result.data as NonNullable<T>;
}

async function startServer(
  cliPath: string,
  isolation: IsolatedOpenCodeState,
): Promise<{ baseUrl: string; client: Client; serve: ManagedProcess }> {
  const serve = launchManagedProcess({
    command: cliPath,
    arguments: ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    cwd: isolation.project,
    environment: isolation.environment,
  });
  try {
    const baseUrl = await waitForOutputLine(
      serve.child,
      (line) => line.match(/^opencode server listening on (http:\/\/127\.0\.0\.1:\d+)$/)?.[1],
    );
    return {
      baseUrl,
      serve,
      client: createOpencodeClient({ baseUrl, directory: isolation.project }),
    };
  } catch (error: unknown) {
    await cleanupAll([() => serve.terminate()], error);
    throw new Error("unreachable server readiness cleanup");
  }
}

async function initialize(client: Client, directory: string): Promise<void> {
  expect(
    successful(await client.project.initGit({ directory }), "project initialization").worktree,
  ).toBe(directory);
  expect(successful(await client.project.current(), "instance initialization").worktree).toBe(
    directory,
  );
  successful(await client.tool.ids({ directory }), "plugin initialization");
  successful(await client.v2.location.get({ location: { directory } }), "V2 initialization");
}

async function launchFixture(): Promise<Fixture> {
  const thisDirectory = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(thisDirectory, "..", "..");
  const pluginPath = await realpath(join(thisDirectory, "fixtures", "diagnostic-plugin.ts"));
  const provider = launchDeterministicProvider();
  let isolation: IsolatedOpenCodeState | undefined;
  let running: { baseUrl: string; client: Client; serve: ManagedProcess } | undefined;
  try {
    isolation = await createIsolatedOpenCodeState({
      providerBaseUrl: provider.baseUrl,
      pluginPath,
    });
    const cliPath = await resolveExactProjectCli(projectRoot);
    const version = Bun.spawnSync([cliPath, "--version"], {
      cwd: isolation.project,
      env: isolation.environment,
    });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString()).toBe(`${exactOpenCodeVersion}\n`);
    running = await startServer(cliPath, isolation);
    await initialize(running.client, isolation.project);
    const ready = running;
    const state = isolation;
    return {
      ...ready,
      isolation: state,
      provider,
      async close(): Promise<void> {
        await cleanupAll([
          () => ready.serve.terminate(),
          () => provider.stop(),
          () => state.remove(),
        ]);
      },
    };
  } catch (error: unknown) {
    await cleanupAll(
      [() => running?.serve.terminate(), () => provider.stop(), () => isolation?.remove()],
      error,
    );
    throw new Error("unreachable fixture cleanup");
  }
}

const legacyModel = { providerID: testProviderID, modelID: testModelID } as const;
const v2Model = { providerID: testProviderID, id: testModelID } as const;

async function createLegacySession(fixture: Fixture, title: string): Promise<string> {
  return successful(await fixture.client.session.create({ title }), "legacy session create").id;
}

function invokeTool(fixture: Fixture, sessionID: string, marker: string, toolID: string) {
  return fixture.client.session.prompt({
    sessionID,
    model: legacyModel,
    agent: "build",
    tools: { [toolID]: true },
    parts: [{ type: "text", text: marker }],
  });
}

async function proveHostRawArgumentStripping(fixture: Fixture): Promise<void> {
  const sessionID = await createLegacySession(fixture, "Host raw argument strictness");
  successful(
    await invokeTool(fixture, sessionID, "tool-unknown-key", "diagnostic_context"),
    "unknown-key host execution",
  );
  const evidence = await waitForEvidence(
    fixture.isolation.evidencePath,
    (item) => item.event === "executed" && item.sessionID === sessionID,
  );
  // Pinned 1.18.23 preserves undeclared keys through execute, so composition's strict parse can
  // authoritatively reject them rather than relying only on the advertised tool schema.
  expect(evidence.rawArguments).toEqual({ unknown_key: true });
}

async function waitForLegacyStatus<T extends "retry" | "busy" | "idle">(
  fixture: Fixture,
  sessionID: string,
  type: T,
): Promise<
  Extract<
    NonNullable<Awaited<ReturnType<Client["session"]["status"]>>["data"]>[string],
    { type: T }
  >
> {
  const deadline = performance.now() + liveDeadlineMs;
  while (performance.now() < deadline) {
    const status = successful(await fixture.client.session.status(), "legacy status")[sessionID];
    if (status?.type === type) return status as never;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`legacy status did not become ${type}`);
}

async function waitForPermission(fixture: Fixture, sessionID: string) {
  const deadline = performance.now() + liveDeadlineMs;
  while (performance.now() < deadline) {
    const pending = successful(
      await fixture.client.permission.list({ directory: fixture.isolation.project }),
      "pending permission list",
    );
    const match = pending.find((item) => item.sessionID === sessionID);
    if (match) return match;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("pending ToolContext.ask request was not exposed");
}

test("proves ToolContext.ask allow, deny, ask, exact metadata, cancellation, and retry", async () => {
  const fixture = await launchFixture();
  let testFailure: unknown;
  try {
    const loadedConfig = successful(
      await fixture.client.config.get({ directory: fixture.isolation.project }),
      "loaded config",
    );
    expect(loadedConfig.skills?.paths).toContain(join(fixture.isolation.root, "control-skills"));
    const legacySkills = successful(
      await fixture.client.app.skills({ directory: fixture.isolation.project }),
      "legacy skill list",
    );
    expect(legacySkills.find((skill) => skill.name === "phase0-control-skill")).toMatchObject({
      name: "phase0-control-skill",
      description: "Deterministic pre-start registration control.",
    });
    expect(legacySkills.find((skill) => skill.name === "phase0-hook-skill")).toMatchObject({
      name: "phase0-hook-skill",
      description: "Deterministic config-hook registration proof.",
      location: join(fixture.isolation.skillPath, "phase0-hook-skill", "SKILL.md"),
    });
    const skills = successful(
      await fixture.client.v2.skill.list({
        location: { directory: fixture.isolation.project },
      }),
      "V2 skill list",
    ).data;
    expect(skills.find((skill) => skill.name === "phase0-control-skill")).toBeUndefined();
    expect(skills.find((skill) => skill.name === "phase0-hook-skill")).toBeUndefined();
    const configHook = await waitForEvidence(
      fixture.isolation.evidencePath,
      (item) => item.event === "config-hook" && item.pid === fixture.serve.child.pid,
    );
    expect(configHook.skillPath).toBe(fixture.isolation.skillPath);

    await proveHostRawArgumentStripping(fixture);

    for (const mode of ["allow", "deny", "ask", "stop"] as const) {
      const sessionID = await createLegacySession(fixture, `ToolContext.ask ${mode}`);
      const providerStart = fixture.provider.requests.length;
      const run = invokeTool(fixture, sessionID, `tool-approval-${mode}`, "diagnostic_approval");
      const entered = await waitForEvidence(
        fixture.isolation.evidencePath,
        (item) => item.event === "ask-entered" && item.sessionID === sessionID,
      );
      const expectedRequest = {
        permission: mode === "stop" ? "session_stop" : `live_${mode}`,
        patterns: [`resource:${mode}:primary`, `resource:${mode}:secondary`],
        always: [`resource:${mode}:*`],
        metadata: { proof: "phase0", mode, nested: { ordinal: 21 } },
      };
      expect(entered.request).toEqual(expectedRequest);
      await waitForEvidence(
        fixture.isolation.evidencePath,
        (item) => item.event === "ask-invoked" && item.sessionID === sessionID,
      );

      if (mode === "ask" || mode === "stop") {
        const pending = await waitForPermission(fixture, sessionID);
        expect(pending).toMatchObject({
          sessionID,
          permission: expectedRequest.permission,
          patterns: expectedRequest.patterns,
          always: expectedRequest.always,
          metadata: expectedRequest.metadata,
        });
        expect(typeof pending.id).toBe("string");
        expect(pending.tool?.messageID).toBe(entered.messageID as string);
        expect(pending.tool?.callID).toBe(diagnosticProviderCallID);
        expect(fixture.provider.requests).toHaveLength(providerStart + 1);
        expect(
          (
            await fixture.client.permission.reply({
              requestID: pending.id,
              directory: fixture.isolation.project,
              reply: "once",
            })
          ).response.status,
        ).toBe(200);
      } else {
        const pendingAtBoundary = successful(
          await fixture.client.permission.list({ directory: fixture.isolation.project }),
          `${mode} permission list at ask boundary`,
        );
        expect(pendingAtBoundary.some((item) => item.sessionID === sessionID)).toBe(false);
      }

      successful(await run, `${mode} ToolContext.ask run`);
      const evidence = await readEvidence(fixture.isolation.evidencePath);
      const messages = successful(
        await fixture.client.session.messages({ sessionID }),
        `${mode} ToolContext.ask messages`,
      );
      const toolPart = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.tool === "diagnostic_approval");
      if (toolPart?.type !== "tool") throw new Error(`${mode} approval tool part is absent`);
      expect(toolPart.callID).toBe(diagnosticProviderCallID);
      expect(fixture.provider.requests).toHaveLength(providerStart + 2);
      expect(JSON.stringify(fixture.provider.requests[providerStart + 1])).toContain(
        `"tool_call_id":"${diagnosticProviderCallID}"`,
      );
      if (mode === "deny") {
        const rejected = evidence.find(
          (item) => item.event === "ask-rejected" && item.mode === mode,
        );
        const denial =
          'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules [{"permission":"*","action":"allow","pattern":"*"},{"permission":"live_deny","action":"deny","pattern":"*"}]';
        expect(rejected?.message).toBe(denial);
        expect(toolPart.state).toMatchObject({ status: "error", error: denial });
      } else {
        expect(
          evidence.find((item) => item.event === "ask-resolved" && item.mode === mode)?.output,
        ).toBe(`ask-${mode}-completed`);
        expect(toolPart.state).toMatchObject({
          status: "completed",
          output: `ask-${mode}-completed`,
        });
      }
      expect(
        successful(
          await fixture.client.permission.list({ directory: fixture.isolation.project }),
          "settled permission list",
        ).some((item) => item.sessionID === sessionID),
      ).toBe(false);
    }

    const cancellationSession = await createLegacySession(fixture, "ToolContext cancellation");
    const cancellationRun = invokeTool(
      fixture,
      cancellationSession,
      "tool-cancellation",
      "diagnostic_cancellation",
    );
    const cancellationEntered = await waitForEvidence(
      fixture.isolation.evidencePath,
      (item) => item.event === "cancellation-entered" && item.sessionID === cancellationSession,
    );
    expect(cancellationEntered.aborted).toBe(false);
    expect(
      successful(
        await fixture.client.session.abort({ sessionID: cancellationSession }),
        "legacy cancellation",
      ),
    ).toBe(true);
    const cancellationObserved = await waitForEvidence(
      fixture.isolation.evidencePath,
      (item) => item.event === "cancellation-observed" && item.aborted === true,
    );
    expect(cancellationObserved.aborted).toBe(true);
    await cancellationRun;
    const messages = successful(
      await fixture.client.session.messages({ sessionID: cancellationSession }),
      "cancelled session messages",
    );
    const cancelledTool = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.tool === "diagnostic_cancellation");
    if (cancelledTool?.type !== "tool") {
      throw new Error("cancelled diagnostic tool part is absent");
    }
    expect(cancelledTool.state).toMatchObject({
      status: "completed",
      output: "tool-observed-abort",
      metadata: { truncated: false },
    });

    const retrySession = await createLegacySession(fixture, "Legacy retry status");
    const requestsBeforeRetry = fixture.provider.requests.length;
    const retryRun = invokeTool(fixture, retrySession, "legacy-retry", "diagnostic_context");
    const retryRequest = await fixture.provider.waitForRequestText(
      "legacy-retry",
      requestsBeforeRetry,
    );
    expect(retryRequest.sequence).toBe(requestsBeforeRetry + 1);
    expect(fixture.provider.requests).toHaveLength(requestsBeforeRetry + 1);
    const retry = await waitForLegacyStatus(fixture, retrySession, "retry");
    expect(retry).toMatchObject({
      type: "retry",
      attempt: 1,
      message: "phase0 deterministic retryable 503",
    });
    expect(fixture.provider.requests).toHaveLength(requestsBeforeRetry + 1);
    expect(Math.abs(retry.next - (retryRequest.receivedAt + 60_000))).toBeLessThanOrEqual(2_000);
    expect(
      successful(await fixture.client.session.abort({ sessionID: retrySession }), "retry abort"),
    ).toBe(true);
    await retryRun;
    expect(
      successful(await fixture.client.session.status(), "post-retry status")[retrySession],
    ).toBe(undefined);
  } catch (error: unknown) {
    testFailure = error;
  } finally {
    await cleanupAll([() => fixture.close()], testFailure);
  }
});

function durableSequence(event: SessionDurableEvent): number {
  const sequence = event.durable?.seq;
  if (sequence === undefined) throw new Error("event has no durable sequence");
  return sequence;
}

function streamedEvent(value: unknown): SessionDurableEvent {
  if (typeof value === "object" && value !== null && "type" in value && "durable" in value) {
    return value as SessionDurableEvent;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("data" in value) ||
    typeof value.data !== "string"
  ) {
    throw new Error("event subscription ended unexpectedly");
  }
  return JSON.parse(value.data) as SessionDurableEvent;
}

async function proveAlternatePayloadValidity(fixture: Fixture) {
  const alternateClient = createOpencodeClient({
    baseUrl: fixture.baseUrl,
    directory: fixture.isolation.alternateProject,
  });
  await initialize(alternateClient, fixture.isolation.alternateProject);
  const alternateAgents = successful(
    await alternateClient.v2.agent.list({
      location: { directory: fixture.isolation.alternateProject },
    }),
    "alternate location agents",
  ).data;
  expect(alternateAgents.map((agent) => agent.id)).toContain("alternate");
  const alternateModels = successful(
    await alternateClient.v2.model.list({
      location: { directory: fixture.isolation.alternateProject },
    }),
    "alternate location models",
  ).data;
  expect(
    alternateModels.some(
      (item) => item.providerID === testProviderID && item.id === alternateTestModelID,
    ),
  ).toBe(true);
  const alternatePayload = {
    agent: "alternate",
    model: { providerID: testProviderID, id: alternateTestModelID },
    location: { directory: fixture.isolation.alternateProject },
  } as const;
  const controlID = "ses_01PHASE0ALTERNATECONTROL00001";
  const alternateControl = successful(
    await alternateClient.v2.session.create({ id: controlID, ...alternatePayload }),
    "alternate control create",
  ).data;
  expect(alternateControl).toMatchObject({ id: controlID, ...alternatePayload });
  expect(
    successful(
      await alternateClient.v2.session.get({ sessionID: controlID }),
      "alternate control get",
    ).data,
  ).toEqual(alternateControl);
  return alternatePayload;
}

test("proves conflicting V2 create and durable replay across a server restart", async () => {
  const fixture = await launchFixture();
  const thisDirectory = dirname(fileURLToPath(import.meta.url));
  const cliPath = await resolveExactProjectCli(join(thisDirectory, "..", ".."));
  let restarted: ManagedProcess | undefined;
  let testFailure: unknown;
  try {
    const sessionID = "ses_01PHASE0REMAINING000000001";
    const original = successful(
      await fixture.client.v2.session.create({
        id: sessionID,
        agent: "build",
        model: v2Model,
        location: { directory: fixture.isolation.project },
      }),
      "original V2 create",
    ).data;
    const alternatePayload = await proveAlternatePayloadValidity(fixture);
    const conflicting = successful(
      await fixture.client.v2.session.create({
        id: sessionID,
        ...alternatePayload,
      }),
      "conflicting V2 create",
    ).data;
    expect(conflicting).toEqual(original);
    const stored = successful(await fixture.client.v2.session.get({ sessionID }), "V2 get").data;
    expect(stored).toEqual(original);
    expect(stored).toMatchObject({
      id: sessionID,
      agent: "build",
      model: v2Model,
      location: { directory: fixture.isolation.project },
    });

    for (const [index, text] of ["replay-one", "replay-two", "replay-three"].entries()) {
      successful(
        await fixture.client.v2.session.prompt({
          sessionID,
          id: `msg_01PHASE0REPLAY00000000000${index + 1}`,
          prompt: { text },
          delivery: "queue",
          resume: false,
        }),
        `non-resuming admission ${index + 1}`,
      );
    }
    const omittedAggregateID = "ses_01PHASE0REMAINING000000002";
    successful(
      await fixture.client.v2.session.create({
        id: omittedAggregateID,
        agent: "build",
        model: v2Model,
        location: { directory: fixture.isolation.project },
      }),
      "second aggregate create",
    );
    successful(
      await fixture.client.v2.session.prompt({
        sessionID: omittedAggregateID,
        id: "msg_01PHASE0REPLAYSECOND000001",
        prompt: { text: "omitted-cursor-aggregate" },
        delivery: "queue",
        resume: false,
      }),
      "second aggregate admission",
    );
    const complete = successful(
      await fixture.client.v2.session.history({ sessionID, limit: 100 }),
      "complete durable history",
    ).data;
    expect(complete.length).toBeGreaterThanOrEqual(3);
    const cursor = durableSequence(complete.at(-2) as SessionDurableEvent);
    const expectedReplay = complete.filter((event) => durableSequence(event) > cursor);
    const finite = successful(
      await fixture.client.v2.session.history({ sessionID, after: cursor, limit: 1 }),
      "bounded history page",
    ).data;
    expect(finite).toEqual(expectedReplay.slice(0, 1));
    expect(
      successful(
        await fixture.client.v2.session.history({
          sessionID,
          after: durableSequence(complete.at(-1) as SessionDurableEvent),
          limit: 100,
        }),
        "history at current cursor",
      ).data,
    ).toEqual([]);

    await fixture.serve.terminate();
    const running = await startServer(cliPath, fixture.isolation);
    restarted = running.serve;
    await initialize(running.client, fixture.isolation.project);
    const replaySubscription = await running.client.v2.session.events({
      sessionID,
      after: String(cursor),
    });
    const replayIterator = replaySubscription.stream[Symbol.asyncIterator]();
    const expectedFirstReplay = expectedReplay[0];
    if (!expectedFirstReplay) throw new Error("expected restart replay is absent");
    expect(streamedEvent((await replayIterator.next()).value)).toEqual(expectedFirstReplay);
    expect((await replayIterator.return()).done).toBe(true);

    const current = durableSequence(complete.at(-1) as SessionDurableEvent);
    const liveSubscription = await running.client.v2.session.events({
      sessionID,
      after: String(current),
    });
    const liveIterator = liveSubscription.stream[Symbol.asyncIterator]();
    const liveNext = liveIterator.next();
    const admission = successful(
      await running.client.v2.session.prompt({
        sessionID,
        id: "msg_01PHASE0REPLAY000000000004",
        prompt: { text: "post-restart-live" },
        delivery: "queue",
        resume: false,
      }),
      "post-restart admission",
    ).data;
    const liveResult = await liveNext;
    expect(liveResult.done).toBe(false);
    const liveEvent = streamedEvent(liveResult.value);
    expect(liveEvent).toMatchObject({
      type: "session.next.prompt.admitted",
      durable: { aggregateID: sessionID, seq: admission.admittedSeq },
      data: { sessionID, messageID: admission.id, prompt: { text: "post-restart-live" } },
    });
    expect((await liveIterator.return()).done).toBe(true);

    const reconciled = successful(
      await running.client.sync.history.list({ body: { [sessionID]: cursor } }),
      "aggregate reconciliation",
    );
    const sessionEvents = reconciled.filter((event) => event.aggregate_id === sessionID);
    const expectedSubsequent = successful(
      await running.client.v2.session.history({ sessionID, after: cursor, limit: 100 }),
      "complete post-restart subsequent history",
    ).data;
    const expectedSequences = expectedSubsequent.map(durableSequence);
    const knownSequences = sessionEvents.map((event) => event.seq);
    expect(knownSequences.every((sequence) => sequence > cursor)).toBe(true);
    expect(knownSequences).toEqual(expectedSequences);
    expect(expectedSequences).toEqual(
      Array.from(
        { length: durableSequence(liveEvent) - cursor },
        (_item, index) => cursor + index + 1,
      ),
    );
    const omittedAggregateEvents = reconciled.filter(
      (event) => event.aggregate_id === omittedAggregateID,
    );
    expect(omittedAggregateEvents.length).toBeGreaterThan(0);
    expect(omittedAggregateEvents.some((event) => event.seq === 1)).toBe(true);
    expect(successful(await running.client.instance.dispose(), "restarted instance dispose")).toBe(
      true,
    );
  } catch (error: unknown) {
    testFailure = error;
  } finally {
    await cleanupAll([() => restarted?.terminate(), () => fixture.close()], testFailure);
  }
});
