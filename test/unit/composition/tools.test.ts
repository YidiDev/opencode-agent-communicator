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
  test("constructs all 20 contracts with strict policy overrides and bounded start limits", async () => {
    const options = {
      stateDirectory: "/var/lib/communicator",
      startupDeadlineMs: 30_000,
      invocationDeadlineMs: Number.MAX_SAFE_INTEGER,
      policies: {
        message: "deny",
        ask: "ask",
        wait: "deny",
        start: "allow",
        exportSelfSanitized: "deny",
        exportCrossSession: "allow",
        exportUnsanitized: "deny",
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
    expect(Object.keys(contracts)).toHaveLength(20);
    expect(Object.isFrozen(contracts)).toBe(true);
    await expect(
      contracts.session_send.execute({} as never, {
        sessionID: "invalid",
        abort: new AbortController().signal,
      }),
    ).rejects.toThrow("overflowed");
  });

  test("stops the owning lifecycle when composed request cleanup reports a workflow fault", async () => {
    const setup = await blockingRequestFixture(async () => ({ kind: "unknown" }));
    const store = openRequestStore({
      workspaceKey: setup.context.workspaceKey,
      nowWallMs: () => Date.now(),
      nowMonotonicMs: () => performance.now(),
    });
    const fencingToken = await store.acquire();
    const events: string[] = [];
    let created: Parameters<typeof store.createPrepared>[0] | undefined;
    const requests = new Proxy(store, {
      get(target, property) {
        if (property === "createPrepared") {
          return async (input: Parameters<typeof store.createPrepared>[0]) => {
            events.push("create");
            created = input;
            return target.createPrepared(input);
          };
        }
        if (property === "claimPrepared") {
          return async () => {
            events.push("claim");
            return Promise.reject(new Error("ambiguous"));
          };
        }
        if (property === "reconcilePreparedClaim") {
          return async () => {
            events.push("reconcile");
            if (!created) throw new Error("Request was not prepared.");
            return {
              outcome: "current_claim",
              request: {
                ...created.request,
                deliveryState: "submitting",
                submittedAtMs: created.request.createdAtMs + 1,
                updatedAtMs: created.request.createdAtMs + 1,
              },
              envelopeJson: created.envelopeJson,
            };
          };
        }
        if (property === "completeDelivery") {
          return async () => {
            events.push("complete");
            return Promise.reject(new Error("completion unavailable"));
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let stopCalls = 0;
    const abort = new AbortController();
    const lifecycle = {
      fencingToken,
      assertReady: () => undefined,
      stop: () => {
        stopCalls += 1;
        abort.abort("lifecycle_stopped");
      },
      scheduler: { wake: () => undefined, drain: async () => undefined },
    };
    const native = {
      readCurrentRoots: setup.ports.membership.readCurrentRoots,
      observeRequestParticipants: setup.ports.activity.observeRequestParticipants,
      steerRequest: setup.ports.nativeSteer.steerRequest,
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
      { sessionID: setup.source, abort: abort.signal },
    );
    const result = await execution;
    expect(events).toEqual(["create", "claim", "reconcile", "complete", "reconcile"]);
    abort.abort("test_complete");
    expect(JSON.parse(result)).toMatchObject({ ok: false });
    expect(stopCalls).toBe(1);
    store.close();
    setup.store.close();
  });

  test("composes a finite maximum-request invocation beyond the durable deadline", async () => {
    const setup = await blockingRequestFixture(async () => {
      throw new Error("invalid arguments must not steer");
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
