import { expect, setDefaultTimeout, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createOpencodeClient,
  type SessionDurableEvent,
  type SessionInputAdmitted,
} from "@opencode-ai/sdk/v2/client";

import { resolveExactProjectCli } from "./harness/cli";
import {
  diagnosticToolID,
  exactOpenCodeVersion,
  liveDeadlineMs,
  testModelID,
  testProviderID,
} from "./harness/constants";
import type { IsolatedOpenCodeState } from "./harness/isolation";
import { createIsolatedOpenCodeState } from "./harness/isolation";
import { launchManagedProcess, type ManagedProcess, waitForOutputLine } from "./harness/process";
import { launchDeterministicProvider, type ProviderHarness } from "./harness/provider";

setDefaultTimeout(liveDeadlineMs * 8);

type Client = ReturnType<typeof createOpencodeClient>;
interface LiveFixture {
  readonly baseUrl: string;
  readonly client: Client;
  readonly eventSequences: Map<string, number>;
  readonly isolation: IsolatedOpenCodeState;
  readonly provider: ProviderHarness;
  readonly serve: ManagedProcess;
  close(): Promise<void>;
}

interface Deferred {
  readonly promise: Promise<void>;
  release(): void;
}

function deferred(): Deferred {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    release(): void {
      resolver?.();
      resolver = undefined;
    },
  };
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

async function initializeLocation(client: Client, isolation: IsolatedOpenCodeState): Promise<void> {
  const initialized = successful(
    await client.project.initGit({ directory: isolation.project }),
    "project git initialization",
  );
  expect(initialized.worktree).toBe(isolation.project);
  const project = successful(await client.project.current(), "project instance initialization");
  expect(project.worktree).toBe(isolation.project);
  const toolIDs = successful(
    await client.tool.ids({ directory: isolation.project }),
    "plugin and location initialization",
  );
  expect(toolIDs).toContain(diagnosticToolID);
  const location = successful(
    await client.v2.location.get({ location: { directory: isolation.project } }),
    "V2 location initialization",
  );
  expect(location.directory).toBe(isolation.project);
  const agents = successful(
    await client.v2.agent.list({ location: { directory: isolation.project } }),
    "V2 agent initialization",
  );
  expect(agents.data.map((agent) => agent.id)).toContain("build");
  const models = successful(
    await client.v2.model.list({ location: { directory: isolation.project } }),
    "V2 model initialization",
  );
  expect(
    models.data.some((item) => item.id === testModelID && item.providerID === testProviderID),
  ).toBe(true);
}

