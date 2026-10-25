import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { assertProvenanceOrigin } from "../../../tools/release-provenance.mjs";

const bytes = new TextEncoder().encode("canonical archive");
const commit = "a".repeat(40);
const repository = "https://github.com/YidiDev/opencode-agent-communicator";
const predicateType = "https://slsa.dev/provenance/v1";
function statement() {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicateType,
    subject: [
      {
        name: "pkg:npm/opencode-agent-communicator@1.0.0-rc.1",
        digest: { sha512: createHash("sha512").update(bytes).digest("hex") },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: "refs/tags/v1.0.0-rc.1",
            repository,
            path: ".github/workflows/publish.yml",
          },
        },
        resolvedDependencies: [
          { uri: `git+${repository}@refs/tags/v1.0.0-rc.1`, digest: { gitCommit: commit } },
        ],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
}
function document(value: unknown) {
  return {
    attestations: [
      {
        predicateType,
        bundle: {
          dsseEnvelope: {
            payloadType: "application/vnd.in-toto+json",
            payload: Buffer.from(JSON.stringify(value)).toString("base64"),
          },
        },
      },
    ],
  };
}
test("binds provenance to the exact archive, tag, repository, workflow, commit and hosted builder", () => {
  expect(() =>
    assertProvenanceOrigin(document(statement()), bytes, "1.0.0-rc.1", commit),
  ).not.toThrow();
  for (const field of ["archive", "tag", "repository", "workflow", "commit", "builder"] as const) {
    const value = statement();
    if (field === "tag")
      value.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main";
    if (field === "repository")
      value.predicate.buildDefinition.externalParameters.workflow.repository =
        "https://github.com/foreign/repository";
    if (field === "workflow")
      value.predicate.buildDefinition.externalParameters.workflow.path =
        ".github/workflows/other.yml";
    if (field === "commit") {
      const dependency = value.predicate.buildDefinition.resolvedDependencies[0];
      if (!dependency) throw new Error("Missing fixture dependency");
      dependency.digest.gitCommit = "b".repeat(40);
    }
    if (field === "builder") value.predicate.runDetails.builder.id = "untrusted";
    expect(() =>
      assertProvenanceOrigin(
        document(value),
        field === "archive" ? new Uint8Array([1]) : bytes,
        "1.0.0-rc.1",
        commit,
      ),
    ).toThrow();
  }
});
test("rejects missing, malformed and ambiguous provenance without treating parsing as cryptographic verification", () => {
  const good = document(statement());
  for (const value of [
    null,
    {},
    { attestations: [] },
    { attestations: [...good.attestations, ...good.attestations] },
    document(null),
    { attestations: [{ predicateType, bundle: {} }] },
  ]) {
    expect(() => assertProvenanceOrigin(value, bytes, "1.0.0-rc.1", commit)).toThrow();
  }
  expect(() => assertProvenanceOrigin(good, bytes, "1.0.0-rc.1", "not-a-commit")).toThrow();
});
