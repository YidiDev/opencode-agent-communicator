import { describe, expect, test } from "bun:test";
import { CommunicatorStartupRecoveryLifecycle } from "../../../src/application/communicator-startup-lifecycle";
import { RequestDeadlineSchedulerFault } from "../../../src/application/request-deadline-scheduler";

function lifecycle() {
  return new CommunicatorStartupRecoveryLifecycle(
    1 as never,
    { stop: () => undefined, fault: undefined } as never,
    {} as never,
    { effectSignal: new AbortController().signal, stop: () => undefined } as never,
  );
}

describe("communicator lifecycle stop diagnostics", () => {
  test("notifies synchronously with a sanitized recoverable ownership classification", () => {
    const subject = lifecycle();
    const observed: unknown[] = [];
    subject.observeStop((state) => observed.push(state));
    subject.stop(
      "ownership_lost",
      "ownership_lost",
      new RequestDeadlineSchedulerFault("ownership_lost"),
    );
    expect(subject.stopState).toEqual({
      cause: "ownership_lost",
      reason: "ownership_lost",
      recoverable: true,
      diagnostic: "Communicator ownership ended.",
    });
    expect(observed).toEqual([subject.stopState]);
    expect(JSON.stringify(subject.stopState)).not.toContain("workspace");
  });

  test("preserves the first stop and classifies scheduler storage and contract faults", () => {
    const storage = lifecycle();
    storage.stop("shutdown", new RequestDeadlineSchedulerFault("storage_failure"));
    storage.stop("ownership_lost", "ownership_lost");
    expect(storage.stopState?.cause).toBe("storage_failure");
    expect(storage.stopState?.recoverable).toBe(false);

    const contract = lifecycle();
    contract.stop("shutdown", new RequestDeadlineSchedulerFault("port_contract_violation"));
    expect(contract.stopState?.cause).toBe("contract_fault");
  });
});
