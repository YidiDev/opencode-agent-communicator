import type { Server } from "bun";

import {
  diagnosticProviderCallID,
  diagnosticToolID,
  liveDeadlineMs,
  testModelID,
} from "./constants";

export interface ProviderHarness {
  readonly baseUrl: string;
  readonly requests: readonly unknown[];
  waitForRequestText(text: string, afterSequence?: number): Promise<ProviderRequestObservation>;
  waitForText(text: string, afterSequence?: number): Promise<ProviderRequestGate>;
  stop(): Promise<void>;
}

export interface ProviderRequestGate {
  readonly sequence: number;
  readonly body: unknown;
  release(text?: string): void;
  releaseTool(name: string, arguments_?: string): void;
  waitForCancellation(): Promise<void>;
}

export interface ProviderRequestObservation {
  readonly sequence: number;
  readonly body: unknown;
  readonly receivedAt: number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T): void {
      if (!resolvePromise) return;
      const current = resolvePromise;
      resolvePromise = undefined;
      current(value);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasToolResult(body: unknown): boolean {
  if (!isRecord(body) || !Array.isArray(body.messages)) return false;
  const message = body.messages.at(-1);
  return isRecord(message) && message.role === "tool";
}

function lastMessageSerialized(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.messages)) return JSON.stringify(body);
  return JSON.stringify(body.messages.at(-1));
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
  return {
    id: "chatcmpl-live-harness",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: testModelID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function eventStream(lines: readonly unknown[]): Response {
  const body = `${lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function toolResponse(name = diagnosticToolID, arguments_ = "{}"): Response {
  return eventStream([
    chunk({ role: "assistant" }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: diagnosticProviderCallID,
          type: "function",
          function: { name, arguments: arguments_ },
        },
      ],
    }),
    chunk({}, "tool_calls"),
  ]);
}

function textResponse(text = "diagnostic complete"): Response {
  return eventStream([chunk({ role: "assistant" }), chunk({ content: text }), chunk({}, "stop")]);
}

function sessionReadToolResponse(serialized: string): Response | undefined {
  const after = serialized.match(
    /production-session-read-after:(ses_[A-Za-z0-9]+):([A-Za-z0-9_-]+)/,
  );
  if (after) {
    return toolResponse(
      "session_read",
      JSON.stringify({ session_id: after[1], cursor: after[2], direction: "after" }),
    );
  }
  const cross = serialized.match(/production-session-read-cross:(ses_[A-Za-z0-9]+)/)?.[1];
  if (cross) return toolResponse("session_read", JSON.stringify({ session_id: cross }));
  const self = serialized.match(/production-session-read-self:(ses_[A-Za-z0-9]+)/)?.[1];
  return self ? toolResponse("session_read", JSON.stringify({ session_id: self })) : undefined;
}

function deliveryToolResponse(serialized: string): Response | undefined {
  const send = serialized.match(/production-session-send:(ses_[A-Za-z0-9]+)/)?.[1];
  if (send) {
    return toolResponse(
      "session_send",
      JSON.stringify({ session_id: send, content: "packed live delivery", delivery: "user" }),
    );
  }
  const delivery = serialized.match(/production-delivery-get:(dlv_[a-z0-9]+)/)?.[1];
  if (delivery) {
    return toolResponse("session_delivery_get", JSON.stringify({ delivery_id: delivery }));
  }
  return serialized.includes("production-request-list")
    ? toolResponse("session_request_list")
    : undefined;
}

function productionContextResponse(serialized: string): Response | undefined {
  const target = serialized.match(/production-context-send:(ses_[A-Za-z0-9]+)/)?.[1];
  if (target) {
    return toolResponse(
      "session_send",
      JSON.stringify({ session_id: target, content: "packed private provider context" }),
    );
  }
  return undefined;
}

function productionToolResponse(serialized: string): Response | undefined {
  if (serialized.includes("production-lock-list-after-release")) {
    return toolResponse("session_lock_list");
  }
  if (serialized.includes("production-lock-list")) return toolResponse("session_lock_list");
  if (serialized.includes("production-lock-publish")) {
    return toolResponse(
      "session_lock_publish",
      JSON.stringify({
        ttl_seconds: 300,
        title: "Packed release surface",
        description: "Exercise the packed advisory lock journey.",
        instructions: "Coordinate before touching packed acceptance files.",
      }),
    );
  }
  const lockRenew = serialized.match(/production-lock-renew:(lck_[a-z0-9]+)/)?.[1];
  if (lockRenew) {
    return toolResponse(
      "session_lock_renew",
      JSON.stringify({ lock_id: lockRenew, ttl_seconds: 300 }),
    );
  }
  const lockRelease = serialized.match(/production-lock-release:(lck_[a-z0-9]+)/)?.[1];
  if (lockRelease) {
    return toolResponse("session_lock_release", JSON.stringify({ lock_id: lockRelease }));
  }
  if (serialized.includes("production-session-list")) return toolResponse("session_list");
  const sessionRead = sessionReadToolResponse(serialized);
  if (sessionRead) return sessionRead;
  const delivery = deliveryToolResponse(serialized);
  if (delivery) return delivery;
  const ask = serialized.match(/production-session-ask:(ses_[A-Za-z0-9]+)/)?.[1];
  if (ask) {
    return toolResponse(
      "session_ask",
      JSON.stringify({
        session_id: ask,
        questions: [{ prompt: "Ship packed acceptance?", options: ["yes", "no"] }],
        timeout_seconds: 30,
      }),
    );
  }
  const wait = serialized.match(/production-session-wait:(ses_[A-Za-z0-9]+):([a-z-]+)/);
  if (wait) {
    return toolResponse(
      "session_wait",
      JSON.stringify({ session_id: wait[1], milestone: wait[2], timeout_seconds: 30 }),
    );
  }
  const respond = serialized.match(/production-session-respond:(req_[a-z0-9]+)/)?.[1];
  if (respond) {
    return toolResponse(
      "session_respond",
      JSON.stringify({ request_id: respond, answers: [["yes"]] }),
    );
  }
  const signal = serialized.match(/production-session-signal:(req_[a-z0-9]+)/)?.[1];
  if (signal) {
    return toolResponse(
      "session_signal",
      JSON.stringify({ request_id: signal, evidence: "artifact://packed-live" }),
    );
  }
  const request = serialized.match(/production-request-(get|ack|cancel):(req_[a-z0-9]+)/);
  if (request)
    return toolResponse(
      `session_request_${request[1]}`,
      JSON.stringify({ request_id: request[2] }),
    );
  const requestSendAsk = serialized.match(
    /production-session-request-send-ask:(ses_[A-Za-z0-9]+)/,
  )?.[1];
  if (requestSendAsk) {
    return toolResponse(
      "session_request_send",
      JSON.stringify({
        session_id: requestSendAsk,
        content: "production-process-ask-request",
        request: {
          kind: "ask",
          questions: [{ prompt: "Ship packed acceptance?", options: ["yes", "no"] }],
          timeout_seconds: 30,
        },
      }),
    );
  }
  const requestSendCancel = serialized.match(
    /production-session-request-send-cancel:(ses_[A-Za-z0-9]+)/,
  )?.[1];
  if (requestSendCancel) {
    return toolResponse(
      "session_request_send",
      JSON.stringify({
        session_id: requestSendCancel,
        content: "production-process-wait-request production-cancel",
        request: { kind: "wait", milestone: "production-cancel", timeout_seconds: 30 },
      }),
    );
  }
  if (serialized.includes("production-session-request-start-wait")) {
    return toolResponse(
      "session_request_start",
      JSON.stringify({
        idempotency_key: "packed-live-request-start",
        initial_message: "production-request-start-target-ready",
        title: "Packed durable request target",
        request: { kind: "wait", milestone: "production-request-start", timeout_seconds: 30 },
      }),
    );
  }
  if (serialized.includes("production-session-start")) {
    return toolResponse(
      "session_start",
      JSON.stringify({
        idempotency_key: "packed-live-start",
        initial_message: "Packed peer session ready check",
        title: "Packed peer target",
      }),
    );
  }
  const stop = serialized.match(/production-session-stop:(ses_[A-Za-z0-9]+)/)?.[1];
  if (stop)
    return toolResponse(
      "session_stop",
      JSON.stringify({ session_id: stop, reason: "packed acceptance" }),
    );
  if (serialized.includes("production-export-unavailable")) {
    return toolResponse("session_export", JSON.stringify({ destination: "live.json" }));
  }
  return productionContextResponse(serialized);
}

function communicatorEnvelope(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed) && parsed.protocol === "opencode-session-communicator/v1") return parsed;
    } catch {}
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = communicatorEnvelope(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const item of Object.values(value)) {
    const found = communicatorEnvelope(item);
    if (found) return found;
  }
  return undefined;
}

function advertisesTool(body: unknown, name: string): boolean {
  if (!isRecord(body) || !Array.isArray(body.tools)) return false;
  return body.tools.some((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.function)) return false;
    return candidate.function.name === name;
  });
}

function productionRequestResponse(body: unknown): Response | undefined {
  const envelope = communicatorEnvelope(body);
  if (!envelope || typeof envelope.request_id !== "string") return undefined;
  const serialized = JSON.stringify(body);
  if (envelope.operation === "ask") {
    if (!advertisesTool(body, "session_respond")) return textResponse();
    return toolResponse(
      "session_respond",
      JSON.stringify({ request_id: envelope.request_id, answers: [["yes"]] }),
    );
  }
  if (envelope.operation === "wait") {
    if (
      !serialized.includes("production-process-wait-request") ||
      !advertisesTool(body, "session_signal")
    ) {
      return textResponse();
    }
    const payload = isRecord(envelope.payload) ? envelope.payload : undefined;
    if (payload?.milestone === "production-cancel") return textResponse();
    return toolResponse(
      "session_signal",
      JSON.stringify({ request_id: envelope.request_id, evidence: "artifact://packed-live" }),
    );
  }
  return undefined;
}

function requestedToolResponse(serialized: string): Response {
  const approval = serialized.match(/tool-approval-(allow|deny|ask|stop)/)?.[1];
  if (approval) return toolResponse("diagnostic_approval", JSON.stringify({ mode: approval }));
  if (serialized.includes("tool-unknown-key")) {
    return toolResponse("diagnostic_context", JSON.stringify({ unknown_key: true }));
  }
  if (serialized.includes("tool-cancellation")) return toolResponse("diagnostic_cancellation");
  return productionToolResponse(serialized) ?? toolResponse();
}

function shouldGateRequest(
  options: { readonly gated?: boolean; readonly gateText?: string | readonly string[] },
  body: unknown,
): boolean {
  if (options.gated) return true;
  if (options.gateText === undefined || !isRecord(body) || !Array.isArray(body.messages)) {
    return false;
  }
  const markers = typeof options.gateText === "string" ? [options.gateText] : options.gateText;
  const serialized = JSON.stringify(body);
  if (
    serialized.includes("production-target-active-context-send") &&
    serialized.includes("live context noop complete")
  ) {
    return true;
  }
  if (
    markers.includes("packed private provider context") &&
    serialized.includes("packed private provider context") &&
    serialized.includes("production-target-active-context-send")
  ) {
    return true;
  }
  if (
    markers.includes("packed private request context") &&
    serialized.includes("packed private request context") &&
    serialized.includes("production-target-active-context-request")
  ) {
    return true;
  }
  if (
    (serialized.includes("production-target-active-ask") &&
      serialized.includes('\\"operation\\":\\"ask\\"')) ||
    (serialized.includes("production-target-active-wait") &&
      serialized.includes('\\"operation\\":\\"wait\\"'))
  ) {
    return true;
  }
  if (
    (serialized.includes("production-target-active-ask") ||
      serialized.includes("production-target-active-wait")) &&
    lastMessageSerialized(body).includes("live context hold complete")
  ) {
    return true;
  }
  const message = body.messages.at(-1);
  return isRecord(message) && markers.some((marker) => String(message.content).includes(marker));
}

function completedProviderResponse(body: unknown): Response {
  if (hasToolResult(body)) return textResponse();
  const request = productionRequestResponse(body);
  if (request) return request;
  const serialized = lastMessageSerialized(body);
  if (serialized.includes("packed session read first progress")) {
    return textResponse("packed first progress complete");
  }
  if (serialized.includes("packed session read second progress")) {
    return textResponse("packed second progress complete");
  }
  return requestedToolResponse(serialized);
}

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${label} deadline exceeded`)),
      liveDeadlineMs,
    );
    void promise.then((value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

type ProviderGateRelease =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly arguments: string };

function gatedReleaseChunks(release: ProviderGateRelease): readonly unknown[] {
  if (release.kind === "text") return [chunk({ content: release.text }), chunk({}, "stop")];
  return [
    chunk({
      tool_calls: [
        {
          index: 0,
          id: diagnosticProviderCallID,
          type: "function",
          function: { name: release.name, arguments: release.arguments },
        },
      ],
    }),
    chunk({}, "tool_calls"),
  ];
}

function gatedTextResponse(
  release: Promise<ProviderGateRelease>,
  cancelled: Deferred<void>,
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`),
        );
        void release.then((result) => {
          try {
            for (const item of gatedReleaseChunks(result)) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {
            // Interruption can cancel the response body before the explicit release.
          }
        });
      },
      cancel() {
        cancelled.resolve(undefined);
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export function launchDeterministicProvider(
  options: { gated?: boolean; gateText?: string | readonly string[] } = {},
): ProviderHarness {
  const requests: unknown[] = [];
  const observations: ProviderRequestObservation[] = [];
  const gates: ProviderRequestGate[] = [];
  const gateArrivals = new Set<Deferred<void>>();
  const requestArrivals = new Set<Deferred<void>>();
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      const body: unknown = JSON.parse(await request.text());
      requests.push(body);
      observations.push({ sequence: requests.length, body, receivedAt: Date.now() });
      for (const arrival of requestArrivals) arrival.resolve(undefined);
      requestArrivals.clear();
      const serialized = JSON.stringify(body);
      if (serialized.includes("legacy-retry")) {
        return Response.json(
          { error: { message: "phase0 deterministic retryable 503", type: "server_error" } },
          { status: 503, headers: { "retry-after-ms": "60000" } },
        );
      }
      if (shouldGateRequest(options, body)) {
        const release = deferred<ProviderGateRelease>();
        const cancelled = deferred<void>();
        const sequence = requests.length;
        gates.push({
          sequence,
          body,
          release(text = `gate-${sequence}-complete`): void {
            release.resolve({ kind: "text", text });
          },
          releaseTool(name, arguments_ = "{}"): void {
            release.resolve({ kind: "tool", name, arguments: arguments_ });
          },
          waitForCancellation(): Promise<void> {
            return withDeadline(cancelled.promise, `provider request ${sequence} cancellation`);
          },
        });
        for (const arrival of gateArrivals) arrival.resolve(undefined);
        gateArrivals.clear();
        return gatedTextResponse(release.promise, cancelled);
      }
      return completedProviderResponse(body);
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    get requests(): readonly unknown[] {
      return requests;
    },
    async waitForRequestText(text: string, afterSequence = 0): Promise<ProviderRequestObservation> {
      const match = (): ProviderRequestObservation | undefined =>
        observations.find(
          (request) =>
            request.sequence > afterSequence && JSON.stringify(request.body).includes(text),
        );
      const existing = match();
      if (existing) return existing;
      const arrival = deferred<void>();
      requestArrivals.add(arrival);
      await withDeadline(arrival.promise, `provider request containing ${JSON.stringify(text)}`);
      return this.waitForRequestText(text, afterSequence);
    },
    async waitForText(text: string, afterSequence = 0): Promise<ProviderRequestGate> {
      const match = (): ProviderRequestGate | undefined =>
        gates.find(
          (gate) => gate.sequence > afterSequence && JSON.stringify(gate.body).includes(text),
        );
      const existing = match();
      if (existing) return existing;
      const arrival = deferred<void>();
      gateArrivals.add(arrival);
      await withDeadline(arrival.promise, `provider request containing ${JSON.stringify(text)}`);
      return this.waitForText(text, afterSequence);
    },
    async stop(): Promise<void> {
      for (const gate of gates) gate.release("provider stopped");
      await server.stop(true);
    },
  };
}
