import { describe, expect, test } from "bun:test";

import { exportSession } from "../../../src/application/export-session";
import { sessionExportPolicyPort } from "../../../src/application/session-export-policy";
import type { SessionExportPorts } from "../../../src/application/session-export-ports";
import {
  exportAdapterFailure,
  isExportAdapterResult,
} from "../../../src/application/session-export-result";
import { OwnershipLostFault, validateFencingToken } from "../../../src/domain/ownership";
import { createSessionExportPolicy } from "../../../src/domain/session-export";
import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";

function valid<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const workspaceKey = valid(validateWorkspaceKey("workspace:export"));
const sourceSessionId = valid(validateSessionId("ses_source"));
const fencingToken = valid(validateFencingToken(7));

function fixture(policy = createSessionExportPolicy()) {
  const calls: string[] = [];
  const approvals: string[] = [];
  let sourceVisible = true;
  let targetVisible = true;
  let isCurrent = true;
  let adapterCode: "export_unavailable" | undefined;
  let membershipOverride:
    | (() => { sourceVisible: boolean; targetVisible: boolean; sourceTitle: undefined })
    | undefined;
  let ownershipOverride: (() => boolean) | undefined;
  let approvalOverride: ((kind: "mode" | "overwrite") => "approved" | "rejected") | undefined;
  const ports: SessionExportPorts = {
    readiness: {
      fencingToken,
      assertReady: () => calls.push("ready"),
      ownershipLost: () => calls.push("lifecycle:ownership_lost"),
    },
    membership: {
      async readCurrentRoots() {
        calls.push("visible");
        if (membershipOverride) return membershipOverride();
        return { sourceVisible, targetVisible, sourceTitle: undefined };
      },
    },
    policy: sessionExportPolicyPort(policy),
    approval: {
      async requestExportApproval(kind) {
        calls.push(`approval:${kind}`);
        approvals.push(kind);
        return approvalOverride?.(kind) ?? "approved";
      },
    },
    ownership: {
      async acquire() {
        calls.push("acquire");
        return fencingToken;
      },
      async isCurrent() {
        calls.push("ownership");
        return ownershipOverride?.() ?? isCurrent;
      },
    },
    exporter: {
      async writeExport(input) {
        calls.push("export");
        if (adapterCode) return { ok: false, code: adapterCode };
        if ((await input.guard.check()) !== "current") {
          return { ok: false, code: "native_outcome_unknown" };
        }
        return {
          ok: true,
          byteCount: 123,
          contentSha256: "a".repeat(64) as never,
        };
      },
    },
  };
  return {
    ports,
    calls,
    approvals,
    hideCaller: () => {
      sourceVisible = false;
    },
    hideTarget: () => {
      targetVisible = false;
    },
    loseOwnership: () => {
      isCurrent = false;
    },
    failAdapter: () => {
      adapterCode = "export_unavailable";
    },
    overrideMembership: (value: typeof membershipOverride) => {
      membershipOverride = value;
    },
    overrideOwnership: (value: typeof ownershipOverride) => {
      ownershipOverride = value;
    },
    overrideApproval: (value: typeof approvalOverride) => {
      approvalOverride = value;
    },
  };
}

async function execute(
  fake: ReturnType<typeof fixture>,
  args: Record<string, unknown>,
  deadlineMs = Date.now() + 10_000,
  abort = new AbortController().signal,
) {
  return exportSession(
    fake.ports,
    {
      workspaceKey,
      sourceSessionId,
      abort,
      deadlineMs,
    },
    { destination: "safe/export.json", ...args },
  );
}

