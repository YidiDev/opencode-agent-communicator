import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { ContextAdmissionPersistencePort } from "../../../../src/application/context-admission-ports";
import type { PrepareDeliveryInput } from "../../../../src/application/delivery-ports";
import {
  validateAdvisoryLockId,
  validateDeliveryId,
  validateNativeMessageId,
} from "../../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../../src/domain/message-payload";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestSession,
  requestTestWorkspace,
  requestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

function digest(value: string): Sha256Digest {
  return createHash("sha256").update(value).digest("hex") as Sha256Digest;
}

function deliveryId(index: number) {
  const result = validateDeliveryId(`dlv_${index.toString(16).padStart(32, "0")}`);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function messageInput(
  fencingToken: Parameters<
    ContextAdmissionPersistencePort["createContextMessage"]
  >[0]["fencingToken"],
  index: number,
  content = `message-${index}`,
) {
  const envelopeJson = JSON.stringify({ content });
  return {
    fencingToken,
    id: deliveryId(index),
    workspaceKey: requestTestWorkspace(),
    sourceSessionId: requestSession("ses_source"),
    targetSessionId: requestSession("ses_target"),
    envelopeJson,
    contentByteLength: new TextEncoder().encode(envelopeJson).length,
    contentSha256: digest(envelopeJson),
    createdAtMs: 20_000 + index,
  } as const;
}

function nativeInput(
  fencingToken: PrepareDeliveryInput["fencingToken"],
  index: number,
): PrepareDeliveryInput {
  const nativeMessageId = validateNativeMessageId(`msg_${index.toString(16).padStart(32, "0")}`);
  if (!nativeMessageId.ok) throw new Error(nativeMessageId.message);
  const envelope = JSON.stringify({ content: `native-${index}` });
  return {
    fencingToken,
    id: deliveryId(index),
    workspaceKey: requestTestWorkspace(),
    sourceSessionId: requestSession("ses_source"),
    targetSessionId: requestSession("ses_target"),
    nativeMessageId: nativeMessageId.value,
    envelope,
    contentByteLength: new TextEncoder().encode(envelope).length,
    contentSha256: digest(envelope),
    nowMs: 25_000,
  };
}

test("rejects malformed context operations before mutation", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const valid = messageInput(token, 1);

  expect(
    await store.createContextMessage({ ...valid, sourceSessionId: valid.targetSessionId }),
  ).toEqual({ ok: false, code: "state_conflict" });
  expect(await store.createContextMessage({ ...valid, envelopeJson: "not-json" })).toEqual({
    ok: false,
    code: "state_conflict",
  });
  expect(await store.createContextMessage({ ...valid, createdAtMs: 30_000 })).toEqual({
    ok: false,
    code: "state_conflict",
  });

  const foreignWorkspace = requestWorkspace("context-foreign");
  expect(
    await store.getContextAdmission({
      fencingToken: token,
      workspaceKey: foreignWorkspace,
      id: valid.id,
    }),
  ).toBeUndefined();
  expect(
    await store.cancelContextAdmission({
      fencingToken: token,
      workspaceKey: foreignWorkspace,
      id: valid.id,
    }),
  ).toEqual({ ok: false, code: "state_conflict" });

  for (const input of [
    { targetSessionId: "invalid", limit: 1, maximumBytes: 1 },
    { targetSessionId: valid.targetSessionId, limit: 0, maximumBytes: 1 },
    { targetSessionId: valid.targetSessionId, limit: 33, maximumBytes: 1 },
    { targetSessionId: valid.targetSessionId, limit: 1, maximumBytes: 0 },
  ]) {
    expect(
      await store.listPendingContext({
        fencingToken: token,
        workspaceKey: valid.workspaceKey,
        ...input,
      } as never),
    ).toEqual([]);
  }

  expect(
    await store.claimPendingContext({
      fencingToken: token,
      workspaceKey: valid.workspaceKey,
      targetSessionId: valid.targetSessionId,
      items: Array.from({ length: 33 }, () => ({
        id: valid.id,
        kind: "message" as const,
        contentSha256: valid.contentSha256,
      })),
    }),
  ).toEqual([]);
  expect(
    await store.claimPendingContext({
      fencingToken: token,
      workspaceKey: valid.workspaceKey,
      targetSessionId: valid.targetSessionId,
      items: [],
    }),
  ).toEqual([]);
  expect(
    await store.failPendingContextForParticipant({
      fencingToken: token,
      workspaceKey: valid.workspaceKey,
      participantSessionId: valid.targetSessionId,
      limit: 0,
    }),
  ).toEqual([]);
  await expect(
    store.settlePendingContextForParticipant({
      fencingToken: token,
      workspaceKey: valid.workspaceKey,
      participantSessionId: valid.targetSessionId,
      terminalParticipantSessionIds: [valid.targetSessionId, valid.targetSessionId],
      limit: 1,
    }),
  ).rejects.toThrow("terminal set was malformed");
  store.close();
});

