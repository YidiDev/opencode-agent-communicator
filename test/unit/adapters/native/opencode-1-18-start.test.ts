import { expect, test } from "bun:test";

import { isAuthoritativeClientRejection } from "../../../../src/adapters/native/opencode-1-18-admission";
import {
  admitLegacyInitialMessage,
  createDeterministicRootSession,
  reconcileDeterministicRootSession,
  updateAndVerifySessionTitle,
} from "../../../../src/adapters/native/opencode-1-18-start";
import {
  validateManagedSessionId,
  validateNativeMessageId,
} from "../../../../src/domain/generated-ids";

function sessionId() {
  const result = validateManagedSessionId(`ses_${"a".repeat(32)}`);
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

function messageId() {
  const result = validateNativeMessageId(`msg_${"b".repeat(32)}`);
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

function info(title = "Untitled") {
  return {
    id: sessionId(),
    projectID: "project",
    title,
    location: { directory: "/workspace" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  };
}

function publicInfo(title = "Untitled") {
  return {
    id: sessionId(),
    projectID: "project",
    directory: "/workspace",
    title,
    time: { created: 1, updated: 1 },
  };
}

test("creates a deterministic root only after absence and verifies response plus read-back", async () => {
  const calls: string[] = [];
  let reads = 0;
  const result = await createDeterministicRootSession(
    {
      async get() {
        calls.push("get");
        reads += 1;
        return reads === 1
          ? {
              error: {
                _tag: "SessionNotFoundError",
                sessionID: sessionId(),
                message: "not found",
              },
              request: new Request(`http://opencode.internal/session/${sessionId()}`),
              response: new Response(null, { status: 404 }),
            }
          : { data: { data: info() } };
      },
      async create(input) {
        calls.push("create");
        expect(input).toEqual({ id: sessionId(), location: { directory: "/workspace" } });
        return { data: { data: info() } };
      },
    },
    "/workspace",
    { sessionId: sessionId(), abort: new AbortController().signal },
  );
  expect(result).toBe("created");
  expect(calls).toEqual(["get", "create", "get"]);
});

test("never adopts an existing deterministic ID collision", async () => {
  let created = false;
  const result = await createDeterministicRootSession(
    {
      async get() {
        return { data: { data: info() } };
      },
      async create() {
        created = true;
        return { data: { data: info() } };
      },
    },
    "/workspace",
    { sessionId: sessionId(), abort: new AbortController().signal },
  );
  expect(result).toBe("collision");
  expect(created).toBe(false);
});

test("reconciles matches and collisions while a submitted create's exact 404 remains unresolved", async () => {
  const abort = new AbortController().signal;
  const matching = {
    data: { data: { ...info(), agent: "worker", model: { providerID: "p", id: "m" } } },
  };
  expect(
    await reconcileDeterministicRootSession({ get: async () => matching }, "/workspace", {
      sessionId: sessionId(),
      agent: "worker",
      model: "p/m",
      abort,
    }),
  ).toBe("matching");
  expect(
    await reconcileDeterministicRootSession(
      { get: async () => ({ data: { data: info() } }) },
      "/other",
      {
        sessionId: sessionId(),
        abort,
      },
    ),
  ).toBe("collision");
  expect(
    await reconcileDeterministicRootSession(
      {
        get: async () => ({
          error: { _tag: "SessionNotFoundError", sessionID: sessionId(), message: "not found" },
          response: new Response(null, { status: 404 }),
        }),
      },
      "/workspace",
      { sessionId: sessionId(), abort },
    ),
  ).toBe("unknown");
  expect(
    await reconcileDeterministicRootSession(
      { get: async () => ({ data: "malformed" }) },
      "/workspace",
      {
        sessionId: sessionId(),
        abort,
      },
    ),
  ).toBe("unknown");
});

test("does not release on transient absence before delayed create visibility", async () => {
  let reads = 0;
  const surface = {
    async get() {
      reads += 1;
      return reads === 1
        ? {
            error: {
              _tag: "SessionNotFoundError",
              sessionID: sessionId(),
              message: "not found",
            },
            response: new Response(null, { status: 404 }),
          }
        : { data: { data: info() } };
    },
  };
  const input = { sessionId: sessionId(), abort: new AbortController().signal };

  expect(await reconcileDeterministicRootSession(surface, "/workspace", input)).toBe("unknown");
  expect(await reconcileDeterministicRootSession(surface, "/workspace", input)).toBe("matching");
});

test("keeps exact successful create evidence when immediate read-back is transiently absent", async () => {
  let reads = 0;
  let creates = 0;
  const controller = new AbortController();
  const absent = () => ({
    error: { _tag: "SessionNotFoundError", sessionID: sessionId(), message: "not found" },
    response: new Response(null, { status: 404 }),
  });
  const outcome = await createDeterministicRootSession(
    {
      async get() {
        reads += 1;
        return absent();
      },
      async create() {
        creates += 1;
        controller.abort("caller deadline raced with the exact response");
        return { data: { data: info() } };
      },
    },
    "/workspace",
    { sessionId: sessionId(), abort: controller.signal },
  );
  expect(outcome).toBe("created");
  expect({ reads, creates }).toEqual({ reads: 2, creates: 1 });
});

test("fails closed for mixed envelopes and fake status objects", async () => {
  let created = false;
  for (const malformed of [
    { data: { data: info() }, error: { _tag: "SessionNotFoundError" } },
    {
      error: { _tag: "SessionNotFoundError", sessionID: sessionId(), message: "not found" },
      response: { status: 404 },
    },
  ]) {
    const result = await createDeterministicRootSession(
      {
        async get() {
          return malformed;
        },
        async create() {
          created = true;
          return { data: { data: info() } };
        },
      },
      "/workspace",
      { sessionId: sessionId(), abort: new AbortController().signal },
    );
    expect(result).toBe("unknown");
  }
  expect(created).toBe(false);
});

test("accepts only a genuine optional SDK request in authoritative rejection envelopes", () => {
  const error = {
    _tag: "SessionNotFoundError",
    sessionID: sessionId(),
    message: "not found",
  };
  const response = new Response(null, { status: 404 });
  const request = new Request(`http://opencode.internal/session/${sessionId()}`);

  expect(isAuthoritativeClientRejection({ error, request, response }, false, sessionId())).toBe(
    true,
  );
  expect(isAuthoritativeClientRejection({ error, response }, false, sessionId())).toBe(true);
  for (const malformed of [
    { error, request: {}, response },
    { error, request: Object.create(Request.prototype), response },
    { error, request: new Proxy(request, {}), response },
    { error, request, response: Object.create(Response.prototype) },
    { error, request, response: new Proxy(response, {}) },
    { error, request, response, unexpected: true },
  ]) {
    expect(isAuthoritativeClientRejection(malformed, false, sessionId())).toBe(false);
  }
});

test("verifies the title directly from the public update response", async () => {
  const result = await updateAndVerifySessionTitle(
    {
      async updateTitle(input: { readonly title: string }) {
        expect(input.title).toBe("Exact title");
        return { data: publicInfo("Exact title") };
      },
    },
    "/workspace",
    { sessionId: sessionId(), title: "Exact title", abort: new AbortController().signal },
  );
  expect(result).toBe("updated");
});

test("passes exact agent and model overrides and rejects malformed model references before I/O", async () => {
  const calls: unknown[] = [];
  let reads = 0;
  const surface = {
    async get() {
      reads += 1;
      return reads === 1
        ? {
            error: {
              _tag: "SessionNotFoundError",
              sessionID: sessionId(),
              message: "not found",
            },
            response: new Response(null, { status: 404 }),
          }
        : {
            data: {
              data: {
                ...info(),
                agent: "worker",
                model: { providerID: "openai", id: "gpt-5" },
              },
            },
          };
    },
    async create(input: unknown) {
      calls.push(input);
      return {
        data: {
          data: {
            ...info(),
            agent: "worker",
            model: { providerID: "openai", id: "gpt-5" },
          },
        },
      };
    },
  };
  expect(
    await createDeterministicRootSession(surface, "/workspace", {
      sessionId: sessionId(),
      agent: "worker",
      model: "openai/gpt-5",
      abort: new AbortController().signal,
    }),
  ).toBe("created");
  expect(calls).toEqual([
    {
      id: sessionId(),
      agent: "worker",
      model: { providerID: "openai", id: "gpt-5" },
      location: { directory: "/workspace" },
    },
  ]);
  for (const model of ["gpt-5", "/gpt-5", "openai/"]) {
    expect(
      await createDeterministicRootSession(surface, "/workspace", {
        sessionId: sessionId(),
        model,
        abort: new AbortController().signal,
      }),
    ).toBe("definitive_rejection");
  }
  expect(calls).toHaveLength(1);
});

test("fails closed for hostile snapshots, non-success data envelopes, and transport faults", async () => {
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("hostile reflection");
      },
    },
  );
  for (const get of [
    async () => hostile,
    async () => ({ data: { data: info() }, response: new Response(null, { status: 201 }) }),
    async () => {
      throw new Error("private transport fault");
    },
  ]) {
    const result = await createDeterministicRootSession(
      { get, create: async () => ({ data: { data: info() } }) },
      "/workspace",
      { sessionId: sessionId(), abort: new AbortController().signal },
    );
    expect(result).toBe("unknown");
  }
  const aborted = new AbortController();
  aborted.abort();
  expect(
    await createDeterministicRootSession(
      { get: async () => ({ data: { data: info() } }), create: async () => undefined },
      "/workspace",
      { sessionId: sessionId(), abort: aborted.signal },
    ),
  ).toBe("unknown");
});