describe("export session application workflow", () => {
  test("rejects an already-expired invocation before observing membership", async () => {
    const fake = fixture();
    expect(await execute(fake, {}, Date.now() - 1)).toMatchObject({
      ok: false,
      error: { code: "export_limit_exceeded" },
    });
    expect(fake.calls).toEqual(["ready"]);
  });

  test("defaults to a sanitized caller export without approval and returns only summary", async () => {
    const fake = fixture();
    const result = await execute(fake, {});
    expect(result).toEqual({
      ok: true,
      value: {
        sessionId: sourceSessionId,
        destination: "safe/export.json" as never,
        isSanitized: true,
        byteCount: 123,
        contentSha256: "a".repeat(64) as never,
      },
    });
    expect(fake.approvals).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("messages");
  });

  test("rejects unsanitized mode before export", async () => {
    const fake = fixture();
    expect(
      await execute(fake, {
        session_id: "ses_target",
        sanitize: false,
        overwrite: true,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(fake.approvals).toEqual([]);
  });

  test("does not let permissive mode policy bypass overwrite approval", async () => {
    const fake = fixture(createSessionExportPolicy({ crossSession: "allow", overwrite: "allow" }));
    expect(await execute(fake, { session_id: "ses_target", overwrite: true })).toMatchObject({
      ok: true,
    });
    expect(fake.approvals).toEqual([]);
  });

  test("fails before effects for invalid arguments, visibility, policy, and ownership", async () => {
    const invalid = fixture();
    expect(await execute(invalid, { destination: "../escape" })).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    expect(invalid.calls).toEqual(["ready"]);

    for (const args of [{ sanitize: "yes" }, { overwrite: 1 }]) {
      const malformedOption = fixture();
      expect(await execute(malformedOption, args)).toMatchObject({
        ok: false,
        error: { code: "invalid_arguments" },
      });
      expect(malformedOption.calls).toEqual(["ready"]);
    }

    const hidden = fixture();
    hidden.hideTarget();
    expect(await execute(hidden, { session_id: "ses_target" })).toMatchObject({
      ok: false,
      error: { code: "target_not_visible" },
    });
    expect(hidden.calls).not.toContain("export");

    const denied = fixture();
    expect(await execute(denied, { sanitize: false })).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    expect(denied.calls).not.toContain("export");

    const stale = fixture();
    stale.loseOwnership();
    expect(await execute(stale, {})).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });
    expect(stale.calls).not.toContain("export");
    expect(stale.calls).toContain("lifecycle:ownership_lost");
    expect(stale.calls).not.toContain("acquire");
  });

  test("maps adapter failures safely without transcript output", async () => {
    const fake = fixture();
    fake.failAdapter();
    const result = await execute(fake, {});
    expect(result).toMatchObject({ ok: false, error: { code: "export_unavailable" } });
    expect(JSON.stringify(result)).not.toContain("private transcript");
  });

  test("revalidates visibility after approval and ownership at the effect boundary", async () => {
    const visibilityRace = fixture();
    let observations = 0;
    visibilityRace.overrideMembership(() => {
      observations += 1;
      return {
        sourceVisible: true,
        targetVisible: observations === 1,
        sourceTitle: undefined,
      };
    });
    expect(await execute(visibilityRace, {})).toMatchObject({
      ok: false,
      error: { code: "target_not_visible" },
    });
    expect(visibilityRace.calls).not.toContain("export");

    const ownershipRace = fixture();
    let ownershipChecks = 0;
    ownershipRace.overrideOwnership(() => {
      ownershipChecks += 1;
      return ownershipChecks === 1;
    });
    expect(await execute(ownershipRace, {})).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });
    expect(ownershipRace.calls).toContain("export");
  });

  test("overwrite remains independently denied by static policy", async () => {
    const fake = fixture(createSessionExportPolicy({ overwrite: "deny" }));
    expect(await execute(fake, { overwrite: true })).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    expect(fake.calls).not.toContain("export");
  });

  test("bounds exporter calls by the absolute deadline", async () => {
    const exporter = fixture();
    exporter.ports.exporter.writeExport = () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ ok: true, byteCount: 1, contentSha256: "a".repeat(64) as never }),
          50,
        ),
      );
    expect(await execute(exporter, {}, Date.now() + 20)).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });
  });
});

