import { communicatorToolIds } from "../../src/composition/tools";
import { latestSoakUserText, soakCompactionSummary } from "./compaction";

export const soakMarker = "communicator-soak:";

function fixtureEnvelope(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 12) return undefined;
  if (typeof value === "string") {
    try {
      return fixtureEnvelope(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object" || value === null) return undefined;
  if ("protocol" in value && value.protocol === "opencode-session-communicator/v1")
    return value as Record<string, unknown>;
  for (const item of Object.values(value)) {
    const found = fixtureEnvelope(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function decodeBlockingFixture(
  body: unknown,
): { name: string; arguments: string } | undefined {
  if (
    typeof body !== "object" ||
    body === null ||
    !("messages" in body) ||
    !Array.isArray(body.messages) ||
    !("tools" in body) ||
    !Array.isArray(body.tools)
  )
    return undefined;
  const last = body.messages.at(-1);
  if (last?.role !== "user") return undefined;
  const envelope = fixtureEnvelope(latestSoakUserText(body));
  if (
    !envelope ||
    typeof envelope.request_id !== "string" ||
    !/^req_[a-z0-9]+$/.test(envelope.request_id)
  )
    return undefined;
  const serialized = JSON.stringify(envelope.payload ?? {});
  const name =
    envelope.operation === "ask" && serialized.includes("Synthetic blocking soak choice")
      ? "session_respond"
      : envelope.operation === "wait" && serialized.includes("synthetic-blocking-ready")
        ? "session_signal"
        : undefined;
  if (!name || !body.tools.some((tool) => tool?.function?.name === name)) return undefined;
  return {
    name,
    arguments: JSON.stringify(
      name === "session_respond"
        ? { request_id: envelope.request_id, answers: [["yes"]] }
        : { request_id: envelope.request_id, evidence: "artifact://synthetic-soak" },
    ),
  };
}

export function decodeSoakCall(body: unknown): { name: string; arguments: string } | undefined {
  if (
    typeof body !== "object" ||
    body === null ||
    !("messages" in body) ||
    !("tools" in body) ||
    !Array.isArray(body.tools)
  )
    return undefined;
  const messages = body.messages;
  if (!Array.isArray(messages)) return undefined;
  const last: unknown = messages.at(-1);
  if (typeof last !== "object" || last === null || !("role" in last) || last.role !== "user")
    return undefined;
  if (!("content" in last)) return undefined;
  const content = latestSoakUserText(body);
  if (!content?.startsWith(soakMarker)) return undefined;
  const call: unknown = JSON.parse(content.slice(soakMarker.length));
  if (
    typeof call !== "object" ||
    call === null ||
    !("name" in call) ||
    typeof call.name !== "string" ||
    !communicatorToolIds.includes(call.name as (typeof communicatorToolIds)[number]) ||
    !("arguments" in call) ||
    typeof call.arguments !== "object" ||
    call.arguments === null ||
    Array.isArray(call.arguments)
  )
    throw new Error("Invalid soak tool command");
  if (!body.tools.some((tool) => tool?.function?.name === call.name)) return undefined;
  return { name: call.name, arguments: JSON.stringify(call.arguments) };
}

export function launchSoakProvider() {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 8 * 1024 * 1024,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
        return new Response("not found", { status: 404 });
      requests++;
      const body: unknown = await request.json();
      // No prompts, answers, tool payloads, or HTTP credentials are retained.
      const summary = soakCompactionSummary(body);
      const call = summary ? undefined : (decodeSoakCall(body) ?? decodeBlockingFixture(body));
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
                type: "function",
                function: call,
              },
            ],
          }
        : { content: summary ?? "Isolated deterministic soak response; peer idle." };
      const chunk = (value: unknown, reason: string | null) => ({
        id: "chatcmpl-soak",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: "deterministic-model",
        choices: [{ index: 0, delta: value, finish_reason: reason }],
      });
      const lines = [
        chunk({ role: "assistant" }, null),
        chunk(delta, null),
        chunk({}, call ? "tool_calls" : "stop"),
      ];
      return new Response(
        `${lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("")}data: [DONE]\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests: () => requests,
    stop: () => server.stop(true),
  };
}
