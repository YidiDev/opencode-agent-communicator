import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releaseVersion } from "./release-policy.mjs";

export function assertPublishedArtifact(metadata, bytes) {
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (metadata?.dist?.integrity !== integrity)
    throw new Error("Published version differs from the verified archive; never overwrite it");
  if (metadata.dist.attestations?.provenance?.predicateType !== "https://slsa.dev/provenance/v1")
    throw new Error(
      "Published version has no supported provenance; do not silently adopt an unattested bootstrap version",
    );
}

export async function inspectRegistry(version, bytes, request = fetch) {
  releaseVersion(version);
  const response = await request(
    `https://registry.npmjs.org/opencode-agent-communicator/${version}`,
    { signal: AbortSignal.timeout(30_000), redirect: "error" },
  );
  if (response.status === 404) return { state: "absent" };
  if (!response.ok)
    throw new Error("Registry state is unavailable; do not guess that publication is absent");
  const metadata = await response.json();
  if (metadata.name !== "opencode-agent-communicator" || metadata.version !== version)
    throw new Error("Registry package identity mismatch");
  assertPublishedArtifact(metadata, bytes);
  return { state: "published", metadata };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(process.argv[2] ?? "release");
  const release = JSON.parse(await readFile(join(root, "release-metadata.json"), "utf8"));
  const { version } = releaseVersion(release.version);
  const bytes = await readFile(join(root, `opencode-agent-communicator-${version}.tgz`));
  const inspected = await inspectRegistry(version, bytes);
  if (process.argv.includes("--verify-download")) {
    if (inspected.state !== "published")
      throw new Error(
        "Published version is not visible yet; rerun verification rather than republishing",
      );
    const url = new URL(inspected.metadata.dist.tarball);
    if (
      url.origin !== "https://registry.npmjs.org" ||
      url.pathname !== `/opencode-agent-communicator/-/opencode-agent-communicator-${version}.tgz`
    )
      throw new Error("Registry tarball location is unexpected");
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
    if (!response.ok) throw new Error("Published tarball is unavailable");
    const downloaded = new Uint8Array(await response.arrayBuffer());
    if (
      createHash("sha256").update(downloaded).digest("hex") !==
      createHash("sha256").update(bytes).digest("hex")
    )
      throw new Error("Published tarball bytes differ from the release archive");
  }
  console.log(inspected.state);
}
