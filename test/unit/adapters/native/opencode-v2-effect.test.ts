import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SessionNotFoundError, UnauthorizedError } from "@opencode/protocol/errors";
import { DateTime, Effect } from "effect";
import {
  createOpenCode2NativeAdapter,
  NativeAdapterFault,
  type OpenCodeV2NativeContext,
} from "../../../../src/adapters/native/opencode-2";
import { createOpenCode2HealthPort } from "../../../../src/adapters/native/opencode-2-health";
import { validateNativeMessageId } from "../../../../src/domain/generated-ids";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("Invalid fixture ID.");
  return result.value;
}

const workspace = valid(validateWorkspaceKey("wrk_v2"));
const otherWorkspace = valid(validateWorkspaceKey("wrk_other"));
const source = valid(validateSessionId("ses_source"));
const target = valid(validateSessionId("ses_target"));
const archived = valid(validateSessionId("ses_archived"));
const message = valid(validateNativeMessageId(`msg_${"a".repeat(32)}`));

interface SessionFixture {
  readonly id: string;
  readonly parentID?: string;
  readonly projectID: string;
  readonly agent?: string;
  readonly model?: {
    readonly providerID: string;
    readonly id: string;
    readonly variant?: string | undefined;
  };
  readonly title?: string;
  readonly location: { readonly directory: string };
  readonly time: {
    readonly created: number;
    readonly updated: unknown;
    readonly archived?: unknown;
  };
  readonly cost: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: { readonly read: number; readonly write: number };
  };
}

