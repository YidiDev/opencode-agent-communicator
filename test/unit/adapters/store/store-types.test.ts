import { describe, expect, test } from "bun:test";

import {
  OwnershipUnavailableError,
  resolveStoreLimits,
  StoreIntegrityError,
  StoreSecurityError,
  sqliteStoreDefaultLimits,
  sqliteStoreHardCeilings,
} from "../../../../src/adapters/store/store-types";
import { OwnershipLostFault } from "../../../../src/domain/ownership";

describe("SQLite store configuration types", () => {
  test("resolves conservative defaults and identifies safe adapter faults", () => {
    expect(resolveStoreLimits()).toEqual(sqliteStoreDefaultLimits);
    expect(new StoreSecurityError("safe").name).toBe("StoreSecurityError");
    expect(new StoreIntegrityError("safe").name).toBe("StoreIntegrityError");
    expect(new OwnershipUnavailableError("safe").name).toBe("OwnershipUnavailableError");
    expect(new OwnershipLostFault("safe").name).toBe("OwnershipLostFault");
  });

  test("rejects retained-envelope limits above immutable ceilings", () => {
    expect(() =>
      resolveStoreLimits({
        retainedEnvelopeBytesPerWorkspace:
          sqliteStoreHardCeilings.retainedEnvelopeBytesPerWorkspace + 1,
      }),
    ).toThrow(StoreSecurityError);
  });
});