test("title updates distinguish authoritative rejection while preserving ambiguous outcomes", async () => {
  const abort = new AbortController().signal;
  expect(
    await updateAndVerifySessionTitle(
      {
        updateTitle: async () => ({
          error: { _tag: "SessionNotFoundError", sessionID: sessionId(), message: "not found" },
          response: new Response(null, { status: 404 }),
        }),
      },
      "/workspace",
      { sessionId: sessionId(), title: "Exact title", abort },
    ),
  ).toBe("definitive_rejection");
  expect(
    await updateAndVerifySessionTitle({ updateTitle: async () => ({ data: true }) }, "/workspace", {
      sessionId: sessionId(),
      title: "Exact title",
      abort,
    }),
  ).toBe("unknown");
  expect(
    await updateAndVerifySessionTitle(
      {
        updateTitle: async () => {
          throw new Error("private title fault");
        },
      },
      "/workspace",
      { sessionId: sessionId(), title: "Exact title", abort },
    ),
  ).toBe("unknown");
});

test("admits the initial message through a correlated public transcript response", async () => {
  const calls: unknown[] = [];
  const result = await admitLegacyInitialMessage(
    {
      async prompt(input) {
        calls.push(input);
        return {
          data: {
            info: {
              id: "msg_assistant",
              sessionID: sessionId(),
              parentID: messageId(),
              role: "assistant",
            },
            parts: [],
          },
          response: new Response(null, { status: 200 }),
        };
      },
    },
    "/workspace",
    {
      sessionId: sessionId(),
      nativeMessageId: messageId(),
      message: "Visible prompt",
      agent: "worker",
      model: "openai/gpt-5",
      abort: new AbortController().signal,
    },
  );
  expect(result).toBe("admitted");
  expect(calls).toEqual([
    {
      sessionID: sessionId(),
      directory: "/workspace",
      messageID: messageId(),
      agent: "worker",
      model: { providerID: "openai", modelID: "gpt-5" },
      parts: [{ type: "text", text: "Visible prompt" }],
    },
  ]);
});

