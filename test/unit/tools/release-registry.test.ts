import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { assertPublishedArtifact, inspectRegistry } from "../../../tools/release-registry.mjs";

const bytes = new TextEncoder().encode("verified archive");
const metadata = {
  name: "opencode-agent-communicator",
  version: "1.0.0-rc.1",
  dist: {
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
  },
};

test("a retry accepts only byte-identical publication with supported provenance", () => {
  expect(() => assertPublishedArtifact(metadata, bytes)).not.toThrow();
  expect(() => assertPublishedArtifact(metadata, new Uint8Array())).toThrow("differs");
  expect(() =>
    assertPublishedArtifact({ dist: { ...metadata.dist, attestations: {} } }, bytes),
  ).toThrow("provenance");
});

test("only an authoritative 404 means absent; transport and registry errors stay explicit", async () => {
  const request =
    (status: number, body: unknown = {}) =>
    async () =>
      new Response(JSON.stringify(body), { status });
  expect(await inspectRegistry("1.0.0-rc.1", bytes, request(404))).toEqual({ state: "absent" });
  expect((await inspectRegistry("1.0.0-rc.1", bytes, request(200, metadata))).state).toBe(
    "published",
  );
  await expect(inspectRegistry("1.0.0-rc.1", bytes, request(503))).rejects.toThrow("unavailable");
  await expect(
    inspectRegistry("1.0.0-rc.1", bytes, request(200, { ...metadata, name: "other" })),
  ).rejects.toThrow("identity");
  await expect(
    inspectRegistry("1.0.0-rc.1", bytes, async () => {
      throw new Error("network");
    }),
  ).rejects.toThrow("network");
});
