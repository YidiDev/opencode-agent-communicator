import { describe, expect, test } from "bun:test";
import { OwnershipUnavailableError } from "../../../src/adapters/store/store-types";
import {
  assertGenerationStartupActive,
  assertGenerationStartupBoundary,
  CommunicatorGenerationConstructionError,
  CommunicatorGenerationRecoveryError,
  classifyGenerationRecoveryFailure,
  constructionErrorForLifecycle,
  constructionErrorForStartupCode,
  readGenerationRecoveryClock,
  recoveryErrorForLifecycle,
  sanitizeGenerationConstructionError,
} from "../../../src/composition/communicator-generation-errors";

describe("generation construction errors", () => {
  test("classifies startup results without retaining their messages", () => {
    expect(constructionErrorForStartupCode("ownership_lost").classification).toBe("ownership_lost");
    expect(constructionErrorForStartupCode("ownership_lost", true).classification).toBe(
      "ownership_unavailable",
    );
    expect(constructionErrorForStartupCode("storage_unavailable").classification).toBe(
      "storage_failure",
    );
    expect(constructionErrorForStartupCode("invalid_arguments").classification).toBe(
      "recovery_failed",
    );
  });

  test("preserves typed safe failures and sanitizes adapter causes", () => {
    const existing = new CommunicatorGenerationConstructionError("storage_failure");
    expect(sanitizeGenerationConstructionError(existing)).toBe(existing);
    expect(
      sanitizeGenerationConstructionError(new OwnershipUnavailableError("unsafe owner detail"))
        .classification,
    ).toBe("ownership_unavailable");
    const generic = sanitizeGenerationConstructionError(new Error("/private/workspace.sqlite3"));
    expect(generic.classification).toBe("recovery_failed");
    expect(generic.diagnostic).not.toContain("workspace");
  });

  test("checks cancellation before reading the startup clock", () => {
    let reads = 0;
    const caller = new AbortController();
    assertGenerationStartupActive(caller.signal);
    caller.abort();
    expect(() => assertGenerationStartupActive(caller.signal)).toThrow("startup was cancelled");
    expect(() =>
      assertGenerationStartupBoundary(caller.signal, 2_000, () => {
        reads += 1;
        return 1_000;
      }),
    ).toThrow("startup was cancelled");
    expect(reads).toBe(0);
  });

  test("validates startup clocks and treats deadline equality as expired", () => {
    const active = new AbortController().signal;
    expect(() => assertGenerationStartupBoundary(active, 2_000, () => 1_999)).not.toThrow();
    for (const [deadline, now] of [
      [-1, 0],
      [2_000, -1],
      [2_000, Number.NaN],
      [Number.MAX_SAFE_INTEGER + 1, 1_000],
    ] as const) {
      expect(() => assertGenerationStartupBoundary(active, deadline, () => now)).toThrow(
        "port contract failed",
      );
    }
    expect(() => assertGenerationStartupBoundary(active, 2_000, () => 2_000)).toThrow(
      "ownership could not be established safely",
    );
    expect(() =>
      assertGenerationStartupBoundary(active, 2_000, () => {
        throw new Error("clock detail");
      }),
    ).toThrow("port contract failed");
  });

  test("maps every lifecycle stop classification and preserves its safe diagnostic", () => {
    expect(
      constructionErrorForLifecycle({ status: "ready", stopState: undefined }),
    ).toBeUndefined();
    expect(
      constructionErrorForLifecycle({ status: "starting", stopState: undefined }),
    ).toMatchObject({
      classification: "contract_fault",
      diagnostic: "Communicator lifecycle is not ready.",
    });
    for (const [cause, classification] of [
      ["ownership_lost", "ownership_lost"],
      ["storage_failure", "storage_failure"],
      ["contract_fault", "contract_fault"],
      ["workflow_fault", "workflow_fault"],
      ["host_disposal", "contract_fault"],
    ] as const) {
      const error = constructionErrorForLifecycle({
        status: "stopped",
        stopState: { cause, diagnostic: `Safe ${cause} diagnostic.` },
      });
      expect(error).toMatchObject({
        classification,
        diagnostic: `Safe ${cause} diagnostic.`,
      });
      expect(
        recoveryErrorForLifecycle({
          status: "stopped",
          stopState: { cause, diagnostic: `Safe ${cause} diagnostic.` },
        }),
      ).toMatchObject({ classification, message: `Safe ${cause} diagnostic.` });
    }
    expect(recoveryErrorForLifecycle({ status: "ready", stopState: undefined })).toBeUndefined();
  });

  test("classifies recovery causes without retaining generic details", () => {
    const recovery = new CommunicatorGenerationRecoveryError("drain_timeout", "Safe timeout.");
    expect(classifyGenerationRecoveryFailure(recovery)).toBe(recovery);
    expect(
      classifyGenerationRecoveryFailure(
        new CommunicatorGenerationConstructionError("workflow_fault", "Safe workflow."),
      ),
    ).toMatchObject({ classification: "workflow_fault", message: "Safe workflow." });
    expect(classifyGenerationRecoveryFailure(new Error("/private/detail"))).toMatchObject({
      classification: "recovery_failed",
      message: "Communicator generation recovery failed.",
    });
  });

  test("reads recovery clocks through one typed safe boundary", () => {
    expect(readGenerationRecoveryClock(() => 0)).toBe(0);
    for (const clock of [
      () => Number.NaN,
      () => -1,
      () => Number.MAX_SAFE_INTEGER + 1,
      () => {
        throw new Error("clock detail");
      },
    ]) {
      expect(() => readGenerationRecoveryClock(clock)).toThrow("timing is invalid");
    }
  });
});
