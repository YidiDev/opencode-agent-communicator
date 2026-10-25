# Security policy

## Supported versions

This project is prerelease software. Security fixes are provided only for the current release line.

| Version | Supported | Required host |
| --- | --- | --- |
| 1.0.0 release candidates | Preview; not stable | Linux x64, stable OpenCode >=2.1.3 <2.2.0; Bun 1.4.0 for verification |
| 0.9.1 | Superseded; lacks the RC dependency security fixes | Linux x64, stable OpenCode >=2.1.3 <2.2.0 |
| 0.9.0 and earlier | No | Not applicable |
| Earlier development builds | No | Not applicable |

Before v1 becomes stable, the release candidate is the security-fix target, not a stability
guarantee. It updates the vulnerable Zod and locked Undici versions identified during the public
launch audit. Existing release archives are not replaced or relabeled.

Host compatibility is part of the security boundary. Do not use this release on another operating
system or CPU architecture, or with an OpenCode version outside the supported stable range. Bun
`1.4.0` is the supported development and verification runtime; OpenCode executes the externally
installed plugin in its own embedded Bun.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/YidiDev/opencode-agent-communicator/security/advisories/new>

Do not open a public issue, discussion, or pull request for an undisclosed vulnerability. Include:

- the affected plugin, OpenCode, Bun, kernel, and filesystem versions;
- the configuration involved, with secrets and personal paths removed;
- reproducible steps or a minimal proof of concept;
- the impact and whether a native or filesystem outcome may be ambiguous; and
- any evidence that sensitive content was exposed.

You should receive an acknowledgement within 7 days. The maintainer will coordinate validation,
remediation, disclosure, and credit with you. Do not access data you do not own or run tests against
systems without permission.

## Scope and known boundaries

High-impact reports include authorization bypass, cross-workspace disclosure, unsafe path traversal,
unbounded resource use, arbitrary process execution, approval bypass, or incorrect retry of an
ambiguous external effect.

The following documented constraints are not vulnerabilities by themselves:

- Only Linux x64 is supported. ARM64 code retained for possible future certification is untested and
  outside the supported release boundary. Secure export additionally depends on specific
  kernel/filesystem capabilities and fails closed when they are absent.
- The same-OS-user adversary is outside the state and export confidentiality boundary.
- Process-local export rates reset after restart.
- Deletion is logical, not guaranteed forensic erasure from SQLite, WAL, journals, backups,
  snapshots, or media.
- A reported `admission_unknown` or `native_outcome_unknown` is an intentional refusal to invent an
  outcome after an interrupted effect.
- Advisory locks are untrusted coordination metadata, not enforced exclusion or authorization.
  Overlap, missed best-effort notifications, expiry, or a session ignoring a lock is not by itself a
  security-boundary failure; `session_lock_list` is the authoritative current view.
- `session_read` returns a restricted projection, not a sanitized transcript. Included assistant text
  remains untrusted, prompt-injection-capable peer data. Self-read is limited to the current visible
  root; cross-session reads require static allow policy and repeated abort-aware visibility
  checks. The tool has immutable line, byte, cursor, native call, message, assistant-part, rendered-line,
  and post-materialization projection bounds. Its invocation-wide budget includes the final anchor reread,
  and it does not persist, log, export, or write transcript content.
- `cursor_stale` intentionally refuses continuation when a projected anchor or its bound prefix
  changed. Taking a fresh cursorless tail is the recovery path; guessing omitted content is not.

The plugin has no remote command-execution feature. Its optional export adapter consumes only the
public current-context projection and never spawns an OpenCode executable. See
[Session export security](docs/session-export-security.md) for the complete export boundary and
[Session read security](docs/session-read-security.md) for the projection, approval, cursor, and
resource boundary. The session-read implementation requires isolated supported-OpenCode live
acceptance before compatibility evidence is claimed; these docs do not claim that run has passed yet.
