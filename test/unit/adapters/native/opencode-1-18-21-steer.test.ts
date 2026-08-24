import { describe, expect, test } from "bun:test";

import {
  createOpenCode11821NativeAdapter,
  type OpenCodeNativeAdapterDependencies,
} from "../../../../src/adapters/native/opencode-1-18-21";
import { validateNativeMessageId } from "../../../../src/domain/generated-ids";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("invalid steer fixture");
  return result.value;
}

const targetSessionId = valid(validateSessionId("ses_steertarget"));
const nativeMessageId = valid(validateNativeMessageId(`msg_${"c".repeat(32)}`));
const workspaceKey = valid(validateWorkspaceKey("workspace:steer"));
const verifiedEnvelope = '{"verified":"steer"}';

function successData(replacement: Record<string, unknown> = {}): unknown {
  return {
    data: {
      data: {
        admittedSeq: 8,
        id: nativeMessageId,
        sessionID: targetSessionId,
        prompt: { text: verifiedEnvelope },
        delivery: "steer",
        timeCreated: 1234,
        ...replacement,
      },
    },
  };
}

interface FixtureOptions {
  readonly response?: unknown;
  readonly throwTransport?: boolean;
  readonly beforeReturn?: () => void;
  readonly now?: () => number;
}

function fixture(options: FixtureOptions = {}) {
  const promptCalls: unknown[][] = [];
  const dependencies: OpenCodeNativeAdapterDependencies = {
    now: options.now ?? (() => 7000),
    createV2Client: () => ({
      global: { health: async () => ({ data: { healthy: true } }) },
      v2: {
        session: {
          active: async () => ({ data: { data: {} } }),
          list: async () => ({ data: { data: [], cursor: {} } }),
          async prompt(input, requestOptions): Promise<unknown> {
            promptCalls.push([input, requestOptions]);
            if (options.throwTransport) throw new Error("private transport cause");
            options.beforeReturn?.();
            return "response" in options ? options.response : successData();
          },
        },
      },
    }),
  };
  const adapter = createOpenCode11821NativeAdapter(
    {
      client: {
        experimental: { session: { list: async () => ({ data: [] }) } },
        session: { status: async () => ({ data: {} }) },
      },
      directory: "/workspace",
      serverUrl: new URL("http://127.0.0.1:4321/"),
      workspaceKey,
    },
    dependencies,
  );
  return { adapter, promptCalls };
}

function request(abort = new AbortController().signal) {
  return { targetSessionId, nativeMessageId, envelope: verifiedEnvelope, abort };
}

