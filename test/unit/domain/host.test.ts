import { describe, expect, test } from "bun:test";

import {
  isSupportedOpenCodeVersion,
  minimumSupportedOpenCodeVersion,
  parseSupportedOpenCodeVersion,
  supportedOpenCodeVersionRange,
} from "../../../src/domain/host";

describe("OpenCode host version range", () => {
  test("models the declared stable OpenCode v2 range", () => {
    expect(minimumSupportedOpenCodeVersion).toBe("2.0.26");
    expect(supportedOpenCodeVersionRange).toBe(">=2.0.26 <2.1.0");
  });

  test.each(["2.0.26", "2.0.27", "2.0.999", `2.0.${Number.MAX_SAFE_INTEGER}`])(
    "accepts canonical supported patch %s",
    (version) => {
      expect(parseSupportedOpenCodeVersion(version)).toBe(version);
      expect(isSupportedOpenCodeVersion(version)).toBe(true);
    },
  );

  test.each([
    undefined,
    null,
    2_000_026,
    "1.18.99",
    "2.0.25",
    "2.1.0",
    "3.0.26",
    "2.0.026",
    "2.0.+26",
    "2.0.26.0",
    "2.0.26-beta.1",
    "2.0.26+build.1",
    `2.0.${Number.MAX_SAFE_INTEGER + 1}`,
  ])("rejects unsupported or noncanonical version %p", (version) => {
    expect(parseSupportedOpenCodeVersion(version)).toBeUndefined();
    expect(isSupportedOpenCodeVersion(version)).toBe(false);
  });
});
