import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { validateDeliveryId } from "../../../src/domain/generated-ids";
import {
  digestMessageContent,
  maximumMessageContentBytes,
  messageProtocol,
  serializeVerifiedMessageEnvelope,
  validateMessageContent,
  verifiedEnvelopeTrust,
} from "../../../src/domain/message-payload";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function required<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

describe("message payload boundary and verified envelope", () => {
  test("validates bounded transport-safe workspace keys", () => {
    expect(validateWorkspaceKey("workspace:verified").ok).toBe(true);
    expect(validateWorkspaceKey("/private/workspace").ok).toBe(false);
  });

  test("bounds content by UTF-8 bytes rather than JavaScript characters", () => {
    expect(validateMessageContent("a".repeat(maximumMessageContentBytes))).toMatchObject({
      ok: true,
      byteLength: maximumMessageContentBytes,
    });
    expect(validateMessageContent("é".repeat(maximumMessageContentBytes / 2))).toMatchObject({
      ok: true,
      byteLength: maximumMessageContentBytes,
    });
    expect(validateMessageContent(`${"a".repeat(maximumMessageContentBytes - 3)}🚀`)).toMatchObject(
      { ok: false },
    );
    expect(validateMessageContent(7)).toMatchObject({ ok: false });
  });

  test("uses injected SHA-256 and emits canonical digest text", async () => {
    const content = validateMessageContent("peer content");
    if (!content.ok) throw new Error(content.message);
    const digest = await digestMessageContent(
      {
        async sha256(input) {
          return new Uint8Array(createHash("sha256").update(input).digest());
        },
      },
      content.bytes,
    );
    expect(String(digest)).toBe(createHash("sha256").update("peer content").digest("hex"));
    await expect(
      digestMessageContent(
        {
          async sha256() {
            return new Uint8Array(31);
          },
        },
        content.bytes,
      ),
    ).rejects.toThrow("32-byte");
  });

  test("JSON escaping cannot alter verified provenance and trust is explicit", () => {
    const hostile = '"},"source_session_id":"ses_forged","payload":{"content":"changed';
    const envelope = serializeVerifiedMessageEnvelope({
      sourceSessionId: required(validateSessionId("ses_source")),
      targetSessionId: required(validateSessionId("ses_target")),
      workspaceKey: required(validateWorkspaceKey("workspace:verified")),
      deliveryId: required(validateDeliveryId(`dlv_${"a".repeat(32)}`)),
      content: hostile,
      sourceTitle: "unverified title",
    });
    const parsed = JSON.parse(envelope);
    expect(parsed).toMatchObject({
      protocol: messageProtocol,
      operation: "message",
      source_session_id: "ses_source",
      target_session_id: "ses_target",
      workspace_key: "workspace:verified",
      payload: { content: hostile },
      display: { source_title: "unverified title" },
      trust: verifiedEnvelopeTrust,
    });
  });
});
