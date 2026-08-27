import { expect, test } from "bun:test";

import { RequestDeletionRepository } from "../../../../src/adapters/store/request-deletion-repository";
import { OwnershipLostFault } from "../../../../src/domain/ownership";
import {
  availableResultsPerWorkspaceHardCeiling,
  participantDeletionCandidatesHardCeiling,
  pendingRequestsPerWorkspaceHardCeiling,
} from "../../../../src/domain/safety-ceilings";
import { validateSessionId } from "../../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../../src/domain/workspaces";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

test("participant deletion fails closed when deletion metadata exceeds either hard bound", () => {
  const workspaceKey = valid(validateWorkspaceKey("deletion-bound"));
  const deletedSessionId = valid(validateSessionId("ses_deleted"));
  for (const exceeded of ["available", "pending"] as const) {
    const database = {
      transaction: (operation: () => unknown) => ({ immediate: operation }),
      run: () => ({ changes: 0 }),
      query: (sql: string) => {
        if (sql.includes("FROM managed_sessions")) return { get: () => undefined };
        if (sql.includes("result_state = 'available'")) {
          return {
            all: () =>
              exceeded === "available"
                ? new Array(availableResultsPerWorkspaceHardCeiling + 1).fill({})
                : [],
          };
        }
        return {
          all: () =>
            exceeded === "pending"
              ? new Array(pendingRequestsPerWorkspaceHardCeiling + 1).fill({})
              : [],
        };
      },
    };
    const repository = new RequestDeletionRepository(
      {
        database,
        workspaceKey,
        maximumPageCount: 1,
        nowWallMs: () => 1,
      } as never,
      { assertOrdinaryWorkAllowed: () => undefined } as never,
    );

    expect(
      repository.deleteParticipantRequests({
        fencingToken: 1 as never,
        workspaceKey,
        deletedSessionId,
      }),
    ).toEqual({ ok: false, code: "storage_unavailable" });
  }
});

test("candidate reconciliation query validates its fence, bound, IDs, and priorities", () => {
  const workspaceKey = valid(validateWorkspaceKey("deletion-candidates"));
  const sessionId = valid(validateSessionId("ses_candidate"));
  const run = (rows: unknown[], ownership: () => void = () => undefined) => {
    const repository = new RequestDeletionRepository(
      {
        database: {
          transaction: (operation: () => unknown) => ({ immediate: operation }),
          query: () => ({ all: () => rows }),
        },
        workspaceKey,
        maximumPageCount: 1,
      } as never,
      { assertOrdinaryWorkAllowed: ownership } as never,
    );
    return repository.listParticipantDeletionCandidates({
      fencingToken: 1 as never,
      workspaceKey,
    });
  };
  expect(run([{ sessionId, priority: 0 }])).toEqual({ ok: true, sessionIds: [sessionId] });
  for (const rows of [
    new Array(participantDeletionCandidatesHardCeiling + 1).fill({ sessionId, priority: 0 }),
    [{ sessionId: "invalid", priority: 0 }],
    [{ sessionId, priority: -1 }],
    [{ sessionId, priority: 4 }],
    [{ sessionId, priority: "0" }],
  ]) {
    expect(run(rows)).toEqual({ ok: false, code: "storage_unavailable" });
  }
  expect(
    run([], () => {
      throw new OwnershipLostFault("lost");
    }),
  ).toEqual({ ok: false, code: "ownership_lost" });
  expect(
    new RequestDeletionRepository(
      { workspaceKey, maximumPageCount: 1 } as never,
      {} as never,
    ).listParticipantDeletionCandidates({
      fencingToken: 1 as never,
      workspaceKey: valid(validateWorkspaceKey("other-workspace")),
    }),
  ).toEqual({ ok: false, code: "storage_unavailable" });
});
