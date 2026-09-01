import { expect } from "bun:test";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { testModelID, testProviderID } from "./harness/constants";
import type { ProviderHarness } from "./harness/provider";

type Client = ReturnType<typeof createOpencodeClient>;

function successful<T>(
  result: { readonly data: T | undefined; readonly error?: unknown; readonly response: Response },
  label: string,
): NonNullable<T> {
  if (result.error !== undefined || result.data === undefined) {
    throw new Error(`${label} failed (${result.response.status})`);
  }
  return result.data as NonNullable<T>;
}

function advertisedToolIds(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const tools = Reflect.get(body, "tools");
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const function_ = Reflect.get(candidate, "function");
    if (typeof function_ !== "object" || function_ === null) return [];
    const name = Reflect.get(function_, "name");
    return typeof name === "string" ? [name] : [];
  });
}

export async function runPackedPrimaryToolsJourney(input: {
  readonly client: Client;
  readonly communicatorToolIds: readonly string[];
  readonly provider: ProviderHarness;
}): Promise<void> {
  const session = successful(
    await input.client.session.create({ title: "Packed primary tools" }),
    "primary tools caller",
  );
  successful(
    await input.client.session.prompt({
      sessionID: session.id,
      model: { providerID: testProviderID, modelID: testModelID },
      agent: "build",
      tools: { task: true },
      parts: [{ type: "text", text: "production-primary-tools-parent" }],
    }),
    "primary tools prompt",
  );

  const parentRequest = input.provider.requests.find((request) => {
    const serialized = JSON.stringify(request);
    return (
      serialized.includes("production-primary-tools-parent") &&
      advertisedToolIds(request).includes("task")
    );
  });
  const childRequest = input.provider.requests.find((request) =>
    JSON.stringify(request).includes("production-primary-tools-child"),
  );
  expect(parentRequest).toBeDefined();
  expect(childRequest).toBeDefined();
  const parentTools = advertisedToolIds(parentRequest);
  const childTools = advertisedToolIds(childRequest);
  expect(parentTools).toEqual(expect.arrayContaining([...input.communicatorToolIds]));
  for (const toolId of input.communicatorToolIds) expect(childTools).not.toContain(toolId);
  expect(childTools).toEqual(expect.arrayContaining(["read", "bash"]));

  const messages = successful(
    await input.client.session.messages({ sessionID: session.id }),
    "primary tools messages",
  );
  expect(JSON.stringify(messages)).toContain("production native child result");
}
