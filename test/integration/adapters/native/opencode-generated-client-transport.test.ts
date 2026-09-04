import { expect, test } from "bun:test";
import { createOpencodeClient as createLegacyOpencodeClient } from "@opencode-ai/sdk/client";

import { createOpenCode118NativeAdapter } from "../../../../src/adapters/native/opencode-1-18";
import {
  validateManagedSessionId,
  validateNativeMessageId,
} from "../../../../src/domain/generated-ids";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("invalid generated-client fixture");
  return result.value;
}

const baseUrl = "http://127.0.0.1:4321";
const directory = "/workspace with spaces";
const workspaceKey = valid(validateWorkspaceKey("workspace:generated-client"));
const sourceSessionId = valid(validateSessionId("ses_source"));
const targetSessionId = valid(validateSessionId("ses_target"));
const managedSessionId = valid(validateManagedSessionId(`ses_${"a".repeat(32)}`));
const messageId = valid(validateNativeMessageId(`msg_${"b".repeat(32)}`));

function session(id = targetSessionId, title = "Target") {
  return { id, title, location: { directory }, time: { created: 1, updated: 2 } };
}

function publicSession(title = "Worker") {
  return { id: managedSessionId, title, directory, time: { created: 1, updated: 2 } };
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function body(request: Request): Promise<Record<string, unknown>> {
  return request.clone().json() as Promise<Record<string, unknown>>;
}

function exactQuery(request: Request, expected: Record<string, string>): void {
  const url = new URL(request.url);
  expect(Object.fromEntries(url.searchParams)).toEqual(expected);
}

interface GeneratedHarness {
  readonly adapter: ReturnType<typeof createOpenCode118NativeAdapter>;
  readonly poisonCalls: () => number;
  readonly requests: Request[];
}

function generatedHarness(
  dispatch: (request: Request) => Promise<Response> | Response,
): GeneratedHarness {
  let poisonCalls = 0;
  const poison = (async () => {
    poisonCalls += 1;
    throw new Error("generated client ignored its per-call fetch override");
  }) as unknown as typeof globalThis.fetch;
  const controlled = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return dispatch(request);
  }) as typeof globalThis.fetch;
  const requests: Request[] = [];
  const injected = createLegacyOpencodeClient({ baseUrl, directory, fetch: poison });
  return {
    requests,
    poisonCalls: () => poisonCalls,
    adapter: createOpenCode118NativeAdapter(
      {
        client: injected,
        directory,
        serverUrl: new URL(baseUrl),
        workspaceKey,
        projectId: "project",
      },
      { hostFetch: controlled, now: () => 7_000 },
    ),
  };
}

function observationResponse(request: Request): Response | undefined {
  const path = new URL(request.url).pathname;
  if (path === "/global/health") return json({ healthy: true, version: "1.18.25" });
  if (path === "/session/status") return json({ [sourceSessionId]: { type: "idle" } });
  if (path === "/api/session/active") return json({ data: {} });
  if (path === "/api/session" && request.method === "GET") {
    return json({ data: [session(sourceSessionId, "Source"), session()], cursor: {} });
  }
  if (path === "/session" && request.method === "GET") {
    return json([session(sourceSessionId, "Source"), session()]);
  }
  return undefined;
}

async function messageResponse(request: Request): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === `/api/session/${targetSessionId}/prompt`) {
    const input = await body(request);
    return json({
      data: {
        id: input.id,
        sessionID: targetSessionId,
        prompt: input.prompt,
        delivery: input.delivery,
        admittedSeq: 3,
        timeCreated: 4,
      },
    });
  }
  if (path === `/session/${targetSessionId}/prompt_async`) {
    return new Response(null, { status: 204 });
  }
  if (path === `/session/${targetSessionId}/message/${messageId}`) {
    return json({
      info: { id: messageId, sessionID: targetSessionId, role: "user" },
      parts: [
        {
          id: "prt_1",
          type: "text",
          sessionID: targetSessionId,
          messageID: messageId,
          text: "hello",
        },
      ],
    });
  }
  return undefined;
}