describe("export session application failure boundaries", () => {
  test("strictly recognizes adapter results and maps every storage retry boundary", () => {
    expect(isExportAdapterResult(null)).toBe(false);
    expect(isExportAdapterResult({ ok: "yes" })).toBe(false);
    expect(isExportAdapterResult({ ok: false, code: "storage_unavailable" })).toBe(true);
    expect(exportAdapterFailure("storage_unavailable")).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable", retryable: true },
    });
  });

  test("fails closed for malformed policy, ownership, and exporter runtime values", async () => {
    const policy = fixture();
    (policy.ports as unknown as { policy: unknown }).policy = {
      decisionFor: () => ({ mode: "sometimes" }),
    };
    expect(await execute(policy, {})).toMatchObject({
      ok: false,
      error: { code: "export_unavailable" },
    });

    const ownership = fixture();
    ownership.ports.ownership.isCurrent = (async () => "yes") as never;
    expect(await execute(ownership, {})).toMatchObject({
      ok: false,
      error: { code: "export_unavailable" },
    });

    const exporter = fixture();
    exporter.ports.exporter.writeExport = (async () => ({ ok: true, byteCount: -1 })) as never;
    expect(await execute(exporter, {})).toMatchObject({
      ok: false,
      error: { code: "export_unavailable" },
    });
  });

  test("fails closed when membership is malformed, rejected, or exceeds the deadline", async () => {
    const malformed = fixture();
    malformed.ports.membership.readCurrentRoots = (async () => ({
      sourceVisible: true,
      targetVisible: true,
      sourceTitle: undefined,
      injected: true,
    })) as never;
    expect(await execute(malformed, {})).toMatchObject({
      ok: false,
      error: { code: "export_unavailable" },
    });

    const lost = fixture();
    lost.ports.membership.readCurrentRoots = async () => {
      throw new OwnershipLostFault();
    };
    expect(await execute(lost, {})).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });

    const expired = fixture();
    expired.ports.membership.readCurrentRoots = () => new Promise(() => {});
    expect(await execute(expired, {}, Date.now() + 20)).toMatchObject({
      ok: false,
      error: { code: "export_limit_exceeded" },
    });
  });

  test("never invokes obsolete approval transport", async () => {
    const fake = fixture(createSessionExportPolicy({ overwrite: "deny" }));
    fake.ports.approval.requestExportApproval = async () => {
      throw new Error("obsolete approval transport must not run");
    };
    expect(await execute(fake, { overwrite: true })).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    expect(fake.calls).not.toContain("export");
  });

  test("requires the recovered lifecycle epoch and never reacquires for ordinary export", async () => {
    const missing = fixture();
    const withoutEpoch = {
      ...missing,
      ports: { ...missing.ports, readiness: { assertReady() {} } },
    };
    expect(await execute(withoutEpoch, {})).toMatchObject({
      ok: false,
      error: { code: "ownership_lost" },
    });

    const current = fixture();
    expect(await execute(current, {})).toMatchObject({ ok: true });
    expect(current.calls).not.toContain("acquire");
  });

  test("distinguishes caller loss at initial visibility and at the guarded effect boundary", async () => {
    const initial = fixture();
    initial.hideCaller();
    expect(await execute(initial, {})).toMatchObject({
      ok: false,
      error: { code: "caller_not_visible" },
    });

    const guarded = fixture();
    let observations = 0;
    guarded.overrideMembership(() => {
      observations += 1;
      return {
        sourceVisible: observations < 3,
        targetVisible: true,
        sourceTitle: undefined,
      };
    });
    expect(await execute(guarded, {})).toMatchObject({
      ok: false,
      error: { code: "caller_not_visible" },
    });
    expect(guarded.calls).not.toContain("export");
  });

  test("treats guard transport failures and post-effect ownership loss as uncertain", async () => {
    const transport = fixture();
    let checks = 0;
    transport.ports.ownership.isCurrent = async () => {
      checks += 1;
      if (checks === 1) return true;
      throw new Error("coordinator offline");
    };
    expect(await execute(transport, {})).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });

    const lost = fixture();
    let currentChecks = 0;
    lost.ports.ownership.isCurrent = async () => {
      currentChecks += 1;
      if (currentChecks < 3) return true;
      throw new OwnershipLostFault();
    };
    expect(await execute(lost, {})).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });
  });

  test("maps synchronous adapter faults at the application boundary", async () => {
    const storage = fixture();
    storage.ports.exporter.writeExport = (() => {
      throw new Error("storage failed");
    }) as never;
    expect(await execute(storage, {})).toMatchObject({
      ok: false,
      error: { code: "native_outcome_unknown" },
    });
  });
});

