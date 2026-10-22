# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Target stable OpenCode `>=2.1.3 <2.2.0` with aligned `@opencode/plugin` and `@opencode/cli`
  packages at `2.1.3` and Effect `4.0.1`. OpenCode 2.0 remains available through the v0.8.0 tag,
  but is not supported by this compatibility update.
- Configure the installed `src/` directory as the local plugin source. OpenCode 2.1 rejects
  `src/index.ts` file sources before setup, leaving no communicator registry entry. Packed live
  acceptance now loads the real installed directory instead of a synthetic wrapper.

### Tests

- Add the rejected-file loading regression, authorized idempotent start, cross-session read policy,
  durable wait/signal/ack, and capability-required packed-host export journeys on OpenCode 2.1.3.
- Keep context delivery and stop explicitly unsupported: the audited public plugin context still
  does not provide authoritative current activity. The extended soak in #46 remains separate.

## [0.8.0] - 2026-10-19

### Changed

- Migrated the production plugin to the public OpenCode v2 `Plugin.define` Effect API, with the
  existing 21 tools and three bundled skills registered through `tool.transform` and
  `skill.transform`. The supported host range is now `>=2.0.26 <2.1.0` on Linux x64 with Bun
  `1.4.0`; runtime packages build against `@opencode/plugin@2.0.26` and `@opencode/cli@2.0.26`.
- Replaced private/legacy host access with ID-addressed public v2 session operations. `session_list`
  now starts from the communicator-observed participant registry and authoritatively revalidates
  each candidate. Delivery and durable requests use public queue admission and do not require a
  prior `busy` observation.
- Redefined `session_read` and `session_export` as bounded, sanitized projections of the current
  model context. They do not expose or claim complete session history, and export no longer spawns
  an OpenCode CLI subprocess.
- Replaced imperative `ask` approval with deny-by-default static `allow`/`deny` policy for sensitive
  actions. Legacy `ask` and unsanitized-export configuration are rejected.

### Security

- Added SQLite migration v17 for the bounded communicator participant registry and hardened
  ownership lease acquisition/renewal against wall-clock regression while preserving monotonic
  local expiry and fencing.
- Removed the private HTTP transport surface; OpenCode interaction is confined to the public v2
  Effect plugin context.

### Fixed

- Kept all communicator tools on the primary tool surface with public v2 `codemode: false`, and
  corrected Effect timestamp decoding. The packed live harness now verifies actual correlated
  tool results and the complete tool/skill manifests.
- Made scoped startup acquisition/disposal atomic and linked host cancellation before compatibility
  checks. Caller cancellation settles lifecycle-owned queue claims without replay; admission and
  participant stop share a gate and revalidate the durable claim before a native effect.
- Charged the full restricted current-context snapshot on every read, including fixed-message
  misses. Limits describe projection bytes after host materialization, not raw transport bytes.
- Allowed visible current-context reads when activity is unknown. Context delivery and stop remain
  explicitly unsupported without authoritative public-v2 activity evidence.
- Added bounded keyset scanning past stale/filtered discovery candidates and oldest-candidate
  eviction at registry capacity without deleting protocol state.
- Corrected the live CI version assertion, prerelease installation instructions, static-policy skill
  guidance, and secure-export acceptance evidence description.

### Known limitations

- Explicit context delivery and `session_stop` remain unavailable without authoritative public-v2
  activity evidence. Use user-turn delivery or queue-based durable requests for communication.
- The extended isolated multi-repository soak and reproduction of the reported prolonged-runtime
  failure remain outstanding in #46; this release does not claim they are complete.

## [0.7.4] - 2026-09-07

### Fixed

- Hardened SQLite fencing and chronology checks, native OpenCode request/response correlation and
  bounded streaming, secure-export validation, context recovery and replay handling, and strict
  approval/result contracts so ambiguous or adversarial boundary behavior remains fail-closed.
- Corrected communicator guidance and strengthened generated-client, restart-recovery, packed-package,
  supported-OpenCode, workflow-ordering, and package-portability evidence.

## [0.7.3] - 2026-09-02

### Fixed

- The expired-lease recovery from #35 is now complete: a successor generation that itself stops with
  a port-contract violation exactly while taking over an already-lapsed lease is retried once instead
  of failing the communicator permanently with "A communicator port contract failed.". The retry only
  runs on a free lease, is bounded to one attempt, stays fail-closed (a genuine violation, a live
  contender, or a competitor that takes the lease mid-retry remains terminal), and never runs while
  the host is disposed. A storage fault while reading the expired-lease takeover delay now also fails
  closed with a storage-failure terminal instead of leaking an unclassified error.

