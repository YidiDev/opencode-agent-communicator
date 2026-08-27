# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The `0.1.0` contents below are unreleased until the matching tag is created and the trusted
publishing workflow completes.

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

[Unreleased]: https://github.com/YidiDev/opencode-agent-communicator/commits/main
