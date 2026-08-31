import { expect } from "bun:test";
import { createOpencodeClient as createLegacyOpencodeClient } from "@opencode-ai/sdk/client";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { createOpenCode118NativeAdapter } from "../../src/adapters/native/opencode-1-18";
import { validateSessionId } from "../../src/domain/sessions";
import { validateWorkspaceKey } from "../../src/domain/workspaces";

type Client = ReturnType<typeof createOpencodeClient>;

function successful<T>(
  result: { readonly data: T | undefined; readonly error?: unknown; readonly response: Response },
  label: string,
): NonNullable<T> {
  if (result.error !== undefined || result.data === undefined) {
    throw new Error(`${label} failed (${result.response.status}): ${JSON.stringify(result.error)}`);
  }
  return result.data as NonNullable<T>;
}

export async function proveProjectedMessagePagination(input: {
  readonly baseUrl: string;
  readonly client: Client;
  readonly project: string;
  createSession(id: string, title: string): Promise<string>;
  completePrompt(sessionID: string, messageID: string, text: string): Promise<void>;
}): Promise<void> {
  const sessionID = await input.createSession(
    "ses_01SESSIONREADLIVE0000000001",
    "session read pagination",
  );
  const promptMarkers: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const marker = `session-read-live-${index}`;
    promptMarkers.push(marker);
    await input.completePrompt(sessionID, `msg_01SESSIONREADLIVE00000000${index}`, marker);
  }

  const first = successful(
    await input.client.v2.session.messages({ sessionID, limit: 2, order: "desc" }),
    "session read newest projected page",
  );
  expect(first.data).toHaveLength(2);
  expect(first.cursor.next).toBeString();
  const nextCursor = first.cursor.next;
  if (!nextCursor) throw new Error("session read next cursor is absent");
  const firstIDs = first.data.map((message) => message.id);
  expect(new Set(firstIDs).size).toBe(firstIDs.length);

  const second = successful(
    await input.client.v2.session.messages({ sessionID, limit: 2, cursor: nextCursor }),
    "session read continued projected page",
  );
  expect(second.data).toHaveLength(2);
  expect(second.cursor.previous).toBeString();
  const previousCursor = second.cursor.previous;
  if (!previousCursor) throw new Error("session read previous cursor is absent");
  const secondIDs = second.data.map((message) => message.id);
  expect(secondIDs.some((id) => firstIDs.includes(id))).toBe(false);

  const resumed = successful(
    await input.client.v2.session.messages({ sessionID, limit: 2, cursor: previousCursor }),
    "session read reverse projected page",
  );
  expect(resumed.data.map((message) => message.id)).toEqual(firstIDs);

  const newest = first.data.find((message) => message.type === "assistant");
  if (!newest) throw new Error("session read newest assistant projection is absent");
  const fixed = successful(
    await input.client.v2.session.message({ sessionID, messageID: newest.id }),
    "session read fixed projected message",
  );
  expect(fixed.data.id).toBe(newest.id);
  if (fixed.data.type !== "assistant") {
    throw new Error("session read fixed projection changed type");
  }
  expect(fixed.data.content.map((part) => part.id)).toEqual(newest.content.map((part) => part.id));

  const workspace = validateWorkspaceKey("workspace:phase0-session-read");
  const validatedSessionID = validateSessionId(sessionID);
  if (!workspace.ok || !validatedSessionID.ok) {
    throw new Error("session read live adapter fixture is invalid");
  }
  const adapter = createOpenCode118NativeAdapter({
    client: createLegacyOpencodeClient({ baseUrl: input.baseUrl, directory: input.project }),
    directory: input.project,
    projectId: input.project,
    serverUrl: new URL(input.baseUrl),
    workspaceKey: workspace.value,
  });
  const adapterSource = successful(
    await input.client.v2.session.messages({ sessionID, limit: 8, order: "desc" }),
    "session read adapter source page",
  );
  const sourcePartIDs = adapterSource.data.flatMap((message) =>
    message.type === "assistant" ? message.content.map((part) => part.id) : [],
  );
  expect(sourcePartIDs.every((id) => /^[\x21-\x7e]+$/.test(id))).toBe(true);
  const projected = await adapter.readMessagePage({
    workspaceKey: workspace.value,
    sessionId: validatedSessionID.value,
    order: "desc",
    abort: new AbortController().signal,
  });
  const serialized = JSON.stringify(projected);
  expect(serialized).toContain("gate-");
  for (const marker of promptMarkers) expect(serialized).not.toContain(marker);
}
