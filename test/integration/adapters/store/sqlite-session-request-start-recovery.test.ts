import { expect, test } from "bun:test";

import { recoverSessionStarts } from "../../../../src/application/recover-session-starts";
import { validateRequestId } from "../../../../src/domain/generated-ids";
import type { Sha256Digest } from "../../../../src/domain/message-payload";
import {
  canonicalizeSerializeAndDigestPendingRequestPayload,
  serializeVerifiedRequestEnvelope,
} from "../../../../src/domain/request-serialization";
import { digestStartArguments } from "../../../../src/domain/session-start";
import { requestDigestPort } from "../../../support/request-store";
import { ids, limits, openStore, source, workspace } from "./sqlite-session-start-support";

test("real store resumes claim-before-create initial work exactly once", async () => {
  const store = openStore();
  try {
    const fencingToken = await store.acquire();
    const generated = ids(950);
    const requestId = validateRequestId(`req_${generated.operationId.slice(3)}`);
    if (!requestId.ok) throw new Error("invalid fixture request id");
    const payload = await canonicalizeSerializeAndDigestPendingRequestPayload(requestDigestPort, {
      kind: "wait",
      milestone: "recovered",
      timeoutSeconds: 30,
    });
    if (!payload.ok) throw new Error(payload.message);
    const request = {
      id: requestId.value,
      workspaceKey: workspace,
      sourceSessionId: source,
      targetSessionId: generated.sessionId,
      nativeMessageId: generated.nativeMessageId,
      deliveryMode: "initial" as const,
      linkedStartOperationId: generated.operationId,
      kind: "wait" as const,
      resolutionState: "pending" as const,
      deliveryState: "prepared" as const,
      resultState: "none" as const,
      payloadByteLength: payload.byteLength,
      payloadSha256: payload.sha256,
      createdAtMs: 10_000,
      updatedAtMs: 10_000,
      deadlineAtMs: 40_000,
    };
    const envelope = await serializeVerifiedRequestEnvelope(
      { ...request, requestId: request.id, payload: payload.value },
      requestDigestPort,
    );
    const startArguments = {
      idempotencyKey: "recovery:claim-before-create",
      initialMessage: envelope,
    };
    const argumentsSha256 = await digestStartArguments(requestDigestPort, startArguments);
    expect(
      await store.createOrResumeSessionRequestStart({
        start: {
          fencingToken,
          workspaceKey: workspace,
          sourceSessionId: source,
          ...generated,
          argumentsSha256,
          idempotencyArgumentsSha256: "a".repeat(64) as Sha256Digest,
          arguments: startArguments,
          limits,
          nowMs: 10_000,
        },
        request: {
          fencingToken,
          creationOperationId: generated.operationId,
          deliveryMode: "initial",
          linkedStartOperationId: generated.operationId,
          request,
          payloadJson: payload.serialized,
          envelopeJson: envelope,
        },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await store.claimPrepared({
        fencingToken,
        workspaceKey: workspace,
        requestId: request.id,
      }),
    ).toMatchObject({ ok: true, request: { deliveryState: "submitting" } });

    let creates = 0;
    let admissions = 0;
    await recoverSessionStarts(
      store.starts,
      { nowMs: () => 10_000 },
      {
        fencingToken,
        workspaceKey: workspace,
        requests: store,
        requestStarts: store,
        membership: {
          async readCurrentRoots() {
            return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
          },
        },
        ownership: store,
        digest: requestDigestPort,
        nativeStart: {
          async createRootSession() {
            creates += 1;
            return "created";
          },
          async reconcileRootSession() {
            return "matching";
          },
          async updateSessionTitle() {
            return "updated";
          },
          async admitInitialMessage() {
            admissions += 1;
            return "admitted";
          },
        },
      },
    );
    expect(creates).toBe(1);
    expect(admissions).toBe(1);
    expect(
      await store.getRequestMetadata({
        fencingToken,
        workspaceKey: workspace,
        requestId: request.id,
      }),
    ).toMatchObject({ deliveryState: "admitted" });
  } finally {
    store.close();
  }
});