function startResponse() {
  let managedExists = false;
  return (request: Request): Response | undefined => {
    const path = new URL(request.url).pathname;
    if (path === `/api/session/${managedSessionId}`) {
      if (!managedExists) {
        return json(
          { _tag: "SessionNotFoundError", sessionID: managedSessionId, message: "missing" },
          404,
        );
      }
      return json({ data: session(managedSessionId, "Worker") });
    }
    if (path === "/api/session" && request.method === "POST") {
      managedExists = true;
      return json({ data: session(managedSessionId, "Worker") });
    }
    if (path === `/session/${managedSessionId}` && request.method === "PATCH") {
      return json(publicSession("Renamed"));
    }
    if (path === `/session/${targetSessionId}/abort`) return json(true);
    return undefined;
  };
}

test("actual pinned clients honor bounded per-call fetches and generate exact ordinary requests", async () => {
  const respondToStart = startResponse();
  const harness = generatedHarness(async (request) => {
    const response =
      observationResponse(request) ?? (await messageResponse(request)) ?? respondToStart(request);
    if (response) return response;
    throw new Error(
      `unexpected controlled route: ${request.method} ${new URL(request.url).pathname}`,
    );
  });
  const abort = new AbortController().signal;

  expect(await harness.adapter.readHealth()).toEqual({ healthy: true, version: "1.18.25" });
  expect(await harness.adapter.readVisibleRoots(false)).toHaveLength(2);
  expect(
    await harness.adapter.steerRequest({
      targetSessionId,
      nativeMessageId: messageId,
      envelope: "hello",
      abort,
    }),
  ).toEqual({ kind: "admitted", admittedSeq: 3, observedAtMs: 4 });
  expect(
    await harness.adapter.queueMessage({
      targetSessionId,
      nativeMessageId: messageId,
      envelope: "hello",
      abort,
    }),
  ).toEqual({ kind: "public_message", observedAtMs: 7_000 });
  expect(await harness.adapter.createRootSession({ sessionId: managedSessionId, abort })).toBe(
    "created",
  );
  expect(
    await harness.adapter.updateSessionTitle({
      sessionId: managedSessionId,
      title: "Renamed",
      abort,
    }),
  ).toBe("updated");
  expect(await harness.adapter.interruptSession({ targetSessionId, abort })).toBe("interrupted");
  expect(harness.poisonCalls()).toBe(0);
  expect(new Set(harness.requests.map((request) => new URL(request.url).origin))).toEqual(
    new Set([baseUrl]),
  );

  const byRoute = (method: string, path: string) =>
    harness.requests.find(
      (request) => request.method === method && new URL(request.url).pathname === path,
    );
  const health = byRoute("GET", "/global/health");
  const status = byRoute("GET", "/session/status");
  const active = byRoute("GET", "/api/session/active");
  const legacyList = byRoute("GET", "/session");
  const v2List = byRoute("GET", "/api/session");
  for (const request of [health, status]) {
    if (!request) throw new Error("missing generated observation request");
    exactQuery(request, { directory });
  }
  if (!active || !legacyList || !v2List) throw new Error("missing generated list/status request");
  exactQuery(active, { directory, "location[directory]": directory });
  exactQuery(legacyList, { directory, roots: "true" });
  exactQuery(v2List, {
    directory,
    "location[directory]": directory,
    limit: "100",
    order: "desc",
  });

  const steer = byRoute("POST", `/api/session/${targetSessionId}/prompt`);
  const publicPrompt = byRoute("POST", `/session/${targetSessionId}/prompt_async`);
  const create = byRoute("POST", "/api/session");
  const publicRead = byRoute("GET", `/session/${targetSessionId}/message/${messageId}`);
  const title = byRoute("PATCH", `/session/${managedSessionId}`);
  const interrupt = byRoute("POST", `/session/${targetSessionId}/abort`);
  for (const request of [publicPrompt, publicRead, title, interrupt]) {
    if (!request) throw new Error("missing generated mutation request");
    exactQuery(request, { directory });
  }
  for (const request of [steer, create]) {
    if (!request) throw new Error("missing generated V2 mutation request");
    expect(new URL(request.url).search).toBe("");
    expect(request.headers.get("x-opencode-directory")).toBe(encodeURIComponent(directory));
  }
  const gets = harness.requests.filter(
    (request) =>
      request.method === "GET" &&
      new URL(request.url).pathname === `/api/session/${managedSessionId}`,
  );
  expect(gets).toHaveLength(2);
  for (const request of gets) {
    exactQuery(request, { directory, "location[directory]": directory });
  }
  expect(await body(steer as Request)).toMatchObject({
    id: messageId,
    delivery: "steer",
    resume: true,
    prompt: { text: "hello" },
  });
  expect(await body(publicPrompt as Request)).toMatchObject({
    messageID: messageId,
    parts: [{ type: "text", text: "hello" }],
  });
  expect(await body(create as Request)).toMatchObject({
    id: managedSessionId,
    location: { directory },
  });
  expect(await body(title as Request)).toEqual({ title: "Renamed" });
  expect((interrupt as Request).body).toBeNull();
});