test("enforces snapshot byte budgets and detects retained payload tampering", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const first = messageInput(token, 2, "first");
  const second = messageInput(token, 3, "second");
  await store.createContextMessage(first);
  await store.createContextMessage(second);

  expect(
    await store.listPendingContext({
      fencingToken: token,
      workspaceKey: first.workspaceKey,
      targetSessionId: first.targetSessionId,
      limit: 10,
      maximumBytes: first.contentByteLength,
    }),
  ).toMatchObject([{ id: first.id }]);

  const database = new Database(store.databasePath, { strict: true });
  database.run("UPDATE context_admissions SET payload_json = ? WHERE id = ?", ["{}", first.id]);
  database.close(true);
  await expect(
    store.listPendingContext({
      fencingToken: token,
      workspaceKey: first.workspaceKey,
      targetSessionId: first.targetSessionId,
      limit: 10,
      maximumBytes: 65_536,
    }),
  ).rejects.toThrow("payload failed trust validation");
  store.close();
});

test("selects a valid context envelope larger than the former transform budget", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const large = messageInput(token, 30, "x".repeat(50 * 1_024));
  const later = messageInput(token, 31, "later");
  expect(await store.createContextMessage(large)).toMatchObject({ ok: true });
  expect(await store.createContextMessage(later)).toMatchObject({ ok: true });

  expect(
    await store.listPendingContext({
      fencingToken: token,
      workspaceKey: large.workspaceKey,
      targetSessionId: large.targetSessionId,
      limit: 10,
      maximumBytes: 65_536,
    }),
  ).toMatchObject([{ id: large.id }, { id: later.id }]);
  store.close();
});

test("rejects duplicate and mismatched context claims atomically", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const input = messageInput(token, 4);
  await store.createContextMessage(input);
  const item = { id: input.id, kind: "message" as const, contentSha256: input.contentSha256 };

  await expect(
    store.claimPendingContext({
      fencingToken: token,
      workspaceKey: input.workspaceKey,
      targetSessionId: input.targetSessionId,
      items: [item, item],
    }),
  ).rejects.toThrow("contained duplicates");
  expect(
    await store.claimPendingContext({
      fencingToken: token,
      workspaceKey: input.workspaceKey,
      targetSessionId: input.targetSessionId,
      items: [{ ...item, contentSha256: digest("wrong") }],
    }),
  ).toEqual([]);
  expect(
    await store.claimPendingContext({
      fencingToken: token,
      workspaceKey: input.workspaceKey,
      targetSessionId: input.targetSessionId,
      items: [{ ...item, kind: "request" }],
    }),
  ).toEqual([]);
  expect(
    await store.getContextAdmission({
      fencingToken: token,
      workspaceKey: input.workspaceKey,
      id: input.id,
    }),
  ).toMatchObject({ state: "awaiting_context" });
  store.close();
});