describe("export session projection and policy coverage", () => {
  test("fails closed for every malformed membership projection shape", async () => {
    const malformedValues: unknown[] = [
      null,
      { sourceVisible: "yes", targetVisible: true, sourceTitle: undefined },
      { sourceVisible: true, targetVisible: "yes", sourceTitle: undefined },
      { sourceVisible: true, targetVisible: true, sourceTitle: 1 },
    ];
    for (const value of malformedValues) {
      const fake = fixture();
      fake.ports.membership.readCurrentRoots = (async () => value) as never;
      expect(await execute(fake, {})).toMatchObject({
        ok: false,
        error: { code: "export_unavailable" },
      });
      expect(fake.calls).not.toContain("export");
    }

    const rejected = fixture();
    rejected.ports.membership.readCurrentRoots = async () => {
      throw new Error("projection transport failed");
    };
    expect(await execute(rejected, {})).toMatchObject({
      ok: false,
      error: { code: "export_unavailable" },
    });
  });

  test("applies mode deny and rejects malformed overwrite policy decisions", async () => {
    const denied = fixture();
    expect(await execute(denied, { session_id: "ses_target" })).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    expect(denied.calls).not.toContain("export");

    for (const decision of [
      { mode: "allow", overwrite: "sometimes" },
      { mode: "allow", injected: "allow" },
    ]) {
      const malformed = fixture();
      (malformed.ports as unknown as { policy: unknown }).policy = {
        decisionFor: () => decision,
      };
      expect(await execute(malformed, { overwrite: true })).toMatchObject({
        ok: false,
        error: { code: "export_unavailable" },
      });
    }
  });

  test("fails closed when the second membership observation is rejected", async () => {
    const fake = fixture();
    let observations = 0;
    fake.ports.membership.readCurrentRoots = async () => {
      observations += 1;
      if (observations === 2) throw new Error("membership changed");
      return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
    };
    expect(await execute(fake, {})).toMatchObject({
      ok: false,
      error: { code: "export_unavailable" },
    });
    expect(fake.calls).not.toContain("export");
  });

  test("maps caller and target loss during the effect guard before invoking the exporter", async () => {
    for (const [hidden, code] of [
      ["source", "caller_not_visible"],
      ["target", "target_not_visible"],
    ] as const) {
      const fake = fixture();
      let observations = 0;
      fake.ports.membership.readCurrentRoots = async () => {
        observations += 1;
        return {
          sourceVisible: hidden !== "source" || observations < 3,
          targetVisible: hidden !== "target" || observations < 3,
          sourceTitle: undefined,
        };
      };
      expect(await execute(fake, {})).toMatchObject({ ok: false, error: { code } });
      expect(fake.calls).not.toContain("export");
    }
  });

  test("maps guard deadline, membership failure, and aborted ownership checks to unavailable", async () => {
    const deadline = fixture();
    deadline.ports.ownership.isCurrent = () => new Promise(() => {});
    expect(await execute(deadline, {}, Date.now() + 20)).toMatchObject({
      ok: false,
      error: { code: "export_unavailable" },
    });

    const membership = fixture();
    let observations = 0;
    membership.ports.membership.readCurrentRoots = async () => {
      observations += 1;
      if (observations === 3) throw new Error("membership unavailable at effect boundary");
      return { sourceVisible: true, targetVisible: true, sourceTitle: undefined };
    };
    expect(await execute(membership, {})).toMatchObject({
      ok: false,
      error: { code: "export_unavailable" },
    });

    const aborted = fixture();
    const controller = new AbortController();
    let ownershipChecks = 0;
    aborted.ports.ownership.isCurrent = async () => {
      ownershipChecks += 1;
      if (ownershipChecks === 1) controller.abort();
      return true;
    };
    expect(await execute(aborted, {}, Date.now() + 10_000, controller.signal)).toMatchObject({
      ok: false,
      error: { code: "export_unavailable" },
    });
  });

  test("maps unexpected lifecycle epoch access to storage unavailable", async () => {
    const fake = fixture();
    Object.defineProperty(fake.ports.readiness, "fencingToken", {
      get() {
        throw new Error("broken lifecycle state");
      },
    });
    expect(await execute(fake, {})).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
  });
});