## [0.7.2] - 2026-09-01

### Fixed

- Ownership lease expiry no longer leaves every tool permanently not-ready until OpenCode restarts.
  A later not-yet-started tool call can replace the full composition through one serialized,
  fail-closed recovery with one grace-aware bounded delay and a higher fencing epoch; started calls
  are never replayed, disposal aborts partial successor startup, ownership contention stays typed and
  sanitized, timed-out work is quarantined until cleanup, and drain,
  takeover, storage, contract, workflow, disposal, or replacement failures remain terminal.

## [0.7.1] - 2026-08-31

### Changed

- Communicator tools are now primary-only in OpenCode configuration. Newly created native `task`
  children keep their ordinary working tools and return through the native task result instead of
  seeing the 21 root-to-root communicator tools.

## [0.7.0] - 2026-08-30

### Added

- Added SQLite schema v16 with bounded store-backed context admissions and an explicit request
  delivery transport discriminator.

### Changed

- `session_send` now defaults to `delivery: "context"`, which injects peer-originated content into a
  `busy`/`retry` target's next provider request without creating a transcript turn. Explicit
  `delivery: "user"` retains native transcript-visible delivery and is the only existing-root mode
  that may wake idle work.
- Existing-root `session_ask`, `session_wait`, and `session_request_send` now use provider context;
  `session_request_start` retains its native initial user turn. Idle or unknown targets persist no
  context delivery or request.
- Advisory-lock mutations no longer fan out native steer turns. Active provider requests receive a
  bounded lock-presence reminder and continue to use `session_lock_list` as authority.
- Context messages share native delivery record, retained-byte, and rate quotas. Standalone terminal
  message admissions expire independently, while request admissions remain through parent retention.
- Context injection now revalidates exact root, archive, project, and directory metadata immediately
  before provider mutation, and request projections expose context transition timestamps.

### Security

- Provider context is bounded and explicitly labels all peer fields as untrusted. It is not stored
  in the OpenCode transcript or included in transcript export.
- Startup fails context admissions whose prior injection is uncertain and never replays them.

## [0.6.0] - 2026-08-30

### Added

- Added `session_read` immediately after `session_list` in the canonical 21-tool manifest. It returns
  chronological, cursor-paginated restricted transcript projections with 100 default/500 maximum
  rendered lines, 4,096-byte line wrapping, a 65,536-byte content cap, append-aware opaque protocol cursors,
  and explicit `cursor_stale` recovery.
- Added bounded native page and fixed-anchor reads with immutable 8-message pages, 96 transcript calls, 512 raw
  examined messages including omitted variants, 8 MiB projection-safe assistant-text examination,
  16,384 examined assistant parts, 32,768 rendered lines per invocation, 8,192 rendered lines per
  message, 4 MiB per-response and 32 MiB invocation-wide pre-deserialization response caps, and
  512-character native cursors. One shared
  budget includes the initial anchor, every page, and the final anchor reread.
- Added exact structural adapter ceilings of 1,048,576 UTF-16 characters per native text part, 4,096
  parts per assistant message, and 256 UTF-16 characters per raw tool name; these remain separate from
  invocation-wide transcript work budgets.

### Security

- Limited transcript projection to omitted user markers, assistant state/text, and tool name/status;
  reasoning, user content, tool input/output, and other native metadata remain excluded. Assistant
  text is documented as unsanitized, prompt-injection-capable peer data.
- Allowed self-read only for the current visible root and required exact per-invocation approval for
  cross-session reads, with abort-aware visibility checks before and after approval, before every
  native read, and immediately before disclosure. Transcript content is not persisted, logged,
  exported, or written.

## [0.5.0] - 2026-08-29

### Fixed

- Blocking `session_ask` and `session_wait` calls now reconcile promptly to `target_stopped` or
  `source_stopped` after an approved stop or an authoritatively revalidated native idle event,
  including missed-event anti-entropy and request-creation race protection.

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

[Unreleased]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.7.4...v0.8.0
[0.7.4]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.7.3...v0.7.4
[0.7.3]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/YidiDev/opencode-agent-communicator/compare/v0.4.1...v0.5.0
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
