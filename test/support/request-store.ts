import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LinuxBunSqliteStore } from "../../src/adapters/store/sqlite-store";
import type { LinuxBunSqliteStoreOptions } from "../../src/adapters/store/store-types";
import type { PrepareRequestInput } from "../../src/application/request-ports";
import { createGeneratedIdFactory } from "../../src/domain/generated-ids";
import type { Sha256DigestPort } from "../../src/domain/message-payload";
import type { FencingToken } from "../../src/domain/ownership";
import {
  canonicalizeSerializeAndDigestPendingRequestPayload,
  serializeVerifiedRequestEnvelope,
} from "../../src/domain/request-serialization";
import type { PendingRequestMetadata } from "../../src/domain/request-types";
import { validateSessionId } from "../../src/domain/sessions";
import { validateWorkspaceKey, type WorkspaceKey } from "../../src/domain/workspaces";

export const requestTestNowMs = 25_000;
const temporaryRoots: string[] = [];
const digest: Sha256DigestPort = {
  sha256: async (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest()),
};

export function cleanupRequestStoreRoots(): void {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function requestTestWorkspace(): WorkspaceKey {
  const workspace = validateWorkspaceKey("request-test");
  if (!workspace.ok) throw new Error(workspace.message);
  return workspace.value;
}

export function requestTemporaryRoot(prefix = "request-store-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

export function requestClock(initialMs = requestTestNowMs): {
  readonly wall: () => number;
  readonly monotonic: () => number;
  readonly set: (value: number) => void;
} {
  let nowMs = initialMs;
  return {
    wall: () => nowMs,
    monotonic: () => nowMs,
    set: (value) => {
      nowMs = value;
    },
  };
}

export function openRequestStore(
  options: Partial<LinuxBunSqliteStoreOptions> = {},
): LinuxBunSqliteStore {
  const now = options.nowWallMs ?? (() => requestTestNowMs);
  return new LinuxBunSqliteStore({
    stateDirectory: options.stateDirectory ?? join(requestTemporaryRoot(), "state"),
    workspaceKey: options.workspaceKey ?? requestTestWorkspace(),
    nowWallMs: now,
    nowMonotonicMs: options.nowMonotonicMs ?? (() => requestTestNowMs),
    ...options,
  });
}

function session(value: string) {
  const result = validateSessionId(value);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function identities(seed: number) {
  let next = seed;
  return createGeneratedIdFactory({
    randomBytes: (length) => {
      const bytes = new Uint8Array(length);
      bytes.fill(next);
      next += 1;
      return bytes;
    },
  });
}

export async function requestFixture(
  token: FencingToken,
  createdAtMs = 1_000,
  sourceName = "ses_source",
  targetName = "ses_target",
  workspaceKey = requestTestWorkspace(),
): Promise<PrepareRequestInput> {
  const ids = identities(createdAtMs % 251);
  const sourceSessionId = session(sourceName);
  const targetSessionId = session(targetName);
  const id = ids.requestId();
  const nativeMessageId = ids.nativeMessageId();
  const payload = await canonicalizeSerializeAndDigestPendingRequestPayload(digest, {
    kind: "wait",
    milestone: "compiled ✓",
    timeoutSeconds: 30,
  });
  if (!payload.ok) throw new Error(payload.message);
  const deadlineAtMs = createdAtMs + 30_000;
  const request: PendingRequestMetadata & { readonly deliveryState: "prepared" } = {
    id,
    workspaceKey,
    sourceSessionId,
    targetSessionId,
    nativeMessageId,
    kind: "wait",
    resolutionState: "pending",
    deliveryState: "prepared",
    resultState: "none",
    payloadByteLength: payload.byteLength,
    payloadSha256: payload.sha256,
    createdAtMs,
    updatedAtMs: createdAtMs,
    deadlineAtMs,
  };
  const envelopeJson = await serializeVerifiedRequestEnvelope(
    {
      requestId: id,
      nativeMessageId,
      sourceSessionId,
      targetSessionId,
      workspaceKey,
      createdAtMs,
      deadlineAtMs,
      payload: payload.value,
    },
    digest,
  );
  return { fencingToken: token, request, payloadJson: payload.serialized, envelopeJson };
}

export { digest as requestDigestPort, serializeVerifiedRequestEnvelope };
