import { expect, test } from "bun:test";

import {
  type ClientRejectionCorrelation,
  isAuthoritativeClientRejection,
} from "../../../../src/adapters/native/opencode-1-18-admission";
import { validateNativeMessageId } from "../../../../src/domain/generated-ids";
import { validateSessionId } from "../../../../src/domain/sessions";

function valid<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) {
  if (!result.ok) throw new Error("invalid rejection fixture");
  return result.value;
}

const sessionId = valid(validateSessionId("ses_target"));
const messageId = valid(validateNativeMessageId(`msg_${"c".repeat(32)}`));
const serverUrl = new URL("http://127.0.0.1:4321");
const correlation: ClientRejectionCorrelation = {
  method: "POST",
  serverUrl,
  endpointPath: `/api/session/${sessionId}/prompt`,
  directory: "/workspace",
  targetSessionId: sessionId,
  messageId,
  messageIdBodyKey: "id",
};

function request(body: BodyInit | null, init: RequestInit = {}): Request {
  return new Request(`${serverUrl.origin}${correlation.endpointPath}`, {
    method: "POST",
    headers: { "x-opencode-directory": encodeURIComponent(correlation.directory) },
    body,
    ...init,
  });
}

function rejection(
  generatedRequest: Request,
  error: unknown = { _tag: "InvalidRequestError", message: "invalid" },
) {
  return {
    error,
    request: generatedRequest,
    response: new Response(null, { status: 400 }),
  };
}

function replaceCloneBody(request: Request, body: ReadableStream<Uint8Array>): Request {
  Object.defineProperty(request, "clone", { value: () => ({ body }) });
  return request;
}

test("rejects missing, malformed, and oversized generated request bodies as ambiguous", async () => {
  const malformed = request("not-json");
  const oversized = request(new Uint8Array(256 * 1_024 + 1));
  const missing = request(null);

  for (const generatedRequest of [malformed, oversized, missing]) {
    expect(
      await isAuthoritativeClientRejection(rejection(generatedRequest), false, correlation),
    ).toBe(false);
  }
});

test.each([
  ["zero-length flood", () => new Uint8Array()],
  ["fragment flood", () => new Uint8Array([32])],
])("bounds and cancels a generated request %s", async (_label, chunk) => {
  let cancellations = 0;
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      controller.enqueue(chunk());
    },
    cancel() {
      cancellations += 1;
    },
  });
  const generatedRequest = replaceCloneBody(request(JSON.stringify({ id: messageId })), body);

  expect(
    await isAuthoritativeClientRejection(rejection(generatedRequest), false, correlation),
  ).toBe(false);
  expect(reads).toBeLessThanOrEqual(4_097);
  expect(cancellations).toBe(1);
});

test("copies tiny generated-request views from large caller storage before parsing", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ id: messageId }));
  const backing = new Uint8Array(1024 * 1024);
  backing.set(encoded, 700_000);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === encoded.length) {
        backing.fill(0, 700_000, 700_000 + encoded.length - 1);
        controller.close();
        return;
      }
      const tinyView = backing.subarray(700_000 + offset, 700_001 + offset);
      offset += 1;
      controller.enqueue(tinyView);
    },
  });
  const generatedRequest = replaceCloneBody(request(JSON.stringify({ id: messageId })), body);

  expect(
    await isAuthoritativeClientRejection(rejection(generatedRequest), false, correlation),
  ).toBe(true);
});

test("accepts the pinned generated header-only workspace binding with an exact message body", async () => {
  expect(
    await isAuthoritativeClientRejection(
      rejection(request(JSON.stringify({ id: messageId }))),
      false,
      correlation,
    ),
  ).toBe(true);
});

test("cancels request-body correlation when operation control is already aborted", async () => {
  const controller = new AbortController();
  controller.abort("deadline");
  const generatedRequest = request(
    new ReadableStream<Uint8Array>({
      pull() {},
    }) as unknown as BodyInit,
    { duplex: "half" } as RequestInit,
  );

  expect(
    await isAuthoritativeClientRejection(rejection(generatedRequest), false, {
      ...correlation,
      abort: controller.signal,
    }),
  ).toBe(false);
});

test("requires valid structured client errors after exact request correlation", async () => {
  const exactRequest = () => request(JSON.stringify({ id: messageId }));
  for (const error of [
    { _tag: "OtherError", message: "invalid" },
    { _tag: "InvalidRequestError", message: "" },
    { _tag: "InvalidRequestError", message: "invalid", field: 42 },
  ]) {
    expect(
      await isAuthoritativeClientRejection(rejection(exactRequest(), error), false, correlation),
    ).toBe(false);
  }
});

test("contains hostile envelope reflection and unreadable request streams as ambiguity", async () => {
  const hostileEnvelope = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("hostile envelope");
      },
    },
  );
  const accessorEnvelope = {
    get error() {
      return { _tag: "InvalidRequestError", message: "invalid" };
    },
    request: request(JSON.stringify({ id: messageId })),
    response: new Response(null, { status: 400 }),
  };
  const unreadable = request(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("unreadable request body"));
      },
    }) as unknown as BodyInit,
    { duplex: "half" } as RequestInit,
  );

  for (const value of [hostileEnvelope, accessorEnvelope, rejection(unreadable)]) {
    expect(await isAuthoritativeClientRejection(value, false, correlation)).toBe(false);
  }
});

test("rechecks cancellation after each request-body read", async () => {
  const controller = new AbortController();
  const generatedRequest = request(
    new ReadableStream<Uint8Array>({
      pull(stream) {
        controller.abort("deadline");
        stream.enqueue(new TextEncoder().encode(JSON.stringify({ id: messageId })));
        stream.close();
      },
    }) as unknown as BodyInit,
    { duplex: "half" } as RequestInit,
  );

  expect(
    await isAuthoritativeClientRejection(rejection(generatedRequest), false, {
      ...correlation,
      abort: controller.signal,
    }),
  ).toBe(false);
});

test("does not infer message correlation without the operation-specific body key", async () => {
  const { messageIdBodyKey: _messageIdBodyKey, ...withoutBodyKey } = correlation;
  expect(
    await isAuthoritativeClientRejection(
      rejection(request(JSON.stringify({ id: messageId }))),
      false,
      withoutBodyKey,
    ),
  ).toBe(false);
});

test("rejects a mismatched generated workspace header before reading the request body", async () => {
  const generatedRequest = new Request(`${serverUrl.origin}${correlation.endpointPath}`, {
    method: "POST",
    headers: { "x-opencode-directory": encodeURIComponent("/other") },
    body: JSON.stringify({ id: messageId }),
  });

  expect(
    await isAuthoritativeClientRejection(rejection(generatedRequest), false, correlation),
  ).toBe(false);
});
