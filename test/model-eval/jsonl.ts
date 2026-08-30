import type { ToolCall } from "./types";

export interface ParsedJsonl {
  readonly events: readonly Record<string, unknown>[];
  readonly errors: readonly string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseJsonl(text: string): ParsedJsonl {
  const events: Record<string, unknown>[] = [];
  const errors: string[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (raw.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(raw);
      const event = record(value);
      if (event === undefined) errors.push(`line ${index + 1} is not a JSON object`);
      else events.push(event);
    } catch {
      errors.push(`line ${index + 1} is invalid JSON`);
    }
  }
  return { events, errors };
}

function parseOutput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function extractToolCalls(events: readonly Record<string, unknown>[]): ToolCall[] {
  return events.flatMap((event) => {
    const part = record(event.part);
    const state = record(part?.state);
    if (typeof part?.tool !== "string" || typeof state?.status !== "string") return [];
    return [
      {
        name: part.tool,
        status: state.status,
        input: state.input,
        output: parseOutput(state.output),
      },
    ];
  });
}

export function eventSessionId(events: readonly Record<string, unknown>[]): string | undefined {
  for (const event of events) {
    const part = record(event.part);
    const id = event.sessionID ?? event.sessionId ?? part?.sessionID ?? part?.sessionId;
    if (typeof id === "string") return id;
  }
  return undefined;
}

export function outputField(call: ToolCall, field: string): string | undefined {
  const output = record(call.output);
  const value = record(output?.value);
  const candidate = value?.[field] ?? output?.[field];
  return typeof candidate === "string" ? candidate : undefined;
}
