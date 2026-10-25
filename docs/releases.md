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

If npm requires an initial owner-authenticated publication before trust can be
configured, stop and agree on a separate bootstrap prerelease. A bootstrap without
provenance must be labeled accurately; the automated attested RC uses a different
version. Never silently adopt an unattested version or reuse a published version.

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

Stable publication requires reviewed evidence of at least 48 hours with the same
runtime/dependency digest. Cover multiple isolated repositories, long-lived hosts,
idle periods, concurrent roots, restarts, ownership contention, and controlled
clock-discontinuity regressions. Record failures and recovery behavior; do not
replace this evidence with an ordinary green CI run. Keep issue #46 open until
its separate reliability acceptance criteria are satisfied.

Before making the repository public, audit every reachable branch/tag, release
asset, issue/PR attachment, CI artifact/log, and publication setting. Do not add
local transcripts, private backups, credentials, databases, or machine-specific
paths to the archive. `files` allowlisting and the exact archive fingerprint remain
mandatory. Review new dependency license expressions before regenerating the
inventory with `node tools/check-licenses.mjs --update`.
