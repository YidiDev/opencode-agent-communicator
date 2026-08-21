import type { Server } from "bun";

import { diagnosticToolID, testModelID } from "./constants";

interface ProviderHarness {
  readonly baseUrl: string;
  readonly requests: readonly unknown[];
  stop(): Promise<void>;
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

function toolResponse(): Response {
  return eventStream([
    chunk({ role: "assistant" }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_live_diagnostic",
          type: "function",
          function: { name: diagnosticToolID, arguments: "{}" },
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

export function launchDeterministicProvider(): ProviderHarness {
  const requests: unknown[] = [];
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      const body: unknown = JSON.parse(await request.text());
      requests.push(body);
      return hasToolResult(body) ? textResponse() : toolResponse();
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    get requests(): readonly unknown[] {
      return requests;
    },
    async stop(): Promise<void> {
      await server.stop(true);
    },
  };
}