describe("OpenCode 1.18.21 native steer admission", () => {
  test("makes the exact pinned steer call once and accepts native admitted evidence", async () => {
    const controller = new AbortController();
    const fake = fixture();
    expect(await fake.adapter.steerRequest(request(controller.signal))).toEqual({
      kind: "admitted",
      admittedSeq: 8,
      observedAtMs: 1234,
    });
    expect(fake.promptCalls).toEqual([
      [
        {
          sessionID: targetSessionId,
          id: nativeMessageId,
          prompt: { text: verifiedEnvelope },
          delivery: "steer",
          resume: true,
        },
        { signal: controller.signal },
      ],
    ]);
  });

  test("accepts safely ordered promotion and uses the safe clock only when native time is absent", async () => {
    const fake = fixture({
      response: {
        data: {
          data: {
            admittedSeq: 8,
            promotedSeq: 11,
            id: nativeMessageId,
            sessionID: targetSessionId,
            prompt: { text: verifiedEnvelope },
            delivery: "steer",
          },
        },
      },
    });
    expect(await fake.adapter.steerRequest(request())).toEqual({
      kind: "promoted",
      admittedSeq: 8,
      promotedSeq: 11,
      observedAtMs: 7000,
    });
  });

  test.each([
    ["queue delivery", { delivery: "queue" }],
    ["target session", { sessionID: "ses_other" }],
    ["caller message ID", { id: `msg_${"d".repeat(32)}` }],
    ["verified prompt", { prompt: { text: "different" } }],
    ["negative admission sequence", { admittedSeq: -1 }],
    ["fractional admission sequence", { admittedSeq: 1.5 }],
    ["unsafe admission sequence", { admittedSeq: Number.MAX_SAFE_INTEGER + 1 }],
    ["equal promotion sequence", { promotedSeq: 8 }],
    ["earlier promotion sequence", { promotedSeq: 7 }],
    ["unsafe promotion sequence", { promotedSeq: Number.MAX_SAFE_INTEGER + 1 }],
    ["invalid native time", { timeCreated: Number.NaN }],
    ["negative native time", { timeCreated: -1 }],
    ["fractional native time", { timeCreated: 1.5 }],
    ["unsafe native time", { timeCreated: Number.MAX_SAFE_INTEGER + 1 }],
    ["infinite native time", { timeCreated: Number.POSITIVE_INFINITY }],
  ])("returns unknown for mismatched or unsafe %s evidence", async (_label, replacement) => {
    const fake = fixture({ response: successData(replacement) });
    expect(await fake.adapter.steerRequest(request())).toEqual({ kind: "unknown" });
    expect(fake.promptCalls).toHaveLength(1);
  });

  test.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "returns unknown when absent native time cannot use unsafe clock %s",
    async (clockValue) => {
      const response = successData();
      if (
        typeof response !== "object" ||
        response === null ||
        typeof Reflect.get(response, "data") !== "object"
      ) {
        throw new Error("invalid internal fixture");
      }
      const outer = Reflect.get(response, "data") as { data: Record<string, unknown> };
      delete outer.data.timeCreated;
      const fake = fixture({ response, now: () => clockValue });
      expect(await fake.adapter.steerRequest(request())).toEqual({ kind: "unknown" });
    },
  );

  test.each([
    ["outer envelope", null],
    ["outer error", { error: { secret: "hidden" }, data: { data: {} } }],
    ["nested 1.18.21 envelope", { data: { admittedSeq: 8 } }],
    ["nested data", { data: { data: null } }],
  ])("returns unknown for malformed %s", async (_label, response) => {
    const fake = fixture({ response });
    expect(await fake.adapter.steerRequest(request())).toEqual({ kind: "unknown" });
  });

  test("does not call native transport when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller-only cause"));
    const fake = fixture({ response: new Response(null, { status: 400 }) });
    expect(await fake.adapter.steerRequest(request(controller.signal))).toEqual({
      kind: "unknown",
    });
    expect(fake.promptCalls).toHaveLength(0);
  });

  test("keeps completed correlated success authoritative across an abort race", async () => {
    const controller = new AbortController();
    const fake = fixture({
      beforeReturn: () => controller.abort(),
      response: successData({ promotedSeq: 9 }),
    });
    expect(await fake.adapter.steerRequest(request(controller.signal))).toEqual({
      kind: "promoted",
      admittedSeq: 8,
      promotedSeq: 9,
      observedAtMs: 1234,
    });
  });

  test("keeps success authoritative when abort occurs while reading completed response evidence", async () => {
    const controller = new AbortController();
    const data = {
      admittedSeq: 8,
      id: nativeMessageId,
      sessionID: targetSessionId,
      prompt: { text: verifiedEnvelope },
      delivery: "steer",
      get timeCreated() {
        controller.abort();
        return 44;
      },
    };
    const fake = fixture({ response: { data: { data } } });
    expect(await fake.adapter.steerRequest(request(controller.signal))).toEqual({
      kind: "admitted",
      admittedSeq: 8,
      observedAtMs: 44,
    });
  });

  test("classifies only a known structured non-aborted 4xx response as definitive", async () => {
    const rejected = fixture({
      response: {
        error: { _tag: "InvalidRequestError", message: "invalid prompt" },
        response: new Response(null, { status: 400 }),
      },
    });
    expect(await rejected.adapter.steerRequest(request())).toEqual({
      kind: "definitive_rejection",
    });

    const controller = new AbortController();
    const raced = fixture({
      beforeReturn: () => controller.abort(),
      response: { error: {}, response: new Response(null, { status: 400 }) },
    });
    expect(await raced.adapter.steerRequest(request(controller.signal))).toEqual({
      kind: "unknown",
    });
  });

  test.each([408, 409, 425, 429])("keeps retry/concurrency HTTP %s ambiguous", async (status) => {
    const fake = fixture({
      response: {
        error: { _tag: "ConflictError", message: "uncertain admission" },
        response: new Response(null, { status }),
      },
    });
    expect(await fake.adapter.steerRequest(request())).toEqual({ kind: "unknown" });
  });

  test.each([400, 401, 403, 404, 422])(
    "rejects unstructured or proxy-like HTTP %s errors as ambiguous",
    async (status) => {
      for (const error of [{}, { name: "ProxyError", data: { html: "<html>" } }, "foreign"]) {
        const fake = fixture({ response: { error, response: new Response(null, { status }) } });
        expect(await fake.adapter.steerRequest(request())).toEqual({ kind: "unknown" });
      }
    },
  );

  test.each([
    ["transport throw", { throwTransport: true }],
    ["actual 5xx", { response: { error: {}, response: new Response(null, { status: 503 }) } }],
    ["untrusted 4xx object", { response: { error: {}, response: { status: 404 } } }],
    ["4xx without native error", { response: { response: new Response(null, { status: 404 }) } }],
  ])("returns unknown without retry or fallback for %s", async (_label, options) => {
    const fake = fixture(options);
    expect(await fake.adapter.steerRequest(request())).toEqual({ kind: "unknown" });
    expect(fake.promptCalls).toHaveLength(1);
  });
});
