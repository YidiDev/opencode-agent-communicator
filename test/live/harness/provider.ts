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
  return body.messages.some((message) => isRecord(message) && message.role === "tool");
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

function textResponse(): Response {
  return eventStream([
    chunk({ role: "assistant" }),
    chunk({ content: "diagnostic complete" }),
    chunk({}, "stop"),
  ]);
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

function gatedTextResponse(release: Promise<string>, cancelled: Deferred<void>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`),
        );
        void release.then((text) => {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(chunk({ content: text }))}\n\n`),
            );
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`));
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

export function launchDeterministicProvider(options: { gated?: boolean } = {}): ProviderHarness {
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
      if (options.gated) {
        const release = deferred<string>();
        const cancelled = deferred<void>();
        const sequence = requests.length;
        gates.push({
          sequence,
          body,
          release(text = `gate-${sequence}-complete`): void {
            release.resolve(text);
          },
          waitForCancellation(): Promise<void> {
            return withDeadline(cancelled.promise, `provider request ${sequence} cancellation`);
          },
        });
        for (const arrival of gateArrivals) arrival.resolve(undefined);
        gateArrivals.clear();
        return gatedTextResponse(release.promise, cancelled);
      }
      if (hasToolResult(body)) return textResponse();
      const approval = serialized.match(/tool-approval-(allow|deny|ask)/)?.[1];
      if (approval) return toolResponse("diagnostic_approval", JSON.stringify({ mode: approval }));
      if (serialized.includes("tool-cancellation")) return toolResponse("diagnostic_cancellation");
      return toolResponse();
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
