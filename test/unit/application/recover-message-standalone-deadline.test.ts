import { expect, test } from "bun:test";

import { recoverMessageDeliveries } from "../../../src/application/recover-message-deliveries";
import type { MessageRecoveryPorts } from "../../../src/application/recover-message-delivery-phases";
import { validateDeliveryId, validateNativeMessageId } from "../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../src/domain/message-payload";
import { validateFencingToken } from "../../../src/domain/ownership";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid deadline fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:standalone-deadline"));
const fencingToken = valid(validateFencingToken(19));
const prepared = {
  id: valid(validateDeliveryId(`dlv_${"a".repeat(32)}`)),
  workspaceKey,
  sourceSessionId: valid(validateSessionId("ses_source")),
  targetSessionId: valid(validateSessionId("ses_target")),
  nativeMessageId: valid(validateNativeMessageId(`msg_${"b".repeat(32)}`)),
  state: "prepared" as const,
  contentByteLength: 1,
  contentSha256: "c".repeat(64) as Sha256Digest,
  createdAtMs: 1,
  updatedAtMs: 1,
};

for (const held of ["ownership", "list", "native"] as const) {
  test(`standalone deadline actively bounds held ${held} work`, async () => {
    let nowMs = 1;
    let timerCallback: (() => void) | undefined;
    let started = false;
    let preparedListed = false;
    const ports = {
      ownership: {
        acquire: async () => fencingToken,
        isCurrent: async () => true,
      },
      startupBarrier: {
        async establish() {
          return { established: true as const, fencingToken };
        },
      },
      deliveries: {
        async listRecoverable(input: { state: string }) {
          if (input.state === "submitting") return [];
          if (preparedListed) return [];
          preparedListed = true;
          return [prepared];
        },
        async claimPrepared() {
          return {
            ok: true as const,
            delivery: {
              ...prepared,
              state: "submitting" as const,
              submittedAtMs: 2,
              updatedAtMs: 2,
            },
            envelope: "{}",
          };
        },
      },
      membership: {
        async readCurrentRoots() {
          return { sourceVisible: true, targetVisible: true, sourceTitle: "source" };
        },
      },
      nativeQueue: {
        async queueMessage() {
          return { kind: "unknown" as const };
        },
      },
      clock: { nowMs: () => nowMs },
    } as unknown as MessageRecoveryPorts;
    if (held === "ownership") {
      ports.ownership.acquire = () => {
        started = true;
        return new Promise(() => undefined);
      };
    } else if (held === "list") {
      ports.deliveries.listRecoverable = () => {
        started = true;
        return new Promise(() => undefined);
      };
    } else {
      ports.nativeQueue.queueMessage = () => {
        started = true;
        return new Promise(() => undefined);
      };
    }
    const pending = recoverMessageDeliveries(ports, {
      workspaceKey,
      abort: new AbortController().signal,
      deadlineMs: 100,
      limit: 10,
      timers: {
        set(_delay, callback) {
          timerCallback = callback;
          return 1;
        },
        clear() {},
      },
    });
    while (!started) await Promise.resolve();
    nowMs = 100;
    timerCallback?.();
    expect(await pending).toMatchObject({ ok: false, error: { code: "ownership_lost" } });
  });
}
