# v1 compatibility contract

The stable v1 line follows this contract. Stable publication requires reviewed passing
48-hour soak evidence or an explicit owner exception bound to the exact version and
runtime/dependency digest in `release-readiness.json`. An exception does not make a
failed soak pass; an RC alone is not a production-readiness claim.

## Supported environment

- Linux x64 and a private local filesystem compatible with the SQLite and secure
  export checks. Other architectures, network filesystems, and missing kernel
  capabilities are not silently supported through fallbacks.
- Stable OpenCode `>=2.1.3 <2.3.0`. The build baseline is 2.1.3; live CI tests 2.1.3 and 2.2.2;
  this range is not evidence that every future patch has been tested.
- Bun 1.4.0 for development and release verification. OpenCode supplies the plugin
  execution runtime. The package is not a general Node.js application.

## Public behavior

The documented 21 tool IDs, argument/result schemas, stable error meanings,
workspace/root restrictions, and static-policy defaults form the public API.
Additional compatible tools or optional result fields may be introduced in a
minor release. Removing fields/tools, changing defaults to disclose more data,
weakening guarantees, or dropping a supported runtime requires a major release.

Queue admission is not execution or completion. Durable requests and their
inbox/outbox results are the authoritative coordination channel. Ambiguous
external effects are not automatically replayed. Native children are not root
communicator participants. Advisory locks are not authorization or exclusion.

Context delivery and `session_stop` remain registered but explicitly unsupported
without authoritative public-host activity evidence. Discovery uses observed
registry candidates and current ID-addressed host revalidation, not a complete
host-wide inventory. Activity can remain unknown.

Reads expose a structurally restricted, untrusted projection of at most the
newest 512 current-context entries. `earlier_context_unavailable` identifies an
excluded prefix; cursors do not recover it. No operation promises complete
history or pre-deserialization transport limits. Exports are sanitized and
contained, and reject truncated windows before creating a file.

## Persistence and upgrades

Migrations merged into the default branch are append-only. Back up private state
before upgrading. Never run older binaries against a newer schema unless an
explicitly tested downgrade path exists. Rolling back the package alone is not
a database downgrade. Startup recovery must finish before tools become usable.

Patch releases fix compatible bugs. Minor releases add compatible capabilities.
Major releases may change the public API, storage compatibility, policy defaults,
or minimum supported environment. Security fixes do not silently redefine success,
cancellation, disclosure, or native ambiguity.

## Distribution and trust

RC versions use npm `next` and GitHub prereleases. Stable versions use `latest`.
Every release tag must match `package.json`; published tags, versions and assets
are immutable. A correction is a new version, not a replacement artifact.
GitHub and npm distribute the same verified tarball, with checksums, dependency
license inventory, SBOM, and npm provenance. Provenance identifies build origin;
it does not prove the absence of defects or grant permission to peer content.
