import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseVersion } from "./release-policy.mjs";

const repository = "https://github.com/YidiDev/opencode-agent-communicator";
const predicateType = "https://slsa.dev/provenance/v1";

/** Structural origin binding complements, but never replaces, npm audit signatures. */
export function assertProvenanceOrigin(document, bytes, version, commit) {
  const { tag } = releaseVersion(version);
  assert(typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit), "Invalid source commit");
  assert(Array.isArray(document?.attestations), "Missing provenance attestations");
  const envelopes = document.attestations.filter((value) => value.predicateType === predicateType);
  assert(envelopes.length === 1, "Missing or ambiguous provenance");
  const envelope = envelopes[0].bundle?.dsseEnvelope;
  assert(envelope?.payloadType === "application/vnd.in-toto+json", "Invalid provenance envelope");
  assert(typeof envelope.payload === "string", "Missing provenance payload");
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  assert(
    statement._type === "https://in-toto.io/Statement/v1" &&
      statement.predicateType === predicateType,
    "Invalid provenance statement",
  );
  assert.deepEqual(
    statement.subject,
    [
      {
        name: `pkg:npm/opencode-agent-communicator@${version}`,
        digest: { sha512: createHash("sha512").update(bytes).digest("hex") },
      },
    ],
    "Provenance subject does not match the canonical archive",
  );
  const build = statement.predicate?.buildDefinition;
  assert.deepEqual(
    build?.externalParameters?.workflow,
    {
      ref: `refs/tags/${tag}`,
      repository,
      path: ".github/workflows/publish.yml",
    },
    "Provenance workflow origin does not match this release",
  );
  assert(
    build.resolvedDependencies?.some(
      (dependency) =>
        dependency.uri === `git+${repository}@refs/tags/${tag}` &&
        dependency.digest?.gitCommit === commit,
    ),
    "Provenance source commit does not match this release",
  );
  assert(
    statement.predicate.runDetails?.builder?.id ===
      "https://github.com/actions/runner/github-hosted",
    "Untrusted provenance builder",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? "release";
  const metadata = JSON.parse(readFileSync(resolve(root, "release-metadata.json"), "utf8"));
  const version = releaseVersion(metadata.version).version;
  const response = await fetch(
    `https://registry.npmjs.org/-/npm/v1/attestations/opencode-agent-communicator@${version}`,
    {
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    },
  );
  assert(response.ok, "Published provenance is unavailable");
  assertProvenanceOrigin(
    await response.json(),
    readFileSync(resolve(root, `opencode-agent-communicator-${version}.tgz`)),
    version,
    process.env.EXPECTED_SOURCE_COMMIT,
  );
  console.log(
    "Verified provenance origin and canonical archive subject after npm signature verification",
  );
}
