import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LinuxBunSqliteStore } from "../../../../src/adapters/store/sqlite-store";
import type { PrepareDeliveryInput } from "../../../../src/application/delivery-ports";
import { validateDeliveryId, validateNativeMessageId } from "../../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../../src/domain/message-payload";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspace = valid(validateWorkspaceKey("workspace:delivery-evidence-clock"));
const source = valid(validateSessionId("ses_evidenceSource"));
const target = valid(validateSessionId("ses_evidenceTarget"));

test("rejects future delivery evidence against transactional store time without changing the row", async () => {
  let now = 10_000;
  const root = mkdtempSync(join(tmpdir(), "communicator-delivery-evidence-"));
  roots.push(root);
  const store = new LinuxBunSqliteStore({
    stateDirectory: join(root, "state"),
    workspaceKey: workspace,
    ownerId: "delivery-evidence-clock",
    leaseDurationMs: 1_000,
    takeoverGraceMs: 100,
    nowWallMs: () => now,
    nowMonotonicMs: () => now,
  });
  const token = await store.acquire();
  const deliveryId = valid(validateDeliveryId(`dlv_${"6".repeat(32)}`));
  const nativeMessageId = valid(validateNativeMessageId(`msg_${"6".repeat(32)}`));
  const prepared: PrepareDeliveryInput = {
    fencingToken: token,
    id: deliveryId,
    workspaceKey: workspace,
    sourceSessionId: source,
    targetSessionId: target,
    nativeMessageId,
    envelope: '{"payload":{"content":"trusted-clock"}}',
    contentByteLength: 13,
    contentSha256: "a".repeat(64) as Sha256Digest,
    nowMs: now,
  };
  await store.createPrepared(prepared);
  now += 1;
  await store.claimPrepared({
    fencingToken: token,
    workspaceKey: workspace,
    deliveryId,
    nowMs: now,
  });
  now += 1;

  expect(
    await store.completeSubmission({
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId,
      state: "admitted",
      admittedSeq: 1,
      evidenceObservedAtMs: now + 1,
      nowMs: now + 1,
    }),
  ).toEqual({ ok: false, code: "state_conflict" });
  const inspection = new Database(store.databasePath, { readonly: true, strict: true });
  expect(
    inspection
      .query<{ readonly state: string; readonly evidence: number | null }, [string]>(
        "SELECT state, evidence_observed_at_ms AS evidence FROM deliveries WHERE id = ?",
      )
      .get(deliveryId),
  ).toEqual({ state: "submitting", evidence: null });
  inspection.close(true);
  store.close();
});

for (const outcome of ["failed", "admission_unknown", "admitted", "promoted"] as const) {
  test(`rejects a regressed transactional store clock for ${outcome} without changing the row`, async () => {
    let now = 20_000;
    const root = mkdtempSync(join(tmpdir(), "communicator-delivery-completion-clock-"));
    roots.push(root);
    const store = new LinuxBunSqliteStore({
      stateDirectory: join(root, "state"),
      workspaceKey: workspace,
      ownerId: `delivery-completion-clock-${outcome}`,
      leaseDurationMs: 1_000,
      takeoverGraceMs: 100,
      nowWallMs: () => now,
      nowMonotonicMs: () => now,
    });
    const token = await store.acquire();
    const index = ["failed", "admission_unknown", "admitted", "promoted"].indexOf(outcome) + 1;
    const deliveryId = valid(validateDeliveryId(`dlv_${String(index).repeat(32)}`));
    const nativeMessageId = valid(validateNativeMessageId(`msg_${String(index).repeat(32)}`));
    await store.createPrepared({
      fencingToken: token,
      id: deliveryId,
      workspaceKey: workspace,
      sourceSessionId: source,
      targetSessionId: target,
      nativeMessageId,
      envelope: '{"payload":{"content":"regressed-clock"}}',
      contentByteLength: 15,
      contentSha256: "b".repeat(64) as Sha256Digest,
      nowMs: now,
    });
    now += 1;
    await store.claimPrepared({
      fencingToken: token,
      workspaceKey: workspace,
      deliveryId,
      nowMs: now,
    });

    if (outcome === "admitted" || outcome === "promoted") {
      now += 2;
      expect(
        await store.completeSubmission({
          fencingToken: token,
          workspaceKey: workspace,
          deliveryId,
          state: "admission_unknown",
          nowMs: now,
        }),
      ).toMatchObject({ ok: true, delivery: { state: "admission_unknown" } });
      now -= 1;
    } else {
      now -= 1;
    }

    const inspection = new Database(store.databasePath, { readonly: true, strict: true });
    const selectState = () =>
      inspection
        .query<
          {
            readonly state: string;
            readonly updatedAtMs: number;
            readonly admittedAtMs: number | null;
            readonly promotedAtMs: number | null;
            readonly failedAtMs: number | null;
            readonly evidenceObservedAtMs: number | null;
          },
          [string]
        >(
          `SELECT state, updated_at_ms AS updatedAtMs, admitted_at_ms AS admittedAtMs,
             promoted_at_ms AS promotedAtMs, failed_at_ms AS failedAtMs,
             evidence_observed_at_ms AS evidenceObservedAtMs
           FROM deliveries WHERE id = ?`,
        )
        .get(deliveryId);
    const before = selectState();
    const completion =
      outcome === "failed" || outcome === "admission_unknown"
        ? await store.completeSubmission({
            fencingToken: token,
            workspaceKey: workspace,
            deliveryId,
            state: outcome,
            nowMs: 999_999,
          })
        : outcome === "admitted"
          ? await store.completeSubmission({
              fencingToken: token,
              workspaceKey: workspace,
              deliveryId,
              state: outcome,
              admittedSeq: 10,
              evidenceObservedAtMs: now,
              nowMs: 999_999,
            })
          : await store.completeSubmission({
              fencingToken: token,
              workspaceKey: workspace,
              deliveryId,
              state: outcome,
              admittedSeq: 10,
              promotedSeq: 11,
              evidenceObservedAtMs: now,
              nowMs: 999_999,
            });

    expect(completion).toEqual({ ok: false, code: "state_conflict" });
    expect(selectState()).toEqual(before);
    inspection.close(true);
    store.close();
  });
}
