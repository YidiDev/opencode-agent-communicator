import type { DeliveryId } from "./generated-ids";
import type { SessionId } from "./sessions";
import type { WorkspaceKey } from "./workspaces";

export const maximumMessageContentBytes = 32 * 1024;
export const messageProtocol = "opencode-session-communicator/v1" as const;

export type Sha256Digest = string & { readonly sha256Digest: unique symbol };

export interface Sha256DigestPort {
  /** Returns the raw 32-byte SHA-256 digest of input. */
  sha256(input: Uint8Array): Promise<Uint8Array>;
}

export type MessageContentValidation =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly byteLength: number }
  | { readonly ok: false; readonly message: string };

export interface VerifiedMessageEnvelopeInput {
  readonly sourceSessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly workspaceKey: WorkspaceKey;
  readonly deliveryId: DeliveryId;
  readonly content: string;
  readonly sourceTitle: string;
}

export const verifiedEnvelopeTrust = {
  provenance: "verified_by_communicator",
  payload: "untrusted_peer_content",
  display: "unverified_metadata",
  consequence: "normal_permissions_and_authorization_still_required",
} as const;

export function validateMessageContent(value: unknown): MessageContentValidation {
  if (typeof value !== "string") return { ok: false, message: "content must be a string." };
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > maximumMessageContentBytes) {
    return {
      ok: false,
      message: `content must not exceed ${maximumMessageContentBytes} UTF-8 bytes.`,
    };
  }
  return { ok: true, bytes, byteLength: bytes.length };
}

export async function digestMessageContent(
  port: Sha256DigestPort,
  bytes: Uint8Array,
): Promise<Sha256Digest> {
  const digest = await port.sha256(bytes);
  if (!(digest instanceof Uint8Array) || digest.length !== 32) {
    throw new Error("The SHA-256 port violated its 32-byte output contract.");
  }
  let encoded = "";
  for (const byte of digest) encoded += byte.toString(16).padStart(2, "0");
  return encoded as Sha256Digest;
}

export function serializeVerifiedMessageEnvelope(input: VerifiedMessageEnvelopeInput): string {
  return JSON.stringify({
    protocol: messageProtocol,
    operation: "message",
    source_session_id: input.sourceSessionId,
    target_session_id: input.targetSessionId,
    workspace_key: input.workspaceKey,
    delivery_id: input.deliveryId,
    payload: { content: input.content },
    display: { source_title: input.sourceTitle },
    trust: verifiedEnvelopeTrust,
  });
}
