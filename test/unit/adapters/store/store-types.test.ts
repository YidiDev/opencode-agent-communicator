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

  test("validates deferred retained-result ceilings and traversal budget as configuration only", () => {
    const configured = resolveStoreLimits({
      retainedResultBytesPerSource: 1,
      retainedResultBytesPerTarget: 2,
      retainedResultBytesPerWorkspace: 3,
      requestTraversalNodes: 4,
    });
    expect(configured).toMatchObject({
      retainedResultBytesPerSource: 1,
      retainedResultBytesPerTarget: 2,
      retainedResultBytesPerWorkspace: 3,
      requestTraversalNodes: 4,
    });
    expect(() =>
      resolveStoreLimits({
        retainedResultBytesPerWorkspace:
          sqliteStoreHardCeilings.retainedResultBytesPerWorkspace + 1,
      }),
    ).toThrow(StoreSecurityError);
    expect(() => resolveStoreLimits({ requestTraversalNodes: 0 })).toThrow(StoreSecurityError);
  });

  test("publishes conservative request defaults and immutable ceilings", () => {
    expect(sqliteStoreDefaultLimits).toMatchObject({
      pendingRequestsPerSource: 16,
      pendingRequestsPerTarget: 32,
      pendingRequestsPerWorkspace: 128,
      pendingRequestBytesPerSource: 256 * 1024,
      pendingRequestBytesPerTarget: 512 * 1024,
      pendingRequestBytesPerWorkspace: 4 * 1024 * 1024,
      requestsPerSourceWindow: 10,
      requestsPerTargetWindow: 30,
      requestsPerWorkspaceWindow: 100,
      retainedResultBytesPerSource: 256 * 1024,
      retainedResultBytesPerTarget: 512 * 1024,
      retainedResultBytesPerWorkspace: 4 * 1024 * 1024,
      requestTraversalNodes: 512,
    });
    expect(sqliteStoreHardCeilings).toMatchObject({
      pendingRequestsPerSource: 128,
      pendingRequestsPerTarget: 256,
      pendingRequestsPerWorkspace: 1_024,
      pendingRequestBytesPerSource: 4 * 1024 * 1024,
      pendingRequestBytesPerTarget: 8 * 1024 * 1024,
      pendingRequestBytesPerWorkspace: 32 * 1024 * 1024,
      requestsPerSourceWindow: 100,
      requestsPerTargetWindow: 300,
      requestsPerWorkspaceWindow: 1_000,
      retainedResultBytesPerSource: 4 * 1024 * 1024,
      retainedResultBytesPerTarget: 8 * 1024 * 1024,
      retainedResultBytesPerWorkspace: 32 * 1024 * 1024,
      requestTraversalNodes: 2_048,
    });
  });
});
