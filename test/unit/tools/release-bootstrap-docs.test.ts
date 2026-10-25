import { expect, test } from "bun:test";

test("bootstrap instructions retain the reservation until attested publication and explain cleanup recovery", async () => {
  const instructions = await Bun.file("docs/releases.md").text();
  expect(instructions).toContain("Keep the reservation stub pending");
  expect(instructions).toContain("published and verified");
  expect(instructions).toContain("automatically unpublishes the placeholder and removes trust");
  expect(instructions).toContain("24-hour republication hold");
  expect(instructions).toContain("time.unpublished");
  expect(instructions).toContain("node tools/release-registry.mjs release --verify-download");
  expect(instructions).toContain("public-consumer provenance checks");
  expect(instructions).toContain("official npm CLI running in a PTY");
});
