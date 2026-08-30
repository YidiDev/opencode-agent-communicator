import { expect } from "bun:test";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { liveDeadlineMs, testModelID, testProviderID } from "./harness/constants";

type Client = ReturnType<typeof createOpencodeClient>;

interface ReadOutput {
  readonly ok: boolean;
  readonly value?: {
    readonly content?: unknown;
    readonly end_cursor?: unknown;
    readonly is_live?: unknown;
    readonly session_id?: unknown;
  };
}

function successful<T>(
  result: { readonly data: T | undefined; readonly error?: unknown; readonly response: Response },
  label: string,
): NonNullable<T> {
  if (result.error !== undefined || result.data === undefined) {
    throw new Error(`${label} failed (${result.response.status})`);
  }
  return result.data as NonNullable<T>;
}

async function runJourney(input: {
  createSession(title: string): Promise<string>;
  completePrompt(sessionID: string, text: string): Promise<void>;
  invoke(marker: string, callerSessionID: string): Promise<Record<string, unknown>>;
}): Promise<void> {
  const caller = await input.createSession("Packed session read caller");
  const self = (await input.invoke(
    `production-session-read-self:${caller}`,
    caller,
  )) as unknown as ReadOutput;
  expect(self).toMatchObject({ ok: true, value: { session_id: caller, is_live: true } });
  expect(self.value?.content).toBeString();

  const target = await input.createSession("Packed session read target");
  await input.completePrompt(target, "packed session read first progress");
  const cross = (await input.invoke(
    `production-session-read-cross:${target}`,
    caller,
  )) as unknown as ReadOutput;
  expect(cross).toMatchObject({ ok: true, value: { session_id: target, is_live: false } });
  expect(cross.value?.content).toContain("packed first progress complete");
  expect(cross.value?.content).not.toContain("packed second progress complete");
  expect(cross.value?.content).not.toContain("packed session read first progress");
  const cursor = cross.value?.end_cursor;
  expect(cursor).toBeString();
  if (typeof cursor !== "string") throw new Error("packed session read cursor is absent");

  await input.completePrompt(target, "packed session read second progress");
  const after = (await input.invoke(
    `production-session-read-after:${target}:${cursor}`,
    caller,
  )) as unknown as ReadOutput;
  expect(after).toMatchObject({ ok: true, value: { session_id: target, is_live: false } });
  expect(after.value?.content).toContain("packed second progress complete");
  expect(after.value?.content).not.toContain("packed first progress complete");
  expect(after.value?.content).not.toContain("packed session read second progress");
}

export async function runPackedSessionReadJourney(input: {
  readonly client: Client;
  invoke(marker: string, callerSessionID: string): Promise<Record<string, unknown>>;
}): Promise<void> {
  let sessionSequence = 0;
  let messageSequence = 0;
  await runJourney({
    async createSession(title) {
      sessionSequence += 1;
      const created = successful(
        await input.client.v2.session.create({
          id: `ses_01PACKEDREAD00000000000000${sessionSequence}`,
          model: { providerID: testProviderID, id: testModelID },
          agent: "build",
        }),
        title,
      );
      return created.data.id;
    },
    async completePrompt(sessionID, text) {
      messageSequence += 1;
      const expectedText = text.includes("first")
        ? "packed first progress complete"
        : "packed second progress complete";
      successful(
        await input.client.v2.session.prompt({
          sessionID,
          id: `msg_01PACKEDREAD00000000000000${messageSequence}`,
          prompt: { text },
          delivery: "queue",
          resume: true,
        }),
        "session read target prompt",
      );
      const deadline = performance.now() + liveDeadlineMs;
      while (performance.now() < deadline) {
        const page = successful(
          await input.client.v2.session.messages({ sessionID, order: "desc" }),
          "session read target messages",
        );
        const completed = page.data.some(
          (message) =>
            message.type === "assistant" &&
            message.content.some((part) => part.type === "text" && part.text === expectedText),
        );
        const status = successful(
          await input.client.session.status(),
          "session read target status",
        )[sessionID];
        if (completed && (status === undefined || status.type === "idle")) {
          return;
        }
        await Bun.sleep(20);
      }
      throw new Error("session read target completion deadline exceeded");
    },
    invoke: input.invoke,
  });
}
