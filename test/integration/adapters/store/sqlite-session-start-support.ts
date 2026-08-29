import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import type { StartLimits } from "../../../../src/application/session-start-ports";
import {
  validateManagedSessionId,
  validateNativeMessageId,
  validateStartOperationId,
} from "../../../../src/domain/generated-ids";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

export function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

export const workspace = valid(validateWorkspaceKey("workspace:start"));
export const source = valid(validateSessionId("ses_source"));
export const limits: StartLimits = {
  managedSessionsPerWorkspace: 2,
  unresolvedProvenancePerWorkspace: 4,
  operationsPerWorkspace: 4_096,
  payloadBytesPerWorkspace: 8 * 1_024 * 1_024,
  startsPerSourceWindow: 3,
  startsPerWorkspaceWindow: 3,
  rateWindowMs: 60_000,
  terminalRetentionMs: 86_400_000,
};

export function ids(index: number) {
  const encoded = index.toString(16).padStart(32, "0");
  return {
    operationId: valid(validateStartOperationId(`op_${encoded}`)),
    sessionId: valid(validateManagedSessionId(`ses_${encoded}`)),
    nativeMessageId: valid(validateNativeMessageId(`msg_${encoded}`)),
  };
}

export function openStore(now: () => number = () => 10_000) {
  const root = mkdtempSync(join(tmpdir(), "communicator-start-"));
  roots.push(root);
  return new LinuxBunSqliteStore({
    stateDirectory: join(root, "state"),
    workspaceKey: workspace,
    ownerId: "start-test",
    nowWallMs: now,
    nowMonotonicMs: now,
  });
}
