# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-08-27

### Changed

- Split every runtime source file above the 300-line review threshold into cohesive, acyclic modules
  without changing public APIs, persistence semantics, or lifecycle ordering.
- Backtested the unmodified live compatibility harness against OpenCode `1.18.20`; its native
  sanitized export fails strict validation, confirming `1.18.21` as the natural compatibility floor.
- Made live-test descriptions report the selected OpenCode matrix version instead of the build-time
  default.

## [0.1.1] - 2026-08-27

### Changed

- Expanded host compatibility from exact OpenCode `1.18.21` to stable versions
  `>=1.18.21 <1.19.0`, while compiling and packaging against `1.18.23`.
- Renamed the native adapter and live harness for the supported `1.18.x` line instead of one patch.
- Added minimum/build-time compatibility testing to every pull request, main-branch push, and release
  verification run.
- Added grouped, patch-only Dependabot updates for the three OpenCode packages.
- Made npm publication manual-only; `0.1.1` is distributed as a GitHub Release.

## [0.1.0] - 2026-08-27

### Added

- Fourteen workspace-scoped tools for session discovery, delivery, durable ask/wait workflows,
  request inspection and acknowledgement, session lifecycle, and transcript export.
- Private Linux SQLite persistence with ownership leases, startup recovery, bounded retention, and
  explicit ambiguous-outcome states.
- Mandatory approval boundaries for stop and policy-controlled start/export operations.
- Bundled orchestrator and worker skills.
- Optional Linux-hardened session export with capability checks, strict OpenCode executable trust,
  bounded direct process execution, and descriptor-relative destination installation.
- Exact compatibility pinning and live capability evidence for OpenCode `1.18.21`.
- Linux x64 package metadata and certification scope; retained ARM64 syscall constants are
  explicitly future, uncertified scope rather than release support.
- Startup and periodic participant-deletion reconciliation from strict direct per-ID evidence,
  including one atomic complete-absent-set mutation, target-first role resolution, and no deletion
  inference from list absence.

### Security

- The package is restricted to Linux x64 and the plugin fails closed on unsupported hosts, unsafe state/export paths, incompatible OpenCode
  behavior, ownership loss, and unavailable secure-export capabilities.
- Communication remains untrusted advisory data and does not provide remote command execution.

[Unreleased]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/YidiDev/opencode-agent-communicator/releases/tag/v0.1.2
[0.1.1]: https://github.com/YidiDev/opencode-agent-communicator/releases/tag/v0.1.1
[0.1.0]: https://github.com/YidiDev/opencode-agent-communicator/releases/tag/v0.1.0
