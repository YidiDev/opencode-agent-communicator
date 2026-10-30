import { describe, expect, test } from "bun:test";

import {
  isSupportedOpenCodeVersion,
  minimumSupportedOpenCodeVersion,
  parseSupportedOpenCodeVersion,
  supportedOpenCodeVersionRange,
} from "../../../src/domain/host";

describe("OpenCode host version range", () => {
  test("models the declared stable OpenCode v2 range", () => {
    expect(minimumSupportedOpenCodeVersion).toBe("2.1.3");
    expect(supportedOpenCodeVersionRange).toBe(">=2.1.3 <2.3.0");
  });

  test.each([
    "2.1.3",
    "2.1.4",
    "2.1.999",
    `2.1.${Number.MAX_SAFE_INTEGER}`,
    "2.2.0",
    "2.2.2",
    "2.2.999",
  ])("accepts canonical supported patch %s", (version) => {
    expect(parseSupportedOpenCodeVersion(version)).toBe(version);
    expect(isSupportedOpenCodeVersion(version)).toBe(true);
  });

  test.each([
    undefined,
    null,
    2_000_026,
    "1.18.99",
    "2.0.25",
    "2.0.26",
    "2.1.0",
    "2.1.2",
    "2.3.0",
    "2.2.02",
    "2.2.2-rc.1",
    "2.2.2+build.1",
    `2.2.${Number.MAX_SAFE_INTEGER + 1}`,
    "3.0.26",
    "2.1.03",
    "2.1.+3",
    "2.1.3.0",
    "2.1.3-beta.1",
    "2.1.3+build.1",
    `2.1.${Number.MAX_SAFE_INTEGER + 1}`,
  ])("rejects unsupported or noncanonical version %p", (version) => {
    expect(parseSupportedOpenCodeVersion(version)).toBeUndefined();
    expect(isSupportedOpenCodeVersion(version)).toBe(false);
  });
});
