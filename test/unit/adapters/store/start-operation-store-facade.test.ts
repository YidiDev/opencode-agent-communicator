import { expect, test } from "bun:test";
import { createStartOperationStoreFacade } from "../../../../src/adapters/store/start-operation-store-facade";
import type { StartOperationPersistencePort } from "../../../../src/application/session-start-ports";

test("routes start lifecycle mutations through capacity-checked access and freezes the facade", async () => {
  const calls: string[] = [];
  const expected = { ok: false as const, code: "state_conflict" as const };
  const repository = {
    async releasePreparedReservation() {
      calls.push("repository");
      return expected;
    },
    async rejectPreparedStart() {
      calls.push("repository:reject");
      return expected;
    },
    async collectRetention() {
      calls.push("repository:retention");
      return { ok: true as const, deletedOperations: 0, deletedRateEvents: 0 };
    },
  } as unknown as StartOperationPersistencePort;
  const facade = createStartOperationStoreFacade(repository, (operation) => {
    calls.push("access:before");
    const result = operation();
    calls.push("access:after");
    return result;
  });
  expect(Object.isFrozen(facade)).toBe(true);
  expect(await facade.releasePreparedReservation({} as never)).toBe(expected);
  expect(await facade.rejectPreparedStart({} as never)).toBe(expected);
  expect((await facade.collectRetention({} as never)).ok).toBe(true);
  expect(calls).toEqual([
    "access:before",
    "repository",
    "access:after",
    "access:before",
    "repository:reject",
    "access:after",
    "access:before",
    "repository:retention",
    "access:after",
  ]);
});