test("fails closed for uncorrelated or malformed public prompt responses", async () => {
  const input = {
    sessionId: sessionId(),
    nativeMessageId: messageId(),
    message: "Visible prompt",
    abort: new AbortController().signal,
  };
  for (const response of [
    {
      data: {
        info: { sessionID: "ses_other", parentID: messageId(), role: "assistant" },
        parts: [],
      },
    },
    {
      data: {
        info: { sessionID: sessionId(), parentID: "msg_other", role: "assistant" },
        parts: [],
      },
    },
    { data: { info: { sessionID: sessionId(), parentID: messageId(), role: "user" }, parts: [] } },
    {
      data: {
        info: { sessionID: sessionId(), parentID: messageId(), role: "assistant" },
        parts: {},
      },
    },
    {
      data: {
        info: { sessionID: sessionId(), parentID: messageId(), role: "assistant" },
        parts: [],
      },
      response: Object.create(Response.prototype),
    },
    {
      data: {
        info: { sessionID: sessionId(), parentID: messageId(), role: "assistant" },
        parts: [],
      },
      request: Object.create(Request.prototype),
    },
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile envelope");
        },
      },
    ),
  ]) {
    expect(
      await admitLegacyInitialMessage({ prompt: async () => response }, "/workspace", input),
    ).toBe("unknown");
  }
});

test("classifies public prompt rejection, malformed model, cancellation, and transport ambiguity", async () => {
  const base = {
    sessionId: sessionId(),
    nativeMessageId: messageId(),
    message: "Visible prompt",
    abort: new AbortController().signal,
  };
  expect(
    await admitLegacyInitialMessage(
      {
        prompt: async () => ({
          error: { _tag: "InvalidRequestError", message: "rejected" },
          request: new Request("http://opencode.internal/session"),
          response: new Response(null, { status: 400 }),
        }),
      },
      "/workspace",
      base,
    ),
  ).toBe("definitive_rejection");
  expect(
    await admitLegacyInitialMessage({ prompt: async () => undefined }, "/workspace", {
      ...base,
      model: "malformed",
    }),
  ).toBe("definitive_rejection");
  const aborted = new AbortController();
  aborted.abort();
  expect(
    await admitLegacyInitialMessage({ prompt: async () => undefined }, "/workspace", {
      ...base,
      abort: aborted.signal,
    }),
  ).toBe("unknown");
  const raced = new AbortController();
  expect(
    await admitLegacyInitialMessage(
      {
        prompt: async () => {
          raced.abort();
          return {
            data: {
              info: {
                sessionID: sessionId(),
                parentID: messageId(),
                role: "assistant",
              },
              parts: [],
            },
          };
        },
      },
      "/workspace",
      { ...base, abort: raced.signal },
    ),
  ).toBe("unknown");
  expect(
    await admitLegacyInitialMessage(
      {
        prompt: async () => {
          throw new Error("transport failed");
        },
      },
      "/workspace",
      base,
    ),
  ).toBe("unknown");
});
