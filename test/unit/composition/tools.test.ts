import { afterEach, describe, expect, test } from "bun:test";
import { ParticipantOperationGate } from "../../../src/application/participant-operation-gate";
import type { CommunicatorOptions } from "../../../src/composition/config";
import { communicatorToolIds, constructToolContracts } from "../../../src/composition/tools";
import { blockingRequestDeadlineMarginMs } from "../../../src/domain/request-constants";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { blockingRequestFixture } from "../../support/blocking-request-fixture";
import { cleanupRequestStoreRoots, openRequestStore } from "../../support/request-store";

const parsedWorkspace = validateWorkspaceKey("workspace:tool-construction");
if (!parsedWorkspace.ok) throw new Error("Invalid workspace fixture.");

afterEach(cleanupRequestStoreRoots);

describe("atomic communicator tool construction", () => {
  test("constructs all 21 contracts with strict policy overrides and bounded start limits", async () => {
    const options = {
      stateDirectory: "/var/lib/communicator",
      startupDeadlineMs: 30_000,
      invocationDeadlineMs: Number.MAX_SAFE_INTEGER,
      policies: {
        message: "deny",
        ask: "allow",
        wait: "deny",
        start: "allow",
        exportSelfSanitized: "deny",
        exportCrossSession: "allow",
        readCrossSession: "allow",
        stop: "allow",
        exportOverwrite: "allow",
      },
      start: {
        allowedAgents: ["build"],
        allowedModels: ["provider/model"],
        allowManagedSessionRecursion: true,
        limits: {
          managedSessionsPerWorkspace: 2,
          startsPerSourceWindow: 3,
          startsPerWorkspaceWindow: 4,
          rateWindowMs: 5,
        },
      },
    } satisfies CommunicatorOptions;
    const lifecycle = {
      fencingToken: 1 as never,
      assertReady: () => undefined,
      stop: () => undefined,
      scheduler: {},
    };
    const contracts = constructToolContracts({
      options,
      workspaceKey: parsedWorkspace.value,
      native: {} as never,
      store: { starts: {} } as never,
      runtime: {} as never,
      lifecycle: lifecycle as never,
      participantOperations: new ParticipantOperationGate(),
      exporter: { writeExport: async () => ({ ok: false, code: "export_unavailable" }) },
    });
    expect(Object.keys(contracts)).toEqual([...communicatorToolIds]);
    expect(Object.keys(contracts)).toHaveLength(21);
    expect(Object.isFrozen(contracts)).toBe(true);
    await expect(
      contracts.session_send.execute({} as never, {
        sessionID: "invalid",
        abort: new AbortController().signal,
      }),
    ).rejects.toThrow("overflowed");
  });

  test("fails closed on ambiguous queue request creation without manufacturing a native workflow fault", async () => {
    const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
    const store = openRequestStore({
      workspaceKey: setup.context.workspaceKey,
      nowWallMs: () => Date.now(),
      nowMonotonicMs: () => performance.now(),
    });
    const fencingToken = await store.acquire();
    const events: string[] = [];
    const requests = new Proxy(store, {
      get(target, property) {
        if (property === "createPrepared") {
          return async () => {
            events.push("create");
            return Promise.reject(new Error("ambiguous"));
          };
        }
        if (property === "reconcilePreparedCreation") {
          return async () => {
            events.push("reconcile");
            return { outcome: "absent" };
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let stopCalls = 0;
    const lifecycle = {
      fencingToken,
      assertReady: () => undefined,
      stop: () => {
        stopCalls += 1;
      },
      scheduler: { wake: () => undefined, drain: async () => undefined },
    };
    const native = {
      readCurrentRoots: setup.ports.membership.readCurrentRoots,
      observeRequestParticipants: setup.ports.activity.observeRequestParticipants,
      steerRequest: setup.ports.nativeSteer.steerRequest,
      queueMessage: setup.ports.nativeQueue.queueMessage,
    };
    const contracts = constructToolContracts({
      options: {
        stateDirectory: "/unused",
        startupDeadlineMs: 30_000,
        invocationDeadlineMs: 50,
      },
      workspaceKey: setup.context.workspaceKey,
      native: native as never,
      store: requests,
      runtime: setup.runtime,
      contextRuntime: setup.contextRuntime,
      lifecycle: lifecycle as never,
      participantOperations: setup.ports.participantOperations,
      exporter: { writeExport: async () => ({ ok: false, code: "export_unavailable" }) },
    });
    const execution = contracts.session_ask.execute(
      {
        session_id: setup.target,
        questions: [{ prompt: "Proceed?", options: ["yes"] }],
        timeout_seconds: 30,
      },
      { sessionID: setup.source, abort: new AbortController().signal },
    );
    const result = await execution;
    expect(events).toEqual(["create", "reconcile", "create", "reconcile"]);
    expect(JSON.parse(result)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    expect(stopCalls).toBe(0);
    store.close();
    setup.store.close();
  });

  test("composes a finite maximum-request invocation beyond the durable deadline", async () => {
    const setup = await blockingRequestFixture(async () => {
      throw new Error("invalid arguments must not queue");
    });
    const nowMs = 200_000;
    const delays: number[] = [];
    const contracts = constructToolContracts({
      options: {
        stateDirectory: "/unused",
        startupDeadlineMs: 30_000,
        invocationDeadlineMs: 3_600_000,
      },
      workspaceKey: setup.context.workspaceKey,
      native: {} as never,
      store: { starts: {} } as never,
      runtime: setup.runtime,
      lifecycle: {
        fencingToken: setup.token,
        assertReady: () => undefined,
        stop: () => undefined,
        scheduler: {},
      } as never,
      participantOperations: setup.ports.participantOperations,
      exporter: { writeExport: async () => ({ ok: false, code: "export_unavailable" }) },
      clock: { nowMs: () => nowMs },
      blockingTimers: {
        arm: (delayMs) => {
          delays.push(delayMs);
          return { cancel: () => undefined };
        },
      },
    });

    const result = await contracts.session_wait.execute(
      { session_id: "invalid", milestone: "maximum", timeout_seconds: 3_600 },
      { sessionID: setup.source, abort: new AbortController().signal },
    );

    expect(JSON.parse(result)).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(delays[0]).toBe(3_600_000 + blockingRequestDeadlineMarginMs * 2);
    expect(nowMs + (delays[0] as number)).toBeGreaterThan(
      nowMs + 3_600_000 + blockingRequestDeadlineMarginMs,
    );
    setup.store.close();
  });
});