function session(id: string, overrides: Partial<SessionFixture> = {}): SessionFixture {
  return {
    id,
    projectID: "project",
    title: `Title ${id}`,
    location: { directory: "/workspace" },
    time: { created: 1, updated: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function context(
  calls: Array<{ readonly method: string; readonly input: unknown }>,
  fixtures: Readonly<Record<string, SessionFixture>> = {},
): OpenCodeV2NativeContext {
  return {
    app: { name: "opencode", version: "2.0.26", channel: "stable" },
    session: {
      context: ({ sessionID }) => {
        calls.push({ method: "context", input: { sessionID } });
        return Effect.succeed([]) as never;
      },
      get: ({ sessionID }) => {
        calls.push({ method: "get", input: { sessionID } });
        return Effect.succeed(fixtures[sessionID] ?? session(sessionID)) as never;
      },
      create: (input) => {
        calls.push({ method: "create", input });
        return Effect.succeed(
          session(input?.id ?? "ses_created", {
            ...(input?.agent ? { agent: input.agent } : {}),
            ...(input?.model ? { model: input.model } : {}),
          }),
        ) as never;
      },
      update: (input) => {
        calls.push({ method: "update", input });
        return Effect.void as never;
      },
      prompt: (input) => {
        calls.push({ method: "prompt", input });
        return Effect.succeed({ id: message }) as never;
      },
      interrupt: (input) => {
        calls.push({ method: "interrupt", input });
        return Effect.succeed({ interrupted: true }) as never;
      },
    },
  };
}

function adapter(
  calls: Array<{ readonly method: string; readonly input: unknown }> = [],
  fixtures: Readonly<Record<string, SessionFixture>> = {},
) {
  return createOpenCode2NativeAdapter(
    {
      context: context(calls, fixtures),
      directory: "/workspace",
      projectId: "project",
      workspaceKey: workspace,
    },
    { now: () => 42 },
  );
}

function withSessionOverrides(
  overrides: Partial<OpenCodeV2NativeContext["session"]>,
  now: () => number = () => 42,
) {
  const base = context([], {});
  return createOpenCode2NativeAdapter(
    {
      context: { ...base, session: { ...base.session, ...overrides } },
      directory: "/workspace",
      projectId: "project",
      workspaceKey: workspace,
    },
    { now },
  );
}

const signal = () => new AbortController().signal;

describe("OpenCode v2 Effect health", () => {
  test("proves host identity without opening a transport and honors prior cancellation", async () => {
    const health = createOpenCode2HealthPort(context([], {}));
    expect(await health.readHealth()).toEqual({ healthy: true, version: "2.0.26" });
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(health.readHealth(abort.signal)).rejects.toThrow("cancelled");
  });
});

describe("OpenCode v2 Effect native adapter", () => {
  test("uses only public ID-addressed Effect operations for admissions and lifecycle changes", async () => {
    const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
    const native = adapter(calls, { [target]: session(target, { agent: "build" }) });
    const abort = new AbortController().signal;

    expect(await native.readHealth()).toEqual({ healthy: true, version: "2.0.26" });
    expect(await native.readCurrentRoots(workspace, source, target, abort)).toMatchObject({
      sourceVisible: true,
      targetVisible: true,
    });
    expect(
      await native.queueMessage({
        targetSessionId: target,
        nativeMessageId: message,
        envelope: "untrusted envelope",
        abort,
      }),
    ).toEqual({ kind: "public_message", observedAtMs: 42 });
    expect(await native.interruptSession({ targetSessionId: target, abort })).toBe("interrupted");
    expect(await native.createRootSession({ sessionId: target, agent: "build", abort })).toBe(
      "created",
    );
    expect(await native.reconcileRootSession({ sessionId: target, agent: "build", abort })).toBe(
      "matching",
    );
    expect(await native.updateSessionTitle({ sessionId: target, title: "New", abort })).toBe(
      "updated",
    );
    expect(
      await native.admitInitialMessage({
        sessionId: target,
        nativeMessageId: message,
        message: "Start",
        abort,
      }),
    ).toBe("admitted");

    expect(calls.map(({ method }) => method)).toEqual([
      "get",
      "get",
      "prompt",
      "interrupt",
      "create",
      "get",
      "update",
      "prompt",
    ]);
    expect(calls.filter(({ method }) => method === "prompt").map(({ input }) => input)).toEqual([
      {
        sessionID: target,
        id: message,
        text: "untrusted envelope",
        delivery: "queue",
        resume: true,
      },
      { sessionID: target, id: message, text: "Start", delivery: "queue", resume: true },
    ]);
  });

  test("revalidates registry candidates authoritatively, including archived roots", async () => {
    const native = adapter([], {
      [archived]: session(archived, {
        time: { created: 1, updated: DateTime.makeUnsafe(21), archived: 9 },
      }),
    });
    expect(await native.revalidateRoot(workspace, archived)).toEqual({
      id: archived,
      title: `Title ${archived}`,
      updatedAtMs: 21,
      isArchived: true,
      status: "unknown",
      observedAtMs: 42,
    });
    expect(await native.readParticipantPresence(archived, new AbortController().signal)).toBe(
      "unknown",
    );
  });

  test("rejects cross-workspace observations and omits non-root or mismatched host results", async () => {
    const native = adapter([], {
      [target]: session(target, { parentID: source }),
      [archived]: session(source),
    });
    await expect(native.readCurrentRoots(otherWorkspace, source, target)).rejects.toBeInstanceOf(
      NativeAdapterFault,
    );
    expect(await native.revalidateRoot(workspace, target)).toBeUndefined();
    expect(await native.revalidateRoot(workspace, archived)).toBeUndefined();
  });

  test("fails closed for unavailable public-v2 evidence and unsupported capabilities", async () => {
    const native = adapter();
    expect(await native.readVisibleRoots(false)).toEqual([]);
    expect(
      await native.steerRequest({
        targetSessionId: target,
        nativeMessageId: message,
        envelope: "untrusted envelope",
        abort: new AbortController().signal,
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      await native.isEligibleContextTarget({
        workspaceKey: workspace,
        sessionId: target,
        abort: new AbortController().signal,
      }),
    ).toBeFalse();
    expect(
      await native.readMessagePage({
        workspaceKey: workspace,
        sessionId: target,
        order: "desc",
        abort: new AbortController().signal,
      }),
    ).toMatchObject({ messages: [], nextCursor: null });
  });

  test("keeps ambiguous host read failures explicit instead of treating them as absence", async () => {
    const failing = context([], {});
    const native = createOpenCode2NativeAdapter({
      context: {
        ...failing,
        session: {
          ...failing.session,
          get: () => Effect.fail(new Error("host unavailable")) as never,
        },
      },
      directory: "/workspace",
      projectId: "project",
      workspaceKey: workspace,
    });
    await expect(native.readCurrentRoots(workspace, source, target)).rejects.toThrow(
      "host unavailable",
    );
    await expect(native.revalidateRoot(workspace, target)).rejects.toThrow("host unavailable");
  });

  test("maps only the typed public session-not-found failure to absent presence", async () => {
    const presenceFor = (error: unknown) =>
      withSessionOverrides({ get: () => Effect.fail(error) as never }).readParticipantPresence(
        target,
        signal(),
      );

    expect(
      await presenceFor(
        new SessionNotFoundError({ sessionID: target, message: "Session does not exist." }),
      ),
    ).toBe("absent");
    expect(await presenceFor(new UnauthorizedError({ message: "Denied." }))).toBe("unknown");
    expect(await presenceFor(new Error("host unavailable"))).toBe("unknown");
  });
});

describe("OpenCode v2 Effect native adapter identity", () => {
  test("treats typed not-found reads as absence without hiding other host failures", async () => {
    const missing = withSessionOverrides({
      get: ({ sessionID }) =>
        Effect.fail(
          new SessionNotFoundError({ sessionID, message: "Session does not exist." }),
        ) as never,
    });

    expect(await missing.readCurrentRoots(workspace, source, target)).toEqual({
      sourceVisible: false,
      targetVisible: false,
      sourceTitle: undefined,
    });
    expect(await missing.revalidateRoot(workspace, target)).toBeUndefined();
  });

  test("creates and reconciles exact agent and model overrides", async () => {
    const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
    const native = adapter(calls, {
      [target]: session(target, {
        agent: "build",
        model: { providerID: "provider", id: "model", variant: "fast" },
      }),
    });
    const overrides = {
      sessionId: target,
      agent: "build",
      model: "provider/model#fast",
      abort: signal(),
    };

    expect(await native.createRootSession(overrides)).toBe("created");
    expect(await native.reconcileRootSession(overrides)).toBe("matching");
    expect(
      await native.admitInitialMessage({
        ...overrides,
        nativeMessageId: message,
        message: "Start",
      }),
    ).toBe("admitted");
    expect(calls.find(({ method }) => method === "create")?.input).toMatchObject({
      agent: "build",
      model: { providerID: "provider", id: "model", variant: "fast" },
    });
  });

  test("reports a fixed-id creation collision when returned override identity differs", async () => {
    const native = withSessionOverrides({
      create: () =>
        Effect.succeed(
          session(target, {
            agent: "other",
            model: { providerID: "provider", id: "other" },
          }),
        ) as never,
    });

    expect(
      await native.createRootSession({
        sessionId: target,
        agent: "build",
        model: "provider/model",
        abort: signal(),
      }),
    ).toBe("collision");
  });

  test("binds opaque pagination cursors to one mutable current-context snapshot", async () => {
    let current = Array.from({ length: 9 }, (_, index) => ({
      id: `msg_${index}`,
      type: "user",
      text: `private ${index}`,
    }));
    const base = context([], {});
    const native = createOpenCode2NativeAdapter({
      context: {
        ...base,
        session: {
          ...base.session,
          context: () => Effect.succeed(current) as never,
        },
      },
      directory: "/workspace",
      projectId: "project",
      workspaceKey: workspace,
    });
    const first = await native.readMessagePage({
      workspaceKey: workspace,
      sessionId: target,
      order: "desc",
      abort: new AbortController().signal,
    });
    expect(first.messages).toHaveLength(8);
    expect(first.messages.every((item) => item.type === "user" && !("text" in item))).toBeTrue();
    expect(first.nextCursor).not.toBeNull();
    current = [...current, { id: "msg_changed", type: "user", text: "private changed" }];
    await expect(
      native.readMessagePage({
        workspaceKey: workspace,
        sessionId: target,
        cursor: first.nextCursor as string,
        abort: new AbortController().signal,
      }),
    ).rejects.toThrow("snapshot changed");
  });
});

describe("OpenCode v2 Effect native adapter reads", () => {
  test("reports workspace membership, titles, presence, and conservative activity", async () => {
    const { title: _title, ...sourceWithoutTitle } = session(source);
    const native = adapter([], {
      [source]: sourceWithoutTitle,
      [target]: session(target),
    });
    expect(await native.readCurrentRoots(workspace, source, target)).toEqual({
      sourceVisible: true,
      targetVisible: true,
      sourceTitle: undefined,
    });
    if (!native.observeSessionReadPresence) throw new Error("Missing fixture capability.");
    const observe = native.observeSessionReadPresence;
    const presence = await observe(workspace, source, target, signal());
    expect(presence as unknown).toEqual({
      sourceVisible: true,
      targetVisible: true,
      targetStatus: "unknown",
      observedAtMs: 42,
    });
    expect(await native.observeRequestParticipants(workspace, source, target, signal())).toEqual({
      sourceVisible: true,
      targetVisible: true,
      targetStatus: "unknown",
    });
    expect(
      await native.observeParticipantActivities(workspace, [source, target], signal()),
    ).toEqual([
      { sessionId: source, activity: "unknown" },
      { sessionId: target, activity: "unknown" },
    ]);
    expect(await native.readParticipantPresence(target, signal())).toBe("present");
    await expect(
      native.observeParticipantActivities(otherWorkspace, [], signal()),
    ).rejects.toBeInstanceOf(NativeAdapterFault);
  });

  test("fails closed on malformed IDs and timestamps", async () => {
    const malformedId = "bad id" as typeof target;
    const native = adapter([], {
      [target]: session(target, { time: { created: 1, updated: -1 } }),
    });
    await expect(native.readCurrentRoots(workspace, malformedId, target)).rejects.toBeInstanceOf(
      NativeAdapterFault,
    );
    await expect(native.revalidateRoot(workspace, target)).rejects.toThrow("timestamps");

    const malformedObservedAt = adapter([], {
      [target]: session(target, { time: { created: 1, updated: null } }),
    });
    await expect(malformedObservedAt.revalidateRoot(workspace, target)).rejects.toThrow(
      "timestamps",
    );
    const malformedEpoch = adapter([], {
      [target]: session(target, { time: { created: 1, updated: DateTime.makeUnsafe(-1) } }),
    });
    await expect(malformedEpoch.revalidateRoot(workspace, target)).rejects.toThrow("timestamps");
    const badNow = withSessionOverrides({}, () => -1);
    await expect(badNow.revalidateRoot(workspace, target)).rejects.toThrow("timestamps");

    const mismatchedId = adapter([], {
      [target]: session("bad id", { time: { created: 1, updated: 2 } }),
    });
    expect(await mismatchedId.revalidateRoot(workspace, target)).toBeUndefined();

    const { title: _title, ...withoutTitle } = session(target);
    expect(
      await adapter([], { [target]: withoutTitle }).revalidateRoot(workspace, target),
    ).toMatchObject({
      title: "",
    });
  });
});

describe("OpenCode v2 Effect native adapter context reads", () => {
  test("rejects malformed, noncanonical, stale, and out-of-range cursors", async () => {
    const native = adapter();
    const encode = (value: unknown) =>
      btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const malformed = [
      "",
      "!",
      "a".repeat(513),
      "a",
      encode(null),
      encode([]),
      encode({ version: 1, snapshotSha256: "0".repeat(64), extra: 0, endExclusive: 0 }),
      encode({ version: 2, snapshotSha256: "0".repeat(64), endExclusive: 0 }),
      encode({ version: 1, snapshotSha256: "no", endExclusive: 0 }),
      encode({ version: 1, snapshotSha256: "0".repeat(64), endExclusive: -1 }),
      `${encode({ version: 1, snapshotSha256: "0".repeat(64), endExclusive: 0 })}=`,
    ];
    for (const cursor of malformed) {
      await expect(
        native.readMessagePage({
          workspaceKey: workspace,
          sessionId: target,
          cursor,
          abort: signal(),
        }),
      ).rejects.toThrow("cursor");
    }

    const first = await native.readMessagePage({
      workspaceKey: workspace,
      sessionId: target,
      order: "desc",
      abort: signal(),
    });
    const outOfRange = encode({
      version: 1,
      snapshotSha256: createHash("sha256").update("[]").digest("hex"),
      endExclusive: first.messages.length + 1,
    });
    await expect(
      native.readMessagePage({
        workspaceKey: workspace,
        sessionId: target,
        cursor: outOfRange,
        abort: signal(),
      }),
    ).rejects.toThrow("snapshot changed");
  });

  test("reads found and missing messages with exact assistant byte accounting and bounds", async () => {
    const projected = [
      { id: "user", type: "user", text: "private" },
      {
        id: "assistant",
        type: "assistant",
        content: [
          { type: "text", text: "é" },
          { type: "tool", id: "tool", name: "read", state: { status: "completed" } },
        ],
      },
    ];
    const native = withSessionOverrides({ context: () => Effect.succeed(projected) as never });
    const page = await native.readMessagePage({
      workspaceKey: workspace,
      sessionId: target,
      order: "desc",
      abort: signal(),
    });
    expect(page).toMatchObject({
      examinedMessageCount: 2,
      examinedPartCount: 2,
      projectedTextByteCount: 2,
    });
    expect(page.examinedMessageIds).toEqual(["assistant", "user"]);

    expect(
      await native.readMessage({
        workspaceKey: workspace,
        sessionId: target,
        messageId: "missing",
        abort: signal(),
      }),
    ).toMatchObject({ kind: "not_found" });
    expect(
      await native.readMessage({
        workspaceKey: workspace,
        sessionId: target,
        messageId: "user",
        abort: signal(),
      }),
    ).toMatchObject({ kind: "found", projectedTextByteCount: 0, examinedPartCount: 0 });
    expect(
      await native.readMessage({
        workspaceKey: workspace,
        sessionId: target,
        messageId: "assistant",
        abort: signal(),
      }),
    ).toMatchObject({ kind: "found", projectedTextByteCount: 2, examinedPartCount: 2 });
    await expect(
      native.readMessagePage({
        workspaceKey: workspace,
        sessionId: target,
        order: "desc",
        maximumResponseBytes: 1,
        abort: signal(),
      }),
    ).rejects.toThrow("snapshot exceeds");
    await expect(
      native.readMessage({
        workspaceKey: workspace,
        sessionId: target,
        messageId: "assistant",
        maximumResponseBytes: 1,
        abort: signal(),
      }),
    ).rejects.toThrow("snapshot exceeds");
    await expect(
      native.readMessage({
        workspaceKey: otherWorkspace,
        sessionId: target,
        messageId: "user",
        abort: signal(),
      }),
    ).rejects.toBeInstanceOf(NativeAdapterFault);
  });
});

describe("OpenCode v2 Effect native adapter cancellation", () => {
  test("does not begin effects after cancellation or for malformed model evidence", async () => {
    const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
    const native = adapter(calls);
    const abort = new AbortController();
    abort.abort();
    expect(
      await native.queueMessage({
        targetSessionId: target,
        nativeMessageId: message,
        envelope: "private",
        abort: abort.signal,
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      await native.createRootSession({
        sessionId: target,
        model: "malformed",
        abort: new AbortController().signal,
      }),
    ).toBe("definitive_rejection");
    expect(calls).toEqual([]);
  });

  test("maps host failures and cancellation races to conservative outcomes", async () => {
    const failure = Effect.fail(new Error("host failed")) as never;
    const failed = withSessionOverrides({
      prompt: () => failure,
      interrupt: () => failure,
      create: () => failure,
      update: () => failure,
    });
    expect(
      await failed.queueMessage({
        targetSessionId: target,
        nativeMessageId: message,
        envelope: "x",
        abort: signal(),
      }),
    ).toEqual({ kind: "unknown" });
    expect(await failed.interruptSession({ targetSessionId: target, abort: signal() })).toBe(
      "unknown",
    );
    expect(await failed.createRootSession({ sessionId: target, abort: signal() })).toBe("unknown");
    expect(
      await failed.updateSessionTitle({ sessionId: target, title: "x", abort: signal() }),
    ).toBe("unknown");
    expect(
      await failed.admitInitialMessage({
        sessionId: target,
        nativeMessageId: message,
        message: "x",
        abort: signal(),
      }),
    ).toBe("unknown");

    for (const operation of ["prompt", "interrupt", "create", "update"] as const) {
      const abort = new AbortController();
      const race = withSessionOverrides({
        [operation]: (() => {
          abort.abort();
          if (operation === "interrupt") return Effect.succeed({ interrupted: true });
          if (operation === "create") return Effect.succeed(session(target));
          return Effect.void;
        }) as never,
      });
      const outcome =
        operation === "prompt"
          ? await race.queueMessage({
              targetSessionId: target,
              nativeMessageId: message,
              envelope: "x",
              abort: abort.signal,
            })
          : operation === "interrupt"
            ? await race.interruptSession({ targetSessionId: target, abort: abort.signal })
            : operation === "create"
              ? await race.createRootSession({ sessionId: target, abort: abort.signal })
              : await race.updateSessionTitle({
                  sessionId: target,
                  title: "x",
                  abort: abort.signal,
                });
      expect(operation === "prompt" ? outcome : { kind: outcome }).toEqual(
        operation === "prompt" ? { kind: "unknown" } : { kind: "unknown" },
      );
    }

    const admissionAbort = new AbortController();
    const cancelledAdmission = withSessionOverrides({
      prompt: (() => {
        admissionAbort.abort();
        return Effect.void;
      }) as never,
    });
    expect(
      await cancelledAdmission.admitInitialMessage({
        sessionId: target,
        nativeMessageId: message,
        message: "x",
        abort: admissionAbort.signal,
      }),
    ).toBe("unknown");
  });

  test("covers create, reconcile, title, and admission rejection outcomes", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const native = adapter([], {
      [target]: session(target, { agent: "build" }),
      [archived]: session(archived, { time: { created: 1, updated: 2, archived: 3 } }),
    });
    expect(await native.interruptSession({ targetSessionId: target, abort: aborted.signal })).toBe(
      "unknown",
    );
    expect(
      await native.updateSessionTitle({ sessionId: target, title: "x", abort: aborted.signal }),
    ).toBe("unknown");
    expect(
      await native.reconcileRootSession({ sessionId: target, model: "p/m", abort: signal() }),
    ).toBe("collision");
    expect(
      await native.reconcileRootSession({ sessionId: target, agent: "other", abort: signal() }),
    ).toBe("collision");
    expect(await native.reconcileRootSession({ sessionId: archived, abort: signal() })).toBe(
      "absent",
    );
    expect(
      await native.admitInitialMessage({
        sessionId: target,
        nativeMessageId: message,
        message: "x",
        model: "p/m",
        abort: signal(),
      }),
    ).toBe("admitted");
    expect(
      await native.admitInitialMessage({
        sessionId: target,
        nativeMessageId: message,
        message: "x",
        agent: "build",
        abort: signal(),
      }),
    ).toBe("admitted");

    const malformedCreate = withSessionOverrides({
      create: () => Effect.succeed(session(source)) as never,
    });
    expect(await malformedCreate.createRootSession({ sessionId: target, abort: signal() })).toBe(
      "unknown",
    );
  });
});