test("actual generated rejection envelopes are definitive only with exact correlated requests", async () => {
  const harness = generatedHarness(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === `/api/session/${targetSessionId}/prompt`) {
      return json({ _tag: "InvalidRequestError", message: "invalid prompt" }, 400);
    }
    if (url.pathname === `/session/${targetSessionId}/prompt_async`) {
      return json({ _tag: "UnauthorizedError", message: "unauthorized" }, 401);
    }
    if (url.pathname === `/session/${managedSessionId}` && request.method === "PATCH") {
      return json(
        { _tag: "SessionNotFoundError", sessionID: managedSessionId, message: "missing" },
        404,
      );
    }
    throw new Error(`unexpected rejection route: ${request.method} ${url.pathname}`);
  });
  const abort = new AbortController().signal;

  expect(
    await harness.adapter.steerRequest({
      targetSessionId,
      nativeMessageId: messageId,
      envelope: "hello",
      abort,
    }),
  ).toEqual({ kind: "definitive_rejection" });
  expect(
    await harness.adapter.queueMessage({
      targetSessionId,
      nativeMessageId: messageId,
      envelope: "hello",
      abort,
    }),
  ).toEqual({ kind: "definitive_rejection" });
  expect(
    await harness.adapter.updateSessionTitle({ sessionId: managedSessionId, title: "Nope", abort }),
  ).toBe("definitive_rejection");
  const generatedTitleRequest = harness.requests.find(
    (request) =>
      request.method === "PATCH" &&
      new URL(request.url).pathname === `/session/${managedSessionId}`,
  );
  if (!generatedTitleRequest) throw new Error("pinned client did not generate the title request");
  expect(await body(generatedTitleRequest)).toEqual({ title: "Nope" });
  expect(harness.poisonCalls()).toBe(0);
});

test("actual generated health and legacy status reads cancel oversized response streams", async () => {
  function oversized() {
    let cancellations = 0;
    return {
      cancellations: () => cancellations,
      response: new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1_024 * 1_024 + 1));
          },
          cancel() {
            cancellations += 1;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    };
  }

  const healthBody = oversized();
  const health = generatedHarness((request) => {
    if (new URL(request.url).pathname === "/global/health") return healthBody.response;
    throw new Error("unexpected health route");
  });
  await expect(health.adapter.readHealth()).rejects.toThrow("Host health returned malformed data");
  expect(healthBody.cancellations()).toBe(1);
  expect(health.poisonCalls()).toBe(0);

  const statusBody = oversized();
  const status = generatedHarness((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/session/status") return statusBody.response;
    if (path === "/session") return json([session(sourceSessionId, "Source"), session()]);
    if (path === "/api/session/active") return json({ data: {} });
    throw new Error(`unexpected status route: ${path}`);
  });
  await expect(
    status.adapter.observeRequestParticipants(
      workspaceKey,
      sourceSessionId,
      targetSessionId,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(statusBody.cancellations()).toBe(1);
  expect(status.poisonCalls()).toBe(0);
});
