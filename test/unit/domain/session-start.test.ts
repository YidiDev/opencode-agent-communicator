import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  canonicalStartArguments,
  digestStartArguments,
  sessionStartValidationPolicy,
  validateStartAgent,
  validateStartIdempotencyKey,
  validateStartInitialMessage,
  validateStartModel,
  validateStartTitle,
} from "../../../src/domain/session-start";
import { createSessionStartPolicy } from "../../../src/domain/session-start-policy";

const digest = {
  async sha256(input: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(createHash("sha256").update(input).digest());
  },
};

describe("session start arguments", () => {
  test("freezes strict bounded validators", () => {
    expect(Object.isFrozen(sessionStartValidationPolicy)).toBe(true);
    expect(validateStartIdempotencyKey("start:one").ok).toBe(true);
    expect(validateStartIdempotencyKey(" bad").ok).toBe(false);
    expect(validateStartIdempotencyKey("a".repeat(129)).ok).toBe(false);
    expect(validateStartInitialMessage("").ok).toBe(false);
    expect(validateStartInitialMessage("x".repeat(32 * 1024)).ok).toBe(true);
    expect(validateStartInitialMessage("x".repeat(32 * 1024 + 1)).ok).toBe(false);
    expect(validateStartTitle("x".repeat(512)).ok).toBe(true);
    expect(validateStartTitle("x".repeat(513)).ok).toBe(false);
    expect(validateStartAgent("build-agent").ok).toBe(true);
    expect(validateStartModel("provider/model").ok).toBe(true);
    expect(validateStartModel("provider model").ok).toBe(false);
  });

  test("uses a domain-separated canonical digest with explicit omitted values", async () => {
    const input = { idempotencyKey: "one", initialMessage: "work" };
    const canonical = new TextDecoder().decode(canonicalStartArguments(input));
    expect(canonical).toContain("opencode-session-communicator/session_start/arguments/v1");
    expect(canonical).toContain('"title":null');
    const first = await digestStartArguments(digest, input);
    const repeated = await digestStartArguments(digest, input);
    const changed = await digestStartArguments(digest, { ...input, title: "Work" });
    expect(first).toBe(repeated);
    expect(changed).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("session start policy", () => {
  test("defaults to no overrides, recursion denied, and bounded limits", () => {
    const policy = createSessionStartPolicy();
    expect(policy.allowedAgents.size).toBe(0);
    expect(policy.allowedModels.size).toBe(0);
    expect(policy.allowManagedSessionRecursion).toBe(false);
    expect(policy.limits).toMatchObject({
      operationsPerWorkspace: 4_096,
      payloadBytesPerWorkspace: 8 * 1_024 * 1_024,
      terminalRetentionMs: 86_400_000,
    });
    expect(() =>
      createSessionStartPolicy({ limits: { managedSessionsPerWorkspace: 1_025 } }),
    ).toThrow("immutable safety ceiling");
    expect(() => createSessionStartPolicy({ limits: { operationsPerWorkspace: 4_097 } })).toThrow(
      "immutable safety ceiling",
    );
    expect(() =>
      createSessionStartPolicy({ limits: { payloadBytesPerWorkspace: 32 * 1_024 * 1_024 + 1 } }),
    ).toThrow("immutable safety ceiling");
    expect(() =>
      createSessionStartPolicy({ limits: { terminalRetentionMs: 30 * 86_400_000 + 1 } }),
    ).toThrow("immutable safety ceiling");
    expect(() => createSessionStartPolicy({ allowedAgents: ["same", "same"] })).toThrow();
  });

  test("preserves exact case-sensitive allowlists", () => {
    const policy = createSessionStartPolicy({
      allowedAgents: ["Build"],
      allowedModels: ["provider/Model"],
    });
    expect(policy.allowedAgents.has("Build")).toBe(true);
    expect(policy.allowedAgents.has("build")).toBe(false);
    expect(policy.allowedModels.has("provider/Model")).toBe(true);
  });
});
