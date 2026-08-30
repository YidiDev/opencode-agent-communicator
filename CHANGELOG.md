# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-08-29

### Changed

- Clarified the nested `session_respond` answer shape in the participant skill, tool description,
  and public argument schema so single-question answers remain one inner array per question.
- Strengthened packed live evidence for active-session advisory-lock notifications.

## [0.4.0] - 2026-08-29

### Added

- Added immediate-return `session_request_send` and `session_request_start` workflows that persist a
  recoverable ask or wait before one canonical queue or initial-message effect.
- Added SQLite schema v14 request delivery modes (`steer`, `queue`, and `initial`) with optional
  linked start-operation identity; existing requests migrate to `steer`.
- Added SQLite schema v15 terminal linked-request correlation so an unstarted managed-session
  reservation is released without being misreported as an approval rejection.

### Changed

- Managed request-start authorization now precedes one fenced SQLite transaction for the start and
  linked request, with complete-argument replay binding and no-replay ambiguity recovery.
- Canonical request envelopes now name the matching response tool and request ID and may carry
  digest-bound untrusted work content without implying authorization.
- Request list/get metadata exposes delivery mode and linked start operation ID. Existing blocking
  `session_ask` and `session_wait` behavior remains active-only and unchanged.

## [0.3.0] - 2026-08-28

### Added

- Added `session_lock_list`, `session_lock_publish`, `session_lock_release`, and
  `session_lock_renew` in the canonical 18-tool manifest for workspace-scoped, time-bounded advisory
  coordination.
- Added SQLite schema v13 with fenced persistence, bounded expiry cleanup, holder-only mutation,
  active-lock quotas, opaque keyset pagination, and canonical ISO 8601 public timestamps.
- Added best-effort mutation notifications to observed `busy`/`retry` peers and the bundled
  `session-locks` workflow skill.

### Changed

- Added concise lock preflight guidance to the bundled `session-communication` and
  `session-request-participant` skills while preserving independent peer authority boundaries.
- Expanded packed-package, black-box, and live production harness contracts to 18 tools and three
  skills, including a publish/list/renew/release journey.

### Security

- Documented that lock Markdown is untrusted, active-list state is authoritative, notifications are
  hints only, and advisory locks provide neither enforcement nor authorization.

## [0.2.5] - 2026-08-28

### Changed

- Reframed the plugin around durable communication between independent, first-class peer sessions;
  source and target are temporary operation roles, and peer content remains advisory rather than
  authoritative.
- Renamed the bundled `session-orchestrator` and `session-worker` skills to
  `session-communication` and `session-request-participant`.
- Clarified that communicator-created session provenance supports idempotency, quotas, recovery, and
  chained-start policy without creating a supervisor/worker hierarchy.

## [0.2.4] - 2026-08-28

### Fixed

- Restored asynchronous `session_start` settlement by submitting the public initial prompt once and
  returning after exact fixed-message transcript read-back instead of waiting for assistant completion.
- Routed ordinary `session_send` through the same public transcript execution plane so managed agents
  retain conversation context and sent turns remain visible in the TUI and `opencode export`.
- Strengthened the packed production journey to prove start and send return while provider responses
  remain gated, followed by eventual assistant completion and export visibility.

### Changed

- Added SQLite schema v12 to distinguish public-message admission evidence from historical V2 queue
  evidence without fabricating admission or promotion sequence numbers.
- Increased the reviewed runtime archive policy to 251 paths for the public-message adapter.

## [0.2.3] - 2026-08-28

### Fixed

- Routed managed-root title updates and initial prompts through OpenCode's public session surface so
  the TUI and `opencode export` display the requested title, initial user message, and assistant
  response while retaining deterministic V2 session creation.
- Required the packed production journey to prove the managed session's public transcript and CLI
  export instead of accepting V2-only execution evidence.

## [0.2.2] - 2026-08-28

### Fixed

- Accepted the pinned SDK's genuine `request` evidence in exact native rejection envelopes, allowing
  `session_start` to prove deterministic-ID absence and create managed root sessions.
- Required the packed production journey to prove native session creation and initial-message
  admission instead of accepting `creation_state: "outcome_unknown"`.

### Changed

- Updated the exact build-time OpenCode packages and live release evidence to `1.18.25` without
  changing the supported stable `>=1.18.21 <1.19.0` host range.

## [0.2.1] - 2026-08-28

### Fixed

- Reused OpenCode's injected in-process transport for startup health and V2 tool operations, allowing
  the plugin to load and run during direct `opencode run` commands without a separate HTTP listener.

### Changed

- Updated the exact build-time OpenCode packages and live release evidence to `1.18.24` without
  changing the supported stable `>=1.18.21 <1.19.0` host range.

## [0.2.0] - 2026-08-28

### Changed

- Upgraded the TypeScript compiler from 5.9.3 to 7.0.2.
- Upgraded Zod from 4.1.8 to 4.4.3.

## [0.1.4] - 2026-08-27

### Fixed

- Replaced the unreliable direct private `git+ssh` OpenCode package-cache path with a tested external
  npm installation and absolute `file://` plugin entry.
- Added troubleshooting for the empty-cache failure that occurs before plugin import and tool
  registration.

## [0.1.3] - 2026-08-27

### Changed

- Promoted the fully verified `0.1.2` runtime tree without behavioral changes after every hosted
  quality, coverage, package, Docker security, and OpenCode compatibility job passed.

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

[Unreleased]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.2.5...v0.3.0
[0.2.5]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/YidiDev/opencode-agent-communicator/releases/tag/v0.1.4
[0.1.3]: https://github.com/YidiDev/opencode-agent-communicator/releases/tag/v0.1.3
[0.1.2]: https://github.com/YidiDev/opencode-agent-communicator/releases/tag/v0.1.2
[0.1.1]: https://github.com/YidiDev/opencode-agent-communicator/releases/tag/v0.1.1
[0.1.0]: https://github.com/YidiDev/opencode-agent-communicator/releases/tag/v0.1.0
