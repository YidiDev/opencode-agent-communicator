import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { PrepareRequestInput } from "../../../../src/application/request-ports";
import { validateDeliveryId } from "../../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../../src/domain/message-payload";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestClock,
  requestFixture,
  requestSession,
  requestTemporaryRoot,
  requestTestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

function digest(value: string): Sha256Digest {
  return createHash("sha256").update(value).digest("hex") as Sha256Digest;
}

function deliveryId(seed: string) {
  const result = validateDeliveryId(`dlv_${seed.repeat(32).slice(0, 32)}`);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function contextRequest(fixture: PrepareRequestInput): PrepareRequestInput {
  const envelopeBytes = new TextEncoder().encode(fixture.envelopeJson);
  return {
    ...fixture,
    deliveryMode: "context",
    request: { ...fixture.request, deliveryMode: "context" },
    contextAdmission: {
      requestId: fixture.request.id,
      envelopeJson: fixture.envelopeJson,
      contentByteLength: envelopeBytes.length,
      contentSha256: digest(fixture.envelopeJson),
    },
  };
}

test("claims message context atomically and erases its retained payload", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const envelopeJson = JSON.stringify({ content: "peer data" });
  const id = deliveryId("a");
  const created = await store.createContextMessage({
    fencingToken: token,
    id,
    workspaceKey: requestTestWorkspace(),
    sourceSessionId: requestSession("ses_source"),
    targetSessionId: requestSession("ses_target"),
    envelopeJson,
    contentByteLength: new TextEncoder().encode(envelopeJson).length,
    contentSha256: digest(envelopeJson),
    createdAtMs: 25_000,
  });
  expect(created).toMatchObject({ ok: true, admission: { state: "awaiting_context" } });

  const pending = await store.listPendingContext({
    fencingToken: token,
    workspaceKey: requestTestWorkspace(),
    targetSessionId: requestSession("ses_target"),
    limit: 10,
    maximumBytes: 65_536,
  });
  expect(pending).toHaveLength(1);
  expect(
    await store.claimPendingContext({
      fencingToken: token,
      workspaceKey: requestTestWorkspace(),
      targetSessionId: requestSession("ses_target"),
      items: [{ id, kind: "message", contentSha256: digest(envelopeJson) }],
    }),
  ).toMatchObject([{ state: "context_admitted" }]);

  const database = new Database(store.databasePath, { readonly: true, strict: true });
  expect(
    database
      .query<{ payload: string | null }, [string]>(
        "SELECT payload_json AS payload FROM context_admissions WHERE id = ?",
      )
      .get(id)?.payload,
  ).toBeNull();
  database.close(true);
  store.close();
});

test("participant context lookup preserves pending and terminal metadata across restarts", async () => {
  const stateDirectory = `${requestTemporaryRoot()}/state`;
  const sourceSessionId = requestSession("ses_source");
  const targetSessionId = requestSession("ses_target");
  const strangerSessionId = requestSession("ses_stranger");
  const envelopeJson = JSON.stringify({ content: "peer data" });
  const id = deliveryId("b");
  let store = openRequestStore({ stateDirectory });
  let token = await store.acquire();
  await store.createContextMessage({
    fencingToken: token,
    id,
    workspaceKey: requestTestWorkspace(),
    sourceSessionId,
    targetSessionId,
    envelopeJson,
    contentByteLength: new TextEncoder().encode(envelopeJson).length,
    contentSha256: digest(envelopeJson),
    createdAtMs: 25_000,
  });
  expect(
    await store.getContextAdmissionForParticipant({
      workspaceKey: requestTestWorkspace(),
      deliveryId: id,
      participantSessionId: sourceSessionId,
    }),
  ).toMatchObject({ role: "source", admission: { state: "awaiting_context" } });
  expect(
    await store.getContextAdmissionForParticipant({
      workspaceKey: requestTestWorkspace(),
      deliveryId: id,
      participantSessionId: strangerSessionId,
    }),
  ).toBeUndefined();
  store.close();

  store = openRequestStore({ stateDirectory });
  token = await store.acquire();
  expect(
    await store.getContextAdmissionForParticipant({
      workspaceKey: requestTestWorkspace(),
      deliveryId: id,
      participantSessionId: targetSessionId,
    }),
  ).toMatchObject({ role: "target", admission: { state: "awaiting_context" } });
  await store.claimPendingContext({
    fencingToken: token,
    workspaceKey: requestTestWorkspace(),
    targetSessionId,
    items: [{ id, kind: "message", contentSha256: digest(envelopeJson) }],
  });
  store.close();

  store = openRequestStore({ stateDirectory });
  await store.acquire();
  expect(
    await store.getContextAdmissionForParticipant({
      workspaceKey: requestTestWorkspace(),
      deliveryId: id,
      participantSessionId: sourceSessionId,
    }),
  ).toMatchObject({ role: "source", admission: { state: "context_admitted" } });
  store.close();
});

