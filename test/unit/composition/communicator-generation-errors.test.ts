import { describe, expect, test } from "bun:test";
import { OwnershipUnavailableError } from "../../../src/adapters/store/store-types";
import {
  CommunicatorGenerationConstructionError,
  constructionErrorForStartupCode,
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
});
