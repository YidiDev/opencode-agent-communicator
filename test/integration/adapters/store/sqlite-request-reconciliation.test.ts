import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import type { FencingToken } from "../../../../src/domain/ownership";
import { OwnershipLostFault } from "../../../../src/domain/ownership";
import {
  cleanupRequestStoreRoots,
  openRequestStore,
  requestFixture,
  requestFixtureForPayload,
  requestTemporaryRoot,
  requestTestWorkspace,
  requestWorkspace,
} from "../../../support/request-store";

afterEach(cleanupRequestStoreRoots);

test("creation operation uniqueness is workspace scoped", async () => {
  const stateDirectory = join(requestTemporaryRoot(), "state");
  const firstStore = openRequestStore({ stateDirectory });
  const firstToken = await firstStore.acquire();
  const first = await requestFixture(firstToken, 25_000);
  expect(await firstStore.createPrepared(first)).toMatchObject({ ok: true });
  firstStore.close();

  const secondWorkspace = requestWorkspace("request-test-two");
  const secondStore = openRequestStore({ stateDirectory, workspaceKey: secondWorkspace });
  const secondToken = await secondStore.acquire();
  const second = await requestFixtureForPayload(
    secondToken,
    { kind: "wait", milestone: "second", timeoutSeconds: 30 },
    {
      createdAtMs: 25_000,
      identitySeed: 77,
      sourceName: "ses_secondA",
      targetName: "ses_secondB",
      workspaceKey: secondWorkspace,
    },
  );
  expect(
    await secondStore.createPrepared({
      ...second,
      creationOperationId: first.creationOperationId,
    }),
  ).toMatchObject({ ok: true, request: { workspaceKey: secondWorkspace } });
  secondStore.close();
});

test("reconcilePreparedClaim validates its fence and identity before projecting a claim", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const prepared = await requestFixture(token, 25_000);
  await store.createPrepared(prepared);
  expect(
    await store.reconcilePreparedClaim({
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
    }),
  ).toMatchObject({ outcome: "still_prepared", request: { id: prepared.request.id } });
  for (const input of [
    {
      fencingToken: token,
      workspaceKey: requestWorkspace("other-workspace"),
      requestId: prepared.request.id,
    },
    {
      fencingToken: 0 as FencingToken,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
    },
    {
      fencingToken: token,
      workspaceKey: prepared.request.workspaceKey,
      requestId: "malformed" as never,
    },
  ]) {
    expect(await store.reconcilePreparedClaim(input)).toEqual({
      outcome: "absent_or_other_claim",
    });
  }
  await expect(
    store.reconcilePreparedClaim({
      fencingToken: (token + 1) as FencingToken,
      workspaceKey: prepared.request.workspaceKey,
      requestId: prepared.request.id,
    }),
  ).rejects.toBeInstanceOf(OwnershipLostFault);
  await store.claimPrepared({
    fencingToken: token,
    workspaceKey: prepared.request.workspaceKey,
    requestId: prepared.request.id,
  });
  const current = await store.reconcilePreparedClaim({
    fencingToken: token,
    workspaceKey: prepared.request.workspaceKey,
    requestId: prepared.request.id,
  });
  expect(current).toMatchObject({
    outcome: "current_claim",
    request: { id: prepared.request.id, deliveryState: "submitting" },
    envelopeJson: prepared.envelopeJson,
  });
  if (current.outcome === "current_claim") {
    expect(current.request).not.toHaveProperty("claimedFencingToken");
  }
  store.close();
});

test("reconcilePreparedCreation binds exact operation and request identities", async () => {
  const store = openRequestStore();
  const token = await store.acquire();
  const first = await requestFixture(token, 25_000);
  const other = await requestFixture(token, 25_001, "ses_otherA", "ses_otherB");
  await store.createPrepared(first);
  expect(await store.reconcilePreparedCreation(first)).toMatchObject({
    outcome: "matching",
    request: { id: first.request.id },
  });
  expect(
    await store.reconcilePreparedCreation({
      ...other,
      creationOperationId: first.creationOperationId,
    }),
  ).toEqual({ outcome: "conflict" });
  expect(
    await store.reconcilePreparedCreation({
      ...first,
      creationOperationId: other.creationOperationId,
    }),
  ).toEqual({ outcome: "conflict" });
  expect(
    await store.reconcilePreparedCreation({
      ...first,
      creationOperationId: "bad" as never,
    }),
  ).toEqual({ outcome: "conflict" });
  expect(
    await store.reconcilePreparedCreation({
      ...first,
      request: { ...first.request, workspaceKey: requestWorkspace("other-workspace") },
    }),
  ).toEqual({ outcome: "conflict" });

  await store.claimPrepared({
    fencingToken: token,
    workspaceKey: first.request.workspaceKey,
    requestId: first.request.id,
  });
  await store.completeDelivery({
    fencingToken: token,
    workspaceKey: first.request.workspaceKey,
    requestId: first.request.id,
    outcome: "delivery_failed",
  });
  expect(await store.reconcilePreparedCreation(first)).toMatchObject({
    outcome: "matching",
    request: { resolutionState: "delivery_failed" },
  });

  const inspection = new Database(store.databasePath, { strict: true });
  inspection.run("UPDATE requests SET creation_operation_id = NULL WHERE id = ?", [
    first.request.id,
  ]);
  inspection.close(true);
  expect(await store.reconcilePreparedCreation(first)).toEqual({ outcome: "conflict" });
  expect(first.request.workspaceKey).toBe(requestTestWorkspace());
  store.close();
});