test("shares delivery record, byte, and rate quotas across context and native messages", async () => {
  const recordStore = openRequestStore({
    limits: {
      deliveryRecordsPerWorkspace: 1,
      deliveryRecordsPerSource: 100,
      deliveryRecordsPerTarget: 100,
    },
  });
  const recordToken = await recordStore.acquire();
  expect(await recordStore.createContextMessage(messageInput(recordToken, 20))).toMatchObject({
    ok: true,
  });
  expect(await recordStore.createPrepared(nativeInput(recordToken, 21))).toEqual({
    ok: false,
    code: "quota_exceeded",
  });
  recordStore.close();

  const byteStore = openRequestStore({
    limits: {
      retainedEnvelopeBytesPerWorkspace: 25,
      retainedEnvelopeBytesPerSource: 1_000,
      retainedEnvelopeBytesPerTarget: 1_000,
    },
  });
  const byteToken = await byteStore.acquire();
  expect(await byteStore.createContextMessage(messageInput(byteToken, 22, "x"))).toMatchObject({
    ok: true,
  });
  expect(await byteStore.createPrepared(nativeInput(byteToken, 23))).toEqual({
    ok: false,
    code: "quota_exceeded",
  });
  byteStore.close();

  const rateStore = openRequestStore({
    limits: {
      deliveryRecordsPerWorkspace: 100,
      deliveryRecordsPerSource: 100,
      deliveryRecordsPerTarget: 100,
      deliveriesPerWorkspaceWindow: 1,
      deliveriesPerSourceWindow: 100,
      deliveriesPerTargetWindow: 100,
    },
  });
  const rateToken = await rateStore.acquire();
  expect(await rateStore.createPrepared(nativeInput(rateToken, 24))).toMatchObject({ ok: true });
  expect(await rateStore.createContextMessage(messageInput(rateToken, 25))).toEqual({
    ok: false,
    code: "rate_limited",
  });
  rateStore.close();
});

test("reports active-lock reminders and validates reminder bounds", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const targetSessionId = requestSession("ses_target");
  const workspaceKey = requestTestWorkspace();
  const lockId = validateAdvisoryLockId(`lck_${"1".repeat(32)}`);
  if (!lockId.ok) throw new Error(lockId.message);
  await store.publish({
    fencingToken: token,
    workspaceKey,
    lockId: lockId.value,
    holderSessionId: targetSessionId,
    title: "Context transform",
    description: "Protect context mutation.",
    instructions: "Coordinate before changing the same context.",
    ttlSeconds: 60,
  });
  expect(
    await store.readContextReminders({
      fencingToken: token,
      workspaceKey,
      targetSessionId,
      resultLimit: 10,
    }),
  ).toEqual({ activeLockCount: 1, availableResults: [] });
  expect(
    await store.readContextReminders({
      fencingToken: token,
      workspaceKey,
      targetSessionId,
      resultLimit: 0,
    }),
  ).toEqual({ activeLockCount: 0, availableResults: [] });
  expect(
    await store.readContextReminders({
      fencingToken: token,
      workspaceKey,
      targetSessionId,
      resultLimit: 21,
    }),
  ).toEqual({ activeLockCount: 0, availableResults: [] });
  store.close();
});

test("fails pending messages involving a removed participant and supports message cancellation", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const target = messageInput(token, 5);
  const source = {
    ...messageInput(token, 6),
    sourceSessionId: target.targetSessionId,
    targetSessionId: target.sourceSessionId,
  };
  const cancelled = messageInput(token, 7);
  await store.createContextMessage(target);
  await store.createContextMessage(source);
  await store.createContextMessage(cancelled);

  expect(
    await store.failPendingContextForParticipant({
      fencingToken: token,
      workspaceKey: target.workspaceKey,
      participantSessionId: target.targetSessionId,
      limit: 2,
    }),
  ).toMatchObject([
    { id: target.id, state: "failed" },
    { id: source.id, state: "failed" },
  ]);
  expect(
    await store.cancelContextAdmission({
      fencingToken: token,
      workspaceKey: cancelled.workspaceKey,
      id: cancelled.id,
    }),
  ).toMatchObject({ ok: true, admission: { kind: "message", state: "cancelled" } });
  expect(
    await store.cancelContextAdmission({
      fencingToken: token,
      workspaceKey: cancelled.workspaceKey,
      id: cancelled.id,
    }),
  ).toEqual({ ok: false, code: "state_conflict" });
  store.close();
});