test("hides a context request from its target until the transform claim commits", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const fixture = contextRequest(await requestFixture(token));
  expect(await store.createPrepared(fixture)).toMatchObject({
    ok: true,
    request: { deliveryMode: "context", deliveryState: "awaiting_context" },
  });
  expect(
    await store.listForParticipant({
      fencingToken: token,
      workspaceKey: fixture.request.workspaceKey,
      callerSessionId: fixture.request.targetSessionId,
      role: "inbox",
      limit: 10,
    }),
  ).toMatchObject({ items: [] });

  await store.claimPendingContext({
    fencingToken: token,
    workspaceKey: fixture.request.workspaceKey,
    targetSessionId: fixture.request.targetSessionId,
    items: [
      {
        id: fixture.request.id,
        kind: "request",
        contentSha256: fixture.contextAdmission?.contentSha256 as Sha256Digest,
      },
    ],
  });
  expect(
    await store.listForParticipant({
      fencingToken: token,
      workspaceKey: fixture.request.workspaceKey,
      callerSessionId: fixture.request.targetSessionId,
      role: "inbox",
      limit: 10,
    }),
  ).toMatchObject({ items: [{ deliveryMode: "context", deliveryState: "context_admitted" }] });
  store.close();
});

test("cancels an unobserved context request and erases both retained payload copies", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const fixture = contextRequest(await requestFixture(token));
  await store.createPrepared(fixture);

  expect(
    await store.cancelContextAdmission({
      fencingToken: token,
      workspaceKey: fixture.request.workspaceKey,
      id: fixture.request.id,
    }),
  ).toMatchObject({ ok: true, admission: { state: "cancelled" } });
  expect(
    await store.getRequestMetadata({
      fencingToken: token,
      workspaceKey: fixture.request.workspaceKey,
      requestId: fixture.request.id,
    }),
  ).toMatchObject({ resolutionState: "cancelled", deliveryState: "delivery_failed" });

  const database = new Database(store.databasePath, { readonly: true, strict: true });
  expect(
    database
      .query<{ count: number }, [string, string]>(
        `SELECT count(*) AS count FROM request_payloads WHERE request_id = ?
         UNION ALL SELECT count(*) FROM context_admissions WHERE id = ? AND payload_json IS NOT NULL`,
      )
      .all(fixture.request.id, fixture.request.id)
      .every((row) => row.count === 0),
  ).toBe(true);
  database.close(true);
  store.close();
});

test("startup recovery fails ambiguous pre-crash context without replay", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const fixture = contextRequest(await requestFixture(token));
  await store.createPrepared(fixture);

  expect(
    await store.failUncertainContextOnStartup({
      fencingToken: token,
      workspaceKey: fixture.request.workspaceKey,
      limit: 100,
    }),
  ).toMatchObject([{ id: fixture.request.id, state: "failed" }]);
  expect(
    await store.getRequestMetadata({
      fencingToken: token,
      workspaceKey: fixture.request.workspaceKey,
      requestId: fixture.request.id,
    }),
  ).toMatchObject({ resolutionState: "delivery_failed", deliveryState: "delivery_failed" });
  expect(
    await store.listPendingContext({
      fencingToken: token,
      workspaceKey: fixture.request.workspaceKey,
      targetSessionId: fixture.request.targetSessionId,
      limit: 10,
      maximumBytes: 65_536,
    }),
  ).toEqual([]);
  store.close();
});

test("retains terminal request context until its parent reaches request retention", async () => {
  const clock = requestClock();
  const store = openRequestStore({ nowWallMs: clock.wall, nowMonotonicMs: clock.monotonic });
  let token = await store.acquire();
  const fixture = contextRequest(await requestFixture(token));
  await store.createPrepared(fixture);
  await store.failUncertainContextOnStartup({
    fencingToken: token,
    workspaceKey: fixture.request.workspaceKey,
    limit: 100,
  });

  clock.set(25_000 + 86_400_001);
  token = await store.acquire();
  const envelopeJson = JSON.stringify({ content: "trigger message retention" });
  expect(
    await store.createContextMessage({
      fencingToken: token,
      id: deliveryId("c"),
      workspaceKey: fixture.request.workspaceKey,
      sourceSessionId: fixture.request.sourceSessionId,
      targetSessionId: fixture.request.targetSessionId,
      envelopeJson,
      contentByteLength: new TextEncoder().encode(envelopeJson).length,
      contentSha256: digest(envelopeJson),
      createdAtMs: clock.wall(),
    }),
  ).toMatchObject({ ok: true });
  expect(
    await store.getRequestMetadata({
      fencingToken: token,
      workspaceKey: fixture.request.workspaceKey,
      requestId: fixture.request.id,
    }),
  ).toMatchObject({ resolutionState: "delivery_failed", deliveryState: "delivery_failed" });

  const database = new Database(store.databasePath, { readonly: true, strict: true });
  expect(
    database
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM context_admissions WHERE id = ? AND kind = 'request'",
      )
      .get(fixture.request.id)?.count,
  ).toBe(1);
  database.close(true);
  store.close();
});
