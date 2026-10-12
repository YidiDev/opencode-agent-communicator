import { describe, expect, test } from "bun:test";

import { sessionExportPolicyPort } from "../../../src/application/session-export-policy";
import { createSessionExportPolicy } from "../../../src/domain/session-export";

describe("session export policy", () => {
  test("allows only configured sanitized self and cross-session exports", () => {
    const allow = sessionExportPolicyPort(
      createSessionExportPolicy({
        selfSanitized: "allow",
        crossSession: "allow",
        overwrite: "allow",
      }),
    );
    expect(allow.decisionFor({ isSelf: true, isSanitized: true, shouldOverwrite: false })).toEqual({
      mode: "allow",
    });
    expect(allow.decisionFor({ isSelf: false, isSanitized: true, shouldOverwrite: true })).toEqual({
      mode: "allow",
      overwrite: "allow",
    });
    expect(allow.decisionFor({ isSelf: true, isSanitized: false, shouldOverwrite: false })).toEqual(
      {
        mode: "deny",
      },
    );
  });

  test("uses cross-session mode for peers and keeps overwrite independent", () => {
    const deniedSelf = sessionExportPolicyPort(
      createSessionExportPolicy({
        selfSanitized: "deny",
        crossSession: "allow",
        overwrite: "deny",
      }),
    );
    expect(
      deniedSelf.decisionFor({ isSelf: false, isSanitized: true, shouldOverwrite: true }),
    ).toEqual({ mode: "allow", overwrite: "deny" });

    const deniedCross = sessionExportPolicyPort(
      createSessionExportPolicy({ selfSanitized: "allow", crossSession: "deny" }),
    );
    expect(
      deniedCross.decisionFor({ isSelf: false, isSanitized: true, shouldOverwrite: false }),
    ).toEqual({ mode: "deny" });
  });
});
