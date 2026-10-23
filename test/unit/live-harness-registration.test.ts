import { expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { cleanupAll } from "../live/harness/cleanup";
import { waitForPackedRegistration } from "../live/harness/production-host";

function clientWithFetch(response: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  return OpenCode.make({
    baseUrl: "http://127.0.0.1:1",
    fetch: Object.assign(response, { preconnect: () => undefined }),
  });
}

test.each(["location", "plugin"] as const)(
  "aborts a stalled %s request and reaches acquisition cleanup",
  async (stage) => {
    const signals: AbortSignal[] = [];
    const cleaned: string[] = [];
    const client = clientWithFetch(async (input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("registration request is missing cancellation");
      signals.push(signal);
      if (stage === "plugin" && String(input).includes("/location")) return Response.json({});
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const acquisition = async () => {
      try {
        await waitForPackedRegistration(client, "/fixture", undefined, 30);
      } catch (failure) {
        await cleanupAll(
          [
            () => {
              cleaned.push("server");
            },
            () => {
              cleaned.push("installation");
            },
          ],
          failure,
        );
      }
    };
    await expect(acquisition()).rejects.toThrow("registration deadline exceeded");
    expect(signals).toHaveLength(stage === "location" ? 1 : 2);
    expect(signals.every((signal) => signal === signals[0] && signal.aborted)).toBe(true);
    expect(cleaned).toEqual(["server", "installation"]);
  },
);

test("successful registration clears the deadline and does not poison later requests", async () => {
  const signals: AbortSignal[] = [];
  const client = clientWithFetch(async (input, init) => {
    if (init?.signal) signals.push(init.signal);
    return Response.json(
      String(input).includes("/plugin") ? { data: [{ id: "opencode-agent-communicator" }] } : {},
    );
  });
  await waitForPackedRegistration(client, "/fixture", undefined, 30);
  await Bun.sleep(50);
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
  await client.plugin.list({ location: { directory: "/fixture" } });
  expect(signals).toHaveLength(2);
});

test("polling uses one deadline and handles a rejected file source", async () => {
  let polls = 0;
  const client = clientWithFetch(async (input) => {
    if (String(input).includes("/plugin")) polls += 1;
    return Response.json({ data: [] });
  });
  await waitForPackedRegistration(client, "/fixture", () => polls === 2, 500);
  expect(polls).toBe(2);
  await expect(waitForPackedRegistration(client, "/fixture", undefined, 30)).rejects.toThrow(
    "registration deadline exceeded",
  );
});
