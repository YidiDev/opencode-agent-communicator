# Release operations

## Identities and ownership

The project author and copyright holder of original work is Yidi Sprei
([@YidiDev](https://github.com/YidiDev)). npm ownership belongs to the `yididev`
account; GitHub Actions uses its own real bot identity for automated release PRs.
An automation identity is not a contributor copyright assignment.

The npm trusted publisher must bind these exact values:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions, GitHub-hosted runner |
| Owner | `YidiDev` |
| Repository | `opencode-agent-communicator` |
| Workflow filename | `publish.yml` |
| Environment | `release` |
| Allowed operation | Direct `npm publish`; staged publishing may also be allowed |

An owner can configure this through the documented `npm trust github` command or
the package's npm settings. npm may require interactive account verification or
2FA. Never put an OTP, auth URL, or npm token in a PR, workflow, or chat. Restrict
traditional tokens after trusted publishing succeeds. The first successful
trusted publication must occur before npm's configuration-expiry deadline.

For a new package, agree on the bootstrap before creating anything public. npm's
`stage publish` can reserve the name with a minimal unapproved stub and an empty
public `0.0.0-stage` placeholder. The stub is not project code or a real release;
do not approve it. Configure the exact trusted publisher after reservation.

**Keep the reservation stub pending until the first real, attested RC is
published and verified.** Rejecting the final pending stage while only its
placeholder exists automatically unpublishes the placeholder and removes trust.
npm then enforces a 24-hour republication hold. Do not bypass it or rename the
package to evade it. An HTTP 200 packument containing only `time.unpublished`
is a tombstone, not proof that ownership or trust still exists.

Before removing the reservation stub, verify the real release against the
original release artifact and complete the public-consumer provenance checks:
download the original run's archive artifact into `release/`, including
`release-metadata.json` and the tarball. Do not rebuild it.

```bash
node tools/release-registry.mjs release --verify-download
```

Only after those checks succeed may the owner reject the unapproved stub. A
bootstrap without provenance must be labeled accurately; never silently adopt
an unattested version or reuse a published version. For an agent-driven browser
MFA operation, keep the official npm CLI running in a PTY so it can finish the
approval exchange; a non-interactive command exits instead of completing it.

## Release PR and signed tag

`release-please.yml` prepares version/changelog PRs from Conventional Commits.
It does not publish releases or impersonate the maintainer. Its write token is
limited to the PR job. A separate narrowly scoped job explicitly dispatches CI,
because token-created PR events do not automatically trigger ordinary PR CI.

While stabilizing v1, Release Please uses the `rc` prerelease strategy. Switching
to stable requires a reviewed PR that changes that strategy and approves valid
soak evidence; editing a dist-tag does not turn an RC into a stable version.

After a release PR is reviewed, merged, and verified, the maintainer creates a
signed annotated tag on that exact main commit:

```bash
version="$(node -p 'require("./package.json").version')"
git tag -s "v$version" -m "Release v$version"
git tag -v "v$version"
git push origin "refs/tags/v$version"
```

Do not tag an unrelated checkout. The tag-push workflow automatically performs
the remaining release work; manual workflow dispatch on the exact tag is for
recovery, not a bypass of checks. Never force-push or retarget public release tags.

For **1.0.1 only**, the owner explicitly authorized an unsigned annotated tag because
the local terminal-only GPG prompt timed out. It must target the exact GitHub-verified
main merge commit and disclose the exception in its annotation. This is not a signed-tag
claim or permission for future versions; npm OIDC provenance, registry signatures,
archive/origin verification, immutable releases, and every CI gate remain required.

## Release pipeline

1. Require the exact public repository, canonical tag/version, trusted-main
   ancestry, and stable-readiness policy.
2. Run all quality, coverage, live, store, export, and portability checks.
3. Check the frozen production license inventory. Pack once, generate a CycloneDX
   SBOM, and checksum every release asset.
   The SBOM describes the frozen build graph, not every future consumer's npm resolution.
4. Download the archive into a dependency-install-free OIDC job. Use the exact
   trusted workflow/environment, direct-publish permission, and short-lived npm
   credentials. RCs publish to `next`; stable versions publish to `latest`.
5. Verify npm's archive integrity and provenance, download the tarball, and compare
   its bytes with the verified archive. Install in a fresh public npm consumer,
    import through Bun, and verify registry signatures/provenance. Separately bind
    the signed subject to the archive and the origin to the exact repository,
    release tag, `publish.yml`, source commit, and GitHub-hosted builder. Parsing
    origin claims alone never replaces cryptographic signature verification.
6. Upload the same assets to a draft GitHub release, verify uploaded bytes, then
   publish it. Enable immutable releases and protect release tags in GitHub.

The publish job does not install dependencies or run package lifecycle scripts.
GitHub-release write permissions are separate from npm OIDC permissions.

## Partial failures

If npm publication succeeds but a later check fails, do not republish or delete the
version. A rerun accepts it only when the archive is byte-identical and provenance
is present. Registry failures other than authoritative absence stay errors.
Prefer rerunning failed jobs with the original verified artifact. A new full run
regenerates SBOM timestamps/identifiers and must not replace already released
assets. Keep the original evidence artifact for recovery; workflow concurrency
serializes all versions, not just retries of one tag.

If a draft GitHub release has only some assets, inspect it and upload only missing
verified assets; never use `--clobber`. A complete existing release must match all
assets exactly. Published immutable releases are not edited on a retry. Wrong
bytes require a new version and a clearly described correction.

Package rollback means pinning a previous tested version, not overwriting `latest`
blindly or downgrading state. Any dist-tag repair is an explicit owner operation;
OIDC dist-tag changes require their own npm permission and a compatible npm CLI.

## Stable readiness and privacy

Stable publication normally requires reviewed evidence of at least 48 hours with the same
runtime/dependency digest. Cover multiple isolated repositories, long-lived hosts,
idle periods, concurrent roots, restarts, ownership contention, and controlled
clock-discontinuity regressions. Record failures and recovery behavior; do not
replace this evidence with an ordinary green CI run. Keep issue #46 open until
its separate reliability acceptance criteria are satisfied.

The maintainer may explicitly authorize an exception for one exact stable version and runtime
digest. Record it in readiness schema 2 with `stable_approved: true` and an `approval` object:
`method: "owner_exception"`, `approved_by: "YidiDev"`, exact `version` and `runtime_sha256`, a
nonempty substantive `reason`, and a public repository issue or PR `report_url`. The release PR
must make the exception visible and retain truthful failed/incomplete `soak` data. Changes to the
version or runtime invalidate the exception. Schema 1 retains the normal passing 48-hour path.
Exceptions do not waive ordinary CI, security, immutable archives/tags, trusted publishing,
provenance, or fresh public-consumer verification, and do not close issue #46 by themselves.

Stable `1.0.0` uses this owner-authorized exception: the WSL-hosted soak failed its clock-continuity
guard and does not establish 48-hour stability. See the
[public rationale](https://github.com/YidiDev/opencode-agent-communicator/issues/46#issuecomment-6514468132).

### Measured packed-runtime soak

Use the original tag workflow's downloaded archive artifact, not a rebuilt tarball.
Set `ARTIFACT_DIRECTORY` to that private artifact directory and `NEW_PRIVATE_OUTPUT`
to a new directory outside the checkout. The runner refuses to overwrite or resume
an earlier report. A short harness smoke is explicitly not stable evidence:

```bash
bun test/soak/runner.ts --artifact "$ARTIFACT_DIRECTORY" --output "$NEW_PRIVATE_OUTPUT" --smoke
```

Omit `--smoke` and choose another new output directory for the actual 48-hour run.
The runner verifies the original archive checksum and runtime digest, installs its
frozen lockfile in a private installation, and uses the actual `src/` plugin directory.
It runs two isolated Git repositories with two concurrent roots each, five-minute
idle intervals, hourly delivery/request/lock/read and fail-closed journeys, and one
planned restart of the second host with its existing roots. The first host remains
running throughout. Loopback servers use fresh private authentication and a local
deterministic model; no personal model credentials or paid-model traffic are used.
The fixture provider supplies structured compaction summaries and resumes only the
unfinished latest user exchange retained in a checkpoint, without replaying completed
tool calls. Automatic compaction remains enabled with the normal fixture model limits.
Resource samples include deduplicated completed-compaction counts for each host
process (reset on the planned restart); a full pass requires observed successful
compaction in both final host processes. Smoke runs do not claim that coverage.
The driver subscribes to public native events before each invocation and correlates
the completed result with a fresh synthetic call identifier and target session.
It does not assume a tool result remains in current context after automatic compaction,
reconstruct results from summary text, or replay a completed command to recover evidence.

Controlled clock/store regressions and the Docker Linux ownership/crash matrix run
before and after the full observation interval. They are companion evidence, not
claims of changing the user's OS clock or continuously injecting crashes. Reports
contain aggregate timing/resource metrics and safe assertion labels, not prompts,
answers, session identifiers, server credentials, or workspace paths. Inspect the
final `summary.json` and `events.jsonl`, including failures and resource trends.
Tool RPC failures identify the controlled tool/stage and an allowlisted error kind;
continuity failures include only monotonic/wall deltas and the configured gap bound.
These diagnostics never include upstream error messages or stack traces. If a run
fails, preserve its report and diagnose it before beginning a fresh 48-hour interval;
never combine partial runs or relax the observation bounds to obtain a pass.
Interrupted runs, missed observation bounds, clock jumps, changed runtimes, failed
companions, and cleanup failures cannot qualify. A `smoke_passed` result never
qualifies, even if the smoke was left running longer. The runner never changes
`release-readiness.json`; review and publish the measured evidence before approving
stable readiness. Keep the host running until completion.

### Publication privacy

Before making the repository public, audit every reachable branch/tag, release
asset, issue/PR attachment, CI artifact/log, and publication setting. Do not add
local transcripts, private backups, credentials, databases, or machine-specific
paths to the archive. `files` allowlisting and the exact archive fingerprint remain
mandatory. Review new dependency license expressions before regenerating the
inventory with `node tools/check-licenses.mjs --update`.