async function launchFixture(): Promise<LiveFixture> {
  const thisDirectory = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(thisDirectory, "..", "..");
  const pluginPath = await realpath(join(thisDirectory, "fixtures", "diagnostic-plugin.ts"));
  const provider = launchDeterministicProvider({ gated: true });
  const isolation = await createIsolatedOpenCodeState({
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
  const serve = launchManagedProcess({
    command: cliPath,
    arguments: ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    cwd: isolation.project,
    environment: isolation.environment,
  });
  const baseUrl = await waitForOutputLine(
    serve.child,
    (line) => line.match(/^opencode server listening on (http:\/\/127\.0\.0\.1:\d+)$/)?.[1],
  );
  const client = createOpencodeClient({ baseUrl, directory: isolation.project });
  await initializeLocation(client, isolation);
  return {
    baseUrl,
    client,
    eventSequences: new Map(),
    isolation,
    provider,
    serve,
    async close(): Promise<void> {
      await serve.terminate();
      await provider.stop();
      await isolation.remove();
    },
  };
}

const model = { providerID: testProviderID, id: testModelID } as const;

async function createV2Session(fixture: LiveFixture, id: string, title: string): Promise<string> {
  const envelope = successful(
    await fixture.client.v2.session.create({
      id,
      model,
      agent: "build",
      location: { directory: fixture.isolation.project },
    }),
    "V2 session create",
  );
  expect(envelope.data.id).toBe(id);
  expect(envelope.data.model).toMatchObject(model);
  expect(
    (await fixture.client.v2.session.switchAgent({ sessionID: id, agent: "build" })).response
      .status,
  ).toBe(204);
  expect(
    (await fixture.client.v2.session.switchModel({ sessionID: id, model })).response.status,
  ).toBe(204);
  const updated = successful(
    await fixture.client.session.update({ sessionID: id, title }),
    "session title initialization",
  );
  expect(updated.title).toBe(title);
  return id;
}

async function prompt(
  fixture: LiveFixture,
  sessionID: string,
  id: string,
  text: string,
  delivery: "queue" | "steer" = "queue",
): Promise<SessionInputAdmitted> {
  const result = await fixture.client.v2.session.prompt({
    sessionID,
    id,
    prompt: { text },
    delivery,
    resume: true,
  });
  return successful(result, `V2 ${delivery} prompt`).data;
}

async function waitForPromptEvent(
  fixture: LiveFixture,
  type: "session.next.prompt.admitted" | "session.next.prompted",
  sessionID: string,
  messageID: string,
): Promise<SessionDurableEvent> {
  return waitForDurableEvent(
    fixture,
    sessionID,
    (event) => event.type === type && event.data.messageID === messageID,
    `${type} for ${messageID}`,
  );
}

async function waitForStepEnd(fixture: LiveFixture, sessionID: string): Promise<void> {
  await waitForDurableEvent(
    fixture,
    sessionID,
    (event) => event.type === "session.next.step.ended",
    `step end for ${sessionID}`,
  );
}

async function history(fixture: LiveFixture, sessionID: string): Promise<SessionDurableEvent[]> {
  return successful(await fixture.client.v2.session.history({ sessionID, limit: 100 }), "history")
    .data;
}

async function waitForDurableEvent(
  fixture: LiveFixture,
  sessionID: string,
  predicate: (event: SessionDurableEvent) => boolean,
  label: string,
): Promise<SessionDurableEvent> {
  for (let count = 0; count < 500; count += 1) {
    const after = fixture.eventSequences.get(sessionID) ?? 0;
    const match = (await history(fixture, sessionID)).find(
      (event) => (event.durable?.seq ?? 0) > after && predicate(event),
    );
    if (match) {
      fixture.eventSequences.set(sessionID, match.durable?.seq ?? after);
      return match;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`durable event gate did not observe ${label}`);
}

async function proveSubscriptionDisposal(fixture: LiveFixture): Promise<void> {
  const result = await fixture.client.v2.session.events({
    sessionID: "ses_01PHASE0000000000000000001",
    after: "0",
  });
  const iterator = result.stream[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);
  expect((await iterator.return()).done).toBe(true);
}

function promptEvents(events: readonly SessionDurableEvent[], messageID: string) {
  return events.flatMap((event) => {
    if (
      (event.type !== "session.next.prompt.admitted" && event.type !== "session.next.prompted") ||
      event.data.messageID !== messageID
    ) {
      return [];
    }
    return [{ type: event.type, delivery: event.data.delivery, seq: event.durable?.seq }];
  });
}

async function expectActivity(fixture: LiveFixture, sessionID: string, active: boolean) {
  for (let count = 0; count < 500; count += 1) {
    const legacy = successful(await fixture.client.session.status(), "legacy status")[sessionID];
    const v2 = successful(await fixture.client.v2.session.active(), "V2 active").data;
    expect(legacy).toBeUndefined();
    if (active === (v2[sessionID] !== undefined)) {
      expect(v2[sessionID]).toEqual(active ? { type: "running" } : undefined);
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`V2 active state did not become ${active ? "running" : "inactive"}`);
}

async function proveIdentityAndListing(fixture: LiveFixture): Promise<void> {
  const rootID = "ses_01PHASE0000000000000000001";
  await createV2Session(fixture, rootID, "Phase zero root");
  const duplicate = await fixture.client.v2.session.create({
    id: rootID,
    model,
    agent: "build",
    location: { directory: fixture.isolation.project },
  });
  expect(duplicate.response.status).toBe(200);
  expect(duplicate.data?.data.id).toBe(rootID);
  const renamed = successful(
    await fixture.client.session.update({ sessionID: rootID, title: "Phase zero renamed" }),
    "legacy title update",
  );
  expect(renamed.title).toBe("Phase zero renamed");
  const child = successful(
    await fixture.client.session.create({ parentID: rootID, title: "Phase zero child" }),
    "legacy child create",
  );
  expect(child.parentID).toBe(rootID);
  const legacyAll = successful(await fixture.client.session.list(), "legacy list");
  const legacyRoots = successful(await fixture.client.session.list({ roots: true }), "root list");
  const v2 = successful(
    await fixture.client.v2.session.list({ directory: fixture.isolation.project, limit: 100 }),
    "V2 list",
  ).data;
  expect(legacyAll.map((item) => item.id)).toEqual(expect.arrayContaining([rootID, child.id]));
  expect(legacyRoots.map((item) => item.id)).toContain(rootID);
  expect(legacyRoots.map((item) => item.id)).not.toContain(child.id);
  expect(v2.find((item) => item.id === rootID)?.title).toBe("Phase zero renamed");
  const archivedAt = Date.now();
  await fixture.client.session.update({ sessionID: rootID, time: { archived: archivedAt } });
  const visible = successful(
    await fixture.client.experimental.session.list({ roots: true, archived: false }),
    "visible roots",
  );
  const archived = successful(
    await fixture.client.experimental.session.list({ roots: true, archived: true }),
    "archived roots",
  );
  expect(visible.map((item) => item.id)).not.toContain(rootID);
  expect(archived.find((item) => item.id === rootID)?.time.archived).toBe(archivedAt);
}

async function proveStatusSeparation(fixture: LiveFixture): Promise<void> {
  const sessionID = await createV2Session(
    fixture,
    "ses_01PHASE0000000000000000006",
    "Phase zero legacy status",
  );
  const run = fixture.client.session.prompt({
    sessionID,
    messageID: "msg_01PHASE0000000000000000012",
    model: { providerID: testProviderID, modelID: testModelID },
    agent: "build",
    parts: [{ type: "text", text: "legacy-active" }],
  });
  const request = await fixture.provider.waitForText("legacy-active");
  expect(
    successful(await fixture.client.session.status(), "legacy busy status")[sessionID],
  ).toEqual({
    type: "busy",
  });
  expect(
    successful(await fixture.client.v2.session.active(), "V2 legacy-owned status").data[sessionID],
  ).toBeUndefined();
  request.release();
  successful(await run, "legacy status run");
  expect(
    successful(await fixture.client.session.status(), "legacy idle status")[sessionID],
  ).toBeUndefined();
  expect(
    successful(await fixture.client.v2.session.active(), "V2 idle status").data[sessionID],
  ).toBeUndefined();
}

async function proveIdleQueueAndFifo(fixture: LiveFixture): Promise<void> {
  const sessionID = await createV2Session(
    fixture,
    "ses_01PHASE0000000000000000002",
    "Phase zero queue",
  );
  await expectActivity(fixture, sessionID, false);
  const first = await prompt(fixture, sessionID, "msg_01PHASE0000000000000000001", "fifo-one");
  expect(Object.keys(first).sort()).toEqual([
    "admittedSeq",
    "delivery",
    "id",
    "prompt",
    "sessionID",
    "timeCreated",
  ]);
  expect(first).toMatchObject({
    id: "msg_01PHASE0000000000000000001",
    sessionID,
    prompt: { text: "fifo-one" },
    delivery: "queue",
  });
  const admittedEvent = await waitForPromptEvent(
    fixture,
    "session.next.prompt.admitted",
    sessionID,
    first.id,
  );
  if (admittedEvent.type !== "session.next.prompt.admitted") {
    throw new Error("unexpected admission event type");
  }
  expect(admittedEvent.data).toMatchObject({
    sessionID,
    messageID: first.id,
    prompt: { text: "fifo-one" },
    delivery: "queue",
  });
  expect(Number.isInteger(admittedEvent.data.timestamp)).toBe(true);
  expect(admittedEvent.durable).toMatchObject({ aggregateID: sessionID, seq: first.admittedSeq });
  await waitForPromptEvent(fixture, "session.next.prompted", sessionID, first.id);
  const firstRequest = await fixture.provider.waitForText("fifo-one");
  expect(JSON.stringify(firstRequest.body)).toContain("fifo-one");
  await expectActivity(fixture, sessionID, true);

  const second = await prompt(fixture, sessionID, "msg_01PHASE0000000000000000002", "fifo-two");
  const third = await prompt(fixture, sessionID, "msg_01PHASE0000000000000000003", "fifo-three");
  expect(first.admittedSeq).toBeLessThan(second.admittedSeq);
  expect(second.admittedSeq).toBeLessThan(third.admittedSeq);
  await waitForPromptEvent(fixture, "session.next.prompt.admitted", sessionID, second.id);
  await waitForPromptEvent(fixture, "session.next.prompt.admitted", sessionID, third.id);
  firstRequest.release();
  await waitForStepEnd(fixture, sessionID);
  await waitForPromptEvent(fixture, "session.next.prompted", sessionID, second.id);
  const secondRequest = await fixture.provider.waitForText("fifo-two", firstRequest.sequence);
  secondRequest.release();
  await waitForStepEnd(fixture, sessionID);
  await waitForPromptEvent(fixture, "session.next.prompted", sessionID, third.id);
  const thirdRequest = await fixture.provider.waitForText("fifo-three", secondRequest.sequence);
  thirdRequest.release();
  await waitForStepEnd(fixture, sessionID);
  await expectActivity(fixture, sessionID, false);
  expect(firstRequest.sequence).toBeLessThan(secondRequest.sequence);
  expect(secondRequest.sequence).toBeLessThan(thirdRequest.sequence);

  const events = await history(fixture, sessionID);
  const promoted = [first, second, third].map((item) => promptEvents(events, item.id)[1]?.seq);
  if (promoted.some((sequence) => sequence === undefined)) throw new Error("FIFO promotion absent");
  expect(promoted[0]).toBeLessThan(promoted[1] as number);
  expect(promoted[1]).toBeLessThan(promoted[2] as number);
  const starts = events.filter((event) => event.type === "session.next.step.started");
  expect(starts).toHaveLength(3);
  expect(starts.every((event) => !("messageID" in event.data))).toBe(true);
}

async function proveActiveSteer(fixture: LiveFixture): Promise<void> {
  const sessionID = await createV2Session(
    fixture,
    "ses_01PHASE0000000000000000003",
    "Phase zero steer",
  );
  const base = await prompt(fixture, sessionID, "msg_01PHASE0000000000000000004", "steer-base");
  await waitForPromptEvent(fixture, "session.next.prompted", sessionID, base.id);
  const baseRequest = await fixture.provider.waitForText("steer-base");
  await expectActivity(fixture, sessionID, true);
  const steered = await prompt(
    fixture,
    sessionID,
    "msg_01PHASE0000000000000000005",
    "active-steer",
    "steer",
  );
  expect(steered.delivery).toBe("steer");
  await waitForPromptEvent(fixture, "session.next.prompt.admitted", sessionID, steered.id);
  baseRequest.release();
  await waitForStepEnd(fixture, sessionID);
  await waitForPromptEvent(fixture, "session.next.prompted", sessionID, steered.id);
  const steerRequest = await fixture.provider.waitForText("active-steer", baseRequest.sequence);
  steerRequest.release();
  await waitForStepEnd(fixture, sessionID);
  await expectActivity(fixture, sessionID, false);
}

async function proveSteerRace(fixture: LiveFixture): Promise<void> {
  const sessionID = await createV2Session(
    fixture,
    "ses_01PHASE0000000000000000004",
    "Phase zero race",
  );
  const base = await prompt(fixture, sessionID, "msg_01PHASE0000000000000000006", "race-base");
  await waitForPromptEvent(fixture, "session.next.prompted", sessionID, base.id);
  const baseRequest = await fixture.provider.waitForText("race-base");
  await expectActivity(fixture, sessionID, true);
  const entered = deferred();
  const requestGate = deferred();
  const gatedFetch: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === `/api/session/${sessionID}/prompt`) {
        entered.release();
        await requestGate.promise;
      }
      return fetch(input, init);
    },
    { preconnect: fetch.preconnect },
  );
  const raceClient = createOpencodeClient({
    baseUrl: fixture.baseUrl,
    directory: fixture.isolation.project,
    fetch: gatedFetch,
  });
  const raced = raceClient.v2.session.prompt({
    sessionID,
    id: "msg_01PHASE0000000000000000007",
    prompt: { text: "raced-steer" },
    delivery: "steer",
    resume: true,
  });
  await entered.promise;
  baseRequest.release();
  await waitForStepEnd(fixture, sessionID);
  await expectActivity(fixture, sessionID, false);
  requestGate.release();
  const raceResult = await raced;
  expect(raceResult.response.status).toBe(200);
  const admission = successful(raceResult, "raced steer").data;
  expect(admission.delivery).toBe("steer");
  await waitForPromptEvent(fixture, "session.next.prompt.admitted", sessionID, admission.id);
  await waitForPromptEvent(fixture, "session.next.prompted", sessionID, admission.id);
  const raceRequest = await fixture.provider.waitForText("raced-steer", baseRequest.sequence);
  await expectActivity(fixture, sessionID, true);
  raceRequest.release();
  await waitForStepEnd(fixture, sessionID);
  await expectActivity(fixture, sessionID, false);
}

async function proveInterruptAndQueueSurvival(fixture: LiveFixture): Promise<void> {
  const sessionID = await createV2Session(
    fixture,
    "ses_01PHASE0000000000000000005",
    "Phase zero interrupt",
  );
  expect((await fixture.client.v2.session.interrupt({ sessionID })).response.status).toBe(204);
  const base = await prompt(fixture, sessionID, "msg_01PHASE0000000000000000008", "interrupt-base");
  await waitForPromptEvent(fixture, "session.next.prompted", sessionID, base.id);
  const baseRequest = await fixture.provider.waitForText("interrupt-base");
  await expectActivity(fixture, sessionID, true);
  const survivorA = await prompt(
    fixture,
    sessionID,
    "msg_01PHASE0000000000000000009",
    "survivor-one",
  );
  const survivorB = await prompt(
    fixture,
    sessionID,
    "msg_01PHASE0000000000000000010",
    "survivor-two",
  );
  await waitForPromptEvent(fixture, "session.next.prompt.admitted", sessionID, survivorA.id);
  await waitForPromptEvent(fixture, "session.next.prompt.admitted", sessionID, survivorB.id);
  expect((await fixture.client.v2.session.interrupt({ sessionID })).response.status).toBe(204);
  await baseRequest.waitForCancellation();
  await expectActivity(fixture, sessionID, false);

  const trigger = await prompt(
    fixture,
    sessionID,
    "msg_01PHASE0000000000000000011",
    "survival-trigger",
  );
  await waitForPromptEvent(fixture, "session.next.prompt.admitted", sessionID, trigger.id);
  await waitForPromptEvent(fixture, "session.next.prompted", sessionID, survivorA.id);
  const first = await fixture.provider.waitForText("survivor-one", baseRequest.sequence);
  first.release();
  await waitForStepEnd(fixture, sessionID);
  await waitForPromptEvent(fixture, "session.next.prompted", sessionID, survivorB.id);
  const second = await fixture.provider.waitForText("survivor-two", first.sequence);
  second.release();
  await waitForStepEnd(fixture, sessionID);
  await waitForPromptEvent(fixture, "session.next.prompted", sessionID, trigger.id);
  const third = await fixture.provider.waitForText("survival-trigger", second.sequence);
  third.release();
  await waitForStepEnd(fixture, sessionID);
  await expectActivity(fixture, sessionID, false);
  expect(first.sequence).toBeLessThan(second.sequence);
  expect(second.sequence).toBeLessThan(third.sequence);
}

test("proves Phase 0 native session semantics with the exact local SDK and CLI", async () => {
  const fixture = await launchFixture();
  try {
    await proveIdentityAndListing(fixture);
    await proveStatusSeparation(fixture);
    await proveIdleQueueAndFifo(fixture);
    await proveActiveSteer(fixture);
    await proveSteerRace(fixture);
    await proveInterruptAndQueueSurvival(fixture);
    await proveSubscriptionDisposal(fixture);
    expect(successful(await fixture.client.instance.dispose(), "server instance dispose")).toBe(
      true,
    );
  } finally {
    await fixture.close();
  }
});
