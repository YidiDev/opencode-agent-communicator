# OpenCode Agent Communicator

> Durable, workspace-scoped communication between independent OpenCode agent sessions on Linux x64.

[![Linux x64 verification](https://github.com/YidiDev/opencode-agent-communicator/actions/workflows/ci.yml/badge.svg)](https://github.com/YidiDev/opencode-agent-communicator/actions/workflows/ci.yml)
[![OpenCode v2 compatibility](https://github.com/YidiDev/opencode-agent-communicator/actions/workflows/live-opencode.yml/badge.svg)](https://github.com/YidiDev/opencode-agent-communicator/actions/workflows/live-opencode.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2f6f4e.svg)](LICENSE)

**Release status:** `v1.0.0`, approved through an explicit owner exception to the 48-hour soak requirement. The soak did not pass; see [release evidence](https://github.com/YidiDev/opencode-agent-communicator/issues/46#issuecomment-6514468132). <!-- x-release-please-version -->
The v1 line supports Linux x64 and
stable OpenCode versions `>=2.1.3 <2.2.0`. Bun `1.4.0` is required for development and release verification. Other
architectures, operating systems, OpenCode versions, and prereleases are unsupported.
The published `v0.8.0` tag supports OpenCode `>=2.0.26 <2.1.0`, not 2.1.3. The older `v0.7.4`
tag targets OpenCode 1.18. Do not assume the version in an arbitrary checkout identifies its release.
The extended multi-repository soak and prolonged-runtime investigation remain outstanding in
[#46](https://github.com/YidiDev/opencode-agent-communicator/issues/46).

Created and maintained by **Yidi Sprei ([@YidiDev](https://github.com/YidiDev))**.
Copyright in original project work is held by Yidi Sprei under the [MIT License](LICENSE).
Third-party software retains its own ownership and licenses; see
[third-party notices](THIRD_PARTY_NOTICES.md) and the
[v1 compatibility contract](docs/v1-compatibility.md).

## Contents

- [Why this exists](#why-this-exists)
- [Requirements](#requirements)
- [Install](#install)
- [Configure](#configure)
- [Use the tools](#use-the-tools)
- [Common workflows](#common-workflows)
- [Durability and ambiguous outcomes](#durability-and-ambiguous-outcomes)
- [Security boundaries](#security-boundaries)
- [Operate and troubleshoot](#operate-and-troubleshoot)
- [Upgrade, migrate, or roll back](#upgrade-migrate-or-roll-back)
- [Development and release verification](#development-and-release-verification)

## Why this exists

Independent OpenCode sessions need a reliable way to exchange context, ask questions, and report
milestones without imposing a supervisor/worker hierarchy. This plugin persists deliveries, asks,
waits, starts, and their terminal state in a private SQLite store, then reconciles interrupted work
without pretending an ambiguous native effect succeeded or failed.

Every session remains a first-class peer with its own instructions, permissions, and judgment. Either
peer may initiate communication; source and target are temporary roles for one operation, not ranks.
Peer content is advisory input, never authorization. The plugin does not provide remote command
execution.

## Requirements

- Linux x64 with a local filesystem suitable for SQLite WAL
- A stable OpenCode version in `>=2.1.3 <2.2.0`
- npm for installing an exact published version
- Bun `1.4.0` for development and release verification
- A dedicated private state directory owned by the account running OpenCode

Plugin startup fails closed on an unsupported OpenCode version, operating system, or CPU architecture.
OpenCode executes plugins in its own embedded Bun runtime. The external Bun `1.4.0` pin applies to
development and release verification, not the npm production installation; it is enforced by package
metadata and release gates. Network and clustered filesystems are rejected for the state store. See
[Linux SQLite store assumptions](docs/linux-sqlite-store.md) for the filesystem list and path checks.

## Install

### 1. Install the plugin

After the RC is published, install its exact npm version outside OpenCode:

```bash
plugin_version="1.0.0" # x-release-please-version
install_root="$HOME/.local/share/opencode-agent-communicator/v$plugin_version"
install -d -m 0700 "$install_root"
npm install --prefix "$install_root" --save-exact --ignore-scripts \
  "opencode-agent-communicator@$plugin_version"
test -f "$install_root/node_modules/opencode-agent-communicator/src/index.ts"
```

RCs use the npm `next` channel; stable releases use `latest`. Pin the exact version rather than
letting a running installation float between releases. GitHub releases attach the same archive,
checksums, SBOM, and license inventory. Do not reuse an older installation directory for an upgrade.

### 2. Add the plugin

Configure the installed `src/` **directory**, not its `index.ts` file, as an absolute `file://` URL.
Replace `/home/operator` with the installation account's home and `<VERSION>` with the exact installed version.
OpenCode 2.1 rejects configured file sources before plugin setup:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///home/operator/.local/share/opencode-agent-communicator/v<VERSION>/node_modules/opencode-agent-communicator/src",
      "options": {
        "policies": {
          "message": "allow",
          "ask": "allow",
          "wait": "allow",
          "readCrossSession": "deny",
          "start": "deny",
          "stop": "deny"
        }
      }
    }
  ]
}
```

OpenCode v2 accepts the object form for a plugin source and its strict package-specific options. The
entrypoint uses the public `Plugin.define` Effect API and registers tools and skills through
`tool.transform` and `skill.transform`; it does not use a private HTTP transport. Keep the private
installation directory in place while OpenCode uses it.

### Current public-v2 capability limits

The public host API has no authoritative current activity query. `session_list` therefore reports
`unknown` activity; `status: "active"` and `status: "idle"` cannot establish matching peers.
Context delivery returns `target_status_unknown`; `session_stop` returns `native_unavailable`, both
before any effect. They remain registered for a stable tool manifest, but are unsupported on this
host API. Use explicit
`session_send` user delivery or durable queue-based ask/wait requests for supported communication.
Queue admission can wake a target and is transcript-visible; it never proves execution.
`session_read` requires current visibility and applicable static policy, not known activity;
`is_live: false` with unknown activity is not proof that the peer is idle.

Discovery scans up to ten 100-candidate registry pages to fill a filtered list. If the scan budget is
exhausted before enough matches or the end is reached, it reports `native_unavailable` rather than
silently hiding older matches. At capacity, the registry evicts its oldest discovery candidate;
requests, deliveries and managed-session provenance are retained independently.

### 3. Prepare private state

The default state root is `$XDG_STATE_HOME/opencode-agent-communicator` or
`$HOME/.local/state/opencode-agent-communicator`. To create an explicit root:

```bash
install -d -m 0700 "$HOME/.local/state/opencode-agent-communicator"
```

Set `stateDirectory` to that normalized absolute path if you do not want the default. The plugin
opens each path component without following symlinks and verifies the owner, mode, inode, device,
filesystem, and SQLite sidecars before use.

### 4. Restart and verify

Restart every OpenCode backend that should load the plugin. Configuration and plugin changes are
read at startup. Open a primary root session and confirm that the tool list contains all 21 names
from the table below. Registration is atomic: startup exposes all 21 or fails instead of leaving a
partial tool set. Visible-root checks remain authoritative: task children cannot use the root-to-root
communicator even if a host snapshot happens to expose a tool name.

If startup fails, run `opencode --version` and verify the installed entry first. OpenCode must report
a stable version in `>=2.1.3 <2.2.0`; the configured absolute directory and its `index.ts` must exist and remain readable
by the OpenCode account.

## Configure

This example shows every public option. Omit values you do not need; unknown keys are startup errors.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///home/operator/.local/share/opencode-agent-communicator/v<VERSION>/node_modules/opencode-agent-communicator/src",
      "options": {
        "stateDirectory": "/home/operator/.local/state/opencode-agent-communicator",
        "startupDeadlineMs": 30000,
        "invocationDeadlineMs": 3600000,
        "policies": {
          "message": "allow",
          "ask": "allow",
          "wait": "allow",
          "readCrossSession": "deny",
          "start": "deny",
          "stop": "deny",
          "exportSelfSanitized": "allow",
          "exportCrossSession": "deny",
          "exportOverwrite": "deny"
        },
        "start": {
          "allowedAgents": ["build"],
          "allowedModels": ["provider/model"],
          "allowManagedSessionRecursion": false,
          "limits": {
            "managedSessionsPerWorkspace": 64,
            "unresolvedProvenancePerWorkspace": 16,
            "operationsPerWorkspace": 4096,
            "payloadBytesPerWorkspace": 8388608,
            "startsPerSourceWindow": 5,
            "startsPerWorkspaceWindow": 25,
            "rateWindowMs": 60000,
            "terminalRetentionMs": 86400000
          }
        },
        "export": {
          "root": "/home/operator/private-exports",
          "limits": {
            "maximumOutputBytes": 16777216,
            "maximumConcurrent": 2,
            "maximumSourceExportsPerMinute": 4,
            "maximumWorkspaceExportsPerMinute": 16
          }
        }
      }
    }
  ]
}
```

Policy values are `allow` or `deny`. OpenCode v2 has no supported imperative approval equivalent;
legacy `ask` values are rejected during startup rather than weakened to another decision. Defaults
are:

| Policy | Default |
| --- | --- |
| `message`, `ask`, `wait` | `allow` |
| cross-session read, `start`, `stop` | `deny` |
| sanitized self-export | `allow` |
| cross-session or overwrite export | `deny` |

Unsanitized export is unsupported. Sensitive capabilities are deny-by-default; set the exact policy
to `allow` only when the deployment should grant it.

Current-context export accepts only output-size, concurrency, and per-source/workspace rate limits.
The former CLI-process fields `maximumStderrBytes`, `maximumDurationMs`, and `terminationGraceMs` are
unknown configuration and fail startup; v2 export does not spawn a CLI process.

`allowedAgents` and `allowedModels` are exact allowlists for explicit start overrides. An empty or
omitted list does not turn an arbitrary override into an allowed value. The established
`allowManagedSessionRecursion` option controls whether a session created through `session_start` may
start another session; "managed" denotes communicator-tracked provenance, not supervisory authority.

`invocationDeadlineMs` is at most one hour. Blocking asks and waits may extend their internal
invocation to place the requested timeout, a 30-second pre-persistence margin, and a 30-second
terminal-settlement margin inside one finite boundary. The v2 invocation signal is the explicit
request-cancellation signal.

For all defaults, hard ceilings, and path rules, read
[Plugin configuration](docs/plugin-configuration.md).

## Use the tools

Every result is JSON. Success has `{ "ok": true, "value": ... }`; failure has
`{ "ok": false, "error": { "code", "message", "retryable", ... } }`. Treat the failure code as
authoritative. In particular, a retryable transport failure does not prove that a native effect did
not happen.

| Tool | Arguments | Who can use it | Result or effect |
| --- | --- | --- | --- |
| `session_list` | optional `status`, `include_archived`, `limit` | visible root caller | Communicator-observed root candidates after authoritative public v2 per-ID revalidation. |
| `session_read` | `session_id`, optional `cursor`, `direction`, `limit` (default 100, maximum 500) | self, or another visible root when static policy allows | Bounded sanitized current-model-context projection with opaque snapshot cursors; not history. |
| `session_lock_list` | optional `cursor`, optional `limit` (default 50) | visible root caller | Active workspace locks as `{ locks, next_cursor? }`; each lock has `lock_id`, `held_by_session_id`, Markdown fields, and ISO 8601 UTC `created_at`, `renewed_at`, and `expires_at`. |
| `session_lock_publish` | `ttl_seconds`, `title`, `description`, `instructions` | visible root caller | Publishes a caller-held advisory lock. The compatibility notification summary does not represent native fan-out. |
| `session_lock_release` | `lock_id` | current lock holder | Removes an unexpired caller-held lock without sending native steer turns. |
| `session_lock_renew` | `lock_id`, `ttl_seconds` | current lock holder | Replaces an unexpired caller-held lock's expiry without sending native steer turns. |
| `session_send` | `session_id`, `content`, optional `delivery` (`user` or `context`) | visible source targeting a visible root | Defaults to durable transcript-visible public queue admission without a busy prerequisite. Legacy context mode remains active-only. |
| `session_delivery_get` | `delivery_id` | delivery source or target | Payload-free delivery metadata. |
| `session_ask` | `session_id`, 1-10 `questions`, `timeout_seconds` 1-3600 | visible source targeting a visible root | Durably queues the request, then blocks for validated answers or a terminal state. |
| `session_respond` | `request_id`, `answers` | pending ask target | Atomically stores the answer and terminalizes the ask. |
| `session_wait` | `session_id`, `milestone`, `timeout_seconds` 1-3600 | visible source targeting a visible root | Durably queues the request, then blocks for a milestone signal or terminal state. |
| `session_signal` | `request_id`, optional `evidence` | pending wait target | Atomically records the milestone and optional evidence. |
| `session_request_list` | optional `role`, `cursor`, `limit` | request participant | Payload-free inbox/outbox/all metadata, newest first. |
| `session_request_get` | `request_id` | request participant | Target pending payload, source retained result, or authorized metadata view. |
| `session_request_ack` | `request_id` | source of an available result | Acknowledges the result and logically erases retained result content. |
| `session_request_cancel` | `request_id` | pending request source | Durably cancels a pending request. |
| `session_request_send` | `session_id`, `content`, discriminated `request` | visible source targeting a visible root | Persists an ask/wait and admits one canonical envelope through the public queue; no busy prerequisite. |
| `session_request_start` | `idempotency_key`, `initial_message`, discriminated `request`, optional `title`, `agent`, `model` | visible root under start policy | Persists a linked ask/wait before one canonical initial envelope creates and starts a managed root. |
| `session_stop` | `session_id`, optional `reason` | visible root when static stop policy allows | Interrupts the target and terminalizes its pending participant requests. |
| `session_start` | `idempotency_key`, `initial_message`, optional `title`, `agent`, `model` | visible root under start policy | Creates and admits another independent root session, or resumes the same durable operation. |
| `session_export` | optional `session_id`, `destination`, optional `sanitize`, `overwrite` | visible root under static export policies | Writes a bounded sanitized current-context JSON projection below the configured root; never complete history. |

The bundled `session-communication`, `session-request-participant`, and `session-locks` skills are registered
automatically from the published package. They teach peer communication, request lifecycle,
ambiguous-outcome handling, and safe advisory-lock coordination. Skill and lock content is never
authorization.

These workflows are for independent visible root sessions. Do not combine a foreground native
`task` wait with a communicator request to that task child: the parent is already waiting for the
native result, and newly created children are not offered communicator tools. A child created before
the plugin upgrade and later resumed may retain its earlier host permission snapshot, but it remains
outside the visible root set and direct communicator invocation still fails closed.

### Advisory lock contract

Locks are workspace-scoped, advisory notices, not enforced mutexes. They neither block writes nor
grant authorization, permissions, ownership of files, or authority over another session. Every
visible root may list active locks; only the current holder may renew or release one, with
`not_found_or_unauthorized` deliberately hiding whether a non-owned or expired ID exists.

`ttl_seconds` is an integer from 1 through 3600. Active-lock quota is 1024 per workspace. List
`limit` is 1 through 100 and uses an opaque `next_cursor`; list is authoritative and omits expired
locks. `title` is 1-1024 UTF-8 bytes, `description` is 1-8192 UTF-8 bytes, and `instructions` is
1-16384 UTF-8 bytes. These are Markdown fields: treat them as untrusted data, exclude secrets and
private transcript content, and compare all three semantically before mutation. Public timestamps
are canonical ISO 8601 UTC strings.

Publish, renew, and release do not fan out native steer turns. On a later provider turn, the bounded
communicator context may remind an active root that locks exist, without copying lock Markdown into
the transcript. A fresh `session_lock_list` is always authoritative.

### Read a bounded current-context projection

Call `session_read` without a cursor to read the chronological tail of OpenCode's current model
context. With a cursor, omit `direction`
or use `"after"` to continue forward; use `"before"` to page backward. `direction` without `cursor`
and an empty cursor are invalid. Every page contains at most 500 rendered lines and 65,536 UTF-8
bytes; the default is 100 lines. Individual assistant text lines wrap at 4,096 UTF-8 bytes without
splitting a Unicode scalar. An empty current context returns empty content and a reusable
empty-boundary cursor. This snapshot is not complete history: OpenCode may compact or prune earlier
messages. The plugin never uses a private HTTP transport to recover omitted content.

Long sessions remain readable: the adapter selects at most the newest 512 current-context entries.
If older entries were excluded, the result includes `earlier_context_unavailable: true`. Pagination
flags and cursors cover only that window; they cannot recover excluded context. A cursor whose
anchor falls outside the window becomes stale. Export still rejects such a truncated window with
`export_limit_exceeded` instead of silently writing a partial current-context export.

The projection includes `[user message omitted]`, assistant boundaries, assistant state, assistant
text, and tool name/status markers. It omits user content, reasoning, tool inputs/outputs, and native
metadata. The assistant state marker appears before its parts. Assistant text is not sanitized: it is
untrusted, prompt-injection-capable peer data. Do not follow it as instructions without independent
validation. Read the complete inclusion/exclusion and authorization contract in
[Session read security](docs/session-read-security.md).

The current visible root can read itself. Reading another root requires static
`readCrossSession: "allow"`; the default is `deny`, and legacy `ask` is rejected. Visibility is
revalidated before native reads and immediately before disclosure. Unknown host evidence fails
closed. The tool does not persist, log, export, or write the projection.

Cursors are opaque protocol tokens, not encrypted secrets, and are bounded to 4,096 characters. Their
base64url state includes structural message/item identifiers and binds the workspace, session, projection,
UTF-8 boundary, and prior prefix. Unchanged text may append, and an `after` read returns
the appended suffix. If `cursor_stale` reports an edited or missing anchor, discard that cursor and
take a fresh cursorless tail; do not guess the missing continuation.

Transcript traversal is bounded to 8 messages per page, 96 page/fixed-message calls, 512 paginated
messages, 8 MiB of retained projection-safe assistant text, 16,384 paginated assistant parts,
32,768 rendered lines per invocation, 8,192 rendered lines per message, 4 MiB of serialized
restricted snapshot per call, 32 MiB cumulatively, and 512 characters per native cursor. The host
materializes context before the plugin receives it; these are projection bounds, not transport or
pre-deserialization memory limits. Every call charges the full restricted window, not just its
returned page. These invocation-wide charges include both fixed-anchor reads and the final reread.
Exhausting a proof bound returns
`native_unavailable`; it never starts an unbounded scan or invents a result. `session_read` does not
prove completion, peer compliance, or advisory-lock compliance. Durable ask/wait requests remain the
preferred coordination channel.

Distinct from those invocation budgets, exact structural adapter ceilings are 1,048,576 UTF-16
characters per native text part, 4,096 parts per native assistant message, and 256 UTF-16 characters
per raw native tool name. Tool names may contain Unicode and controls; the domain projection sanitizes
their bounded public marker and rejects lone surrogates.

### Ask question shape

Each question has `prompt`, `options`, and optional `multiple` and `allow_custom` flags:

```json
{
  "session_id": "ses_...",
  "questions": [
    {
      "prompt": "Which deployment target should we use?",
      "options": ["staging", "production"],
      "multiple": false,
      "allow_custom": true
    }
  ],
  "timeout_seconds": 600
}
```

The target responds with one string-array per question. Values must match the offered options unless
custom answers were allowed.

### Context delivery contract

Context delivery appends a fixed, explicitly untrusted communicator block to the latest user text
only while OpenCode assembles the target's provider request. It does not modify the stored message,
create a user turn, or appear in `session_export`. One provider transform admits at most 32 envelopes
and 64 KiB. It may also include up to 20 payload-free result reminders and an active advisory-lock
count. Immediately before injection, an exact session read must confirm that the target is a current,
unarchived root in the configured project and directory. The durable inbox and `session_lock_list`
remain authoritative. Request metadata exposes `awaiting_context_at_ms` and
`context_admitted_at_ms` when those context transitions occurred.

Packed acceptance verifies coexistence with another local message transform. This is generic hook
composition evidence, not a compatibility claim for any specific third-party context-pruning plugin.

`context_admitted` proves that the transform claimed the envelope, not that the model read, obeyed,
or answered it. If the target is idle or its status is unknown, the call persists nothing. If the
backend crashes while an envelope is awaiting injection, startup marks it failed and erases its
payload instead of risking replay.

### Preferred durable result channel

Use `session_request_send` for an existing visible peer and `session_request_start` for a new managed
root. Both persist before public queue/initial admission and return request metadata; no prior
`busy` observation is required. Recover
the result later with `session_request_list` and `session_request_get`, then call
`session_request_ack`.
Use an `ask` request for a substantive result and a `wait` request only for a milestone. Do not ask
the peer to also send an ordinary proof message or use both ask and wait for the same result.

```json
{
  "session_id": "ses_...",
  "content": "Review the release diff.",
  "request": {
    "kind": "ask",
    "questions": [{ "prompt": "What must change?", "options": [], "allow_custom": true }],
    "timeout_seconds": 600
  }
}
```

For example, create a managed root with one durable ask:

`session_request_start`

```json
{
  "idempotency_key": "release-review-2026-08-28",
  "initial_message": "Review the release diff and identify any blocking issue.",
  "title": "Release review",
  "request": {
    "kind": "ask",
    "questions": [
      {
        "prompt": "What must change before release?",
        "options": [],
        "multiple": false,
        "allow_custom": true
      }
    ],
    "timeout_seconds": 600
  }
}
```

Keep the returned `request.request_id`. Later, recover completed outbound requests without relying on
the original invocation:

`session_request_list`

```json
{
  "role": "outbox",
  "limit": 20
}
```

When that request has `"result_state": "available"`, retrieve its retained result using the exact
returned ID:

`session_request_get`

```json
{
  "request_id": "req_0123456789abcdef0123456789abcdef"
}
```

After consuming the result, acknowledge it so its retained content is logically erased:

`session_request_ack`

```json
{
  "request_id": "req_0123456789abcdef0123456789abcdef"
}
```

For an existing root, the canonical envelope is admitted as a transcript-visible public queued user
turn. It names
`session_respond` or `session_signal` and the request ID. Its work and request text remain explicitly
untrusted peer content, not authenticated credentials or authorization. The target can verify the
pending payload with `session_request_get` before responding.

`session_request_start` completes static request and start authorization over the
complete public argument digest before one fenced SQLite transaction persists the start reservation,
private canonical envelope, linked request payload, wait edge, and rate events. An allowed start
authorizes the linked initial admission. An exact
source-scoped replay returns the original operation and request, while changed work or request
arguments conflict. After restart, an approved prepared composite resumes once. A stale submitting
initial admission is instead recorded as unknown and is never replayed.

### Idempotent start

Choose an `idempotency_key` that describes the logical operation, not a random retry. Repeating the
same key and exact arguments returns or resumes the same operation. Reusing the key with different
arguments returns `idempotency_conflict`. A start that loses proof after native submission remains
`native_outcome_unknown`; the plugin reconciles its fixed session ID and never blindly creates a
second session.

### Secure export setup

Export remains registered but returns `export_unavailable` until `root` is configured and trusted.

1. Create a dedicated export root owned by the OpenCode account with mode `0700`.
2. Restart OpenCode and make a sanitized self-export to a new relative destination.
3. Enable cross-session or overwrite operations only with the corresponding static `allow` policy.

The export is a versioned sanitized current-context projection with `history_complete: false`. It
does not spawn a CLI process, and unsanitized export is unsupported.

Destinations are normalized relative paths below the configured root. Absolute paths, traversal,
symlinks, unsafe filesystems, mount transitions, and reserved staging names fail closed. Read
[Session export security](docs/session-export-security.md) before enabling this feature.

## Common workflows

### Send work without waiting

1. Call `session_list` and choose a visible root.
2. Call `session_send` without `delivery`; the default `user` mode persists before public queue
   admission and does not require a `busy` observation.
3. Inspect `session_delivery_get` for payload-free delivery state. Admission does not prove that the
   target activated, read, or followed the message.

### Coordinate shared workspace mutation

1. Before the first mutation, call `session_lock_list` and semantically compare every lock's title,
   description, and instructions with the planned work. Stop and coordinate on possible overlap.
2. Immediately before mutation, publish your own lock with enough TTL. A delegated session publishes
   its own lock; another session never proxies it.
3. Renew well before expiry. If it expired, list again and publish a new lock before resuming.
4. Release promptly after completion, abandonment, or failure. After an ambiguous mutation result,
   recover from authoritative list state instead of blindly repeating the operation.

### Ask for a decision

1. Confirm the target is a visible root with `session_list`.
2. Call `session_ask` with bounded options and a timeout.
3. The target uses `session_request_list` or `session_request_get`, then `session_respond`.
4. If the source invocation disconnects, it can recover through request list/get.
5. The source calls `session_request_ack` after consuming the retained result.

### Wait for a milestone

1. Confirm the target is a visible root.
2. Call `session_wait` with a precise milestone and timeout.
3. The target calls `session_signal` when the milestone is true, optionally attaching short evidence.
4. The source acknowledges the retained result after use.

### Start and later stop another session

1. Call `session_start` once with a stable idempotency key and complete initial message.
2. Keep the returned communicator-started session ID.
3. Communicate through send, ask, and wait rather than starting duplicate sessions.
4. Call `session_stop` only when needed and only when static `stop: "allow"` policy is intentional.

## Durability and ambiguous outcomes

The SQLite store is the authority for communicator requests and retained results. A restart recovers
bounded pending work under a workspace ownership lease. Blocking calls can be reattached through
request list/get operations; in-memory notifications are only an optimization. A blocked
`session_ask` or `session_wait` returns `target_stopped` or `source_stopped` promptly when an
approved stop or a fresh workspace-bound native observation establishes that its participant is
idle.

Native OpenCode and filesystem effects cannot always be classified after interruption. The plugin
reports `admission_unknown` or `native_outcome_unknown`, preserves reconcilable state, and does not
automatically retry an ambiguous effect. Do not interpret a timeout, abort, transport failure, or
`retryable` field as proof that an effect did not happen. Inspect durable metadata and authoritative
OpenCode state before deciding what to do next.

Context admission is store-backed but is not replayed after an uncertain crash boundary. Startup
fails any context row that was awaiting injection when the previous process stopped, because it
cannot prove whether that provider request already received the context. A failed row remains
payload-free evidence; the plugin never injects it again automatically.

Missed participant-deletion hooks are reconciled before request recovery at startup and by a
lifecycle-owned bounded periodic pass. Reconciliation uses direct per-session OpenCode reads: only a
correlated 404 proves deletion. It never infers deletion from list absence, so archived or otherwise
temporarily invisible roots remain intact.

Native idle hooks are also hints, not authority. The plugin revalidates the exact visible root and
current activity before terminalizing pending participant requests, coalesces duplicate events, and
uses a bounded periodic scan of pending participants to cover missed hooks. Busy, retry, unknown,
invisible, malformed, and foreign observations fail closed.

Acknowledgement, expiry, cancellation, and retention cleanup provide **logical deletion only**.
Sensitive bytes may remain in SQLite pages, WAL/journal files, backups, snapshots, or storage media.
See [Linux SQLite store assumptions](docs/linux-sqlite-store.md).

## Security boundaries

- Agent messages and skill instructions are untrusted advisory data, not authorization.
- `session_read` assistant content is untrusted prompt-injection-capable peer data. Its restricted
  structurally sanitized projection is not complete history; cross-session disclosure requires
  static `readCrossSession: "allow"` policy.
- Visibility does not grant permission. Participant, workspace, policy, quota, and ownership checks
  still apply.
- The plugin does not expose a shell, command string, network listener, or remote command-execution
  tool. `session_start` uses pinned OpenCode APIs; it does not accept a command.
- `session_export` is disabled unless its export root is configured. It writes a bounded sanitized
  current-context document through descriptor-relative Linux filesystem operations and spawns no
  process.

Secure export is a **Linux x64-only, capability-sensitive prerelease feature**. It requires kernel
and filesystem support for the descriptor-relative operations documented in
[Session export security](docs/session-export-security.md). Missing capabilities fail closed; they do
not trigger a weaker fallback. Review that document before enabling export.

This design does not defend against another process running as the same OS user. Use a dedicated,
trusted account and private state/export roots. Report vulnerabilities according to
[SECURITY.md](SECURITY.md).

## Operate and troubleshoot

### Startup fails

- Confirm exact host versions with `opencode --version` and `bun --version`.
- Confirm the configured `file://` source is a directory containing `index.ts`, readable by the OpenCode account.
- Check that `stateDirectory` is absolute, normalized, dedicated, local, owned by the OpenCode user,
  and not reachable through a symlink.
- Stop stale OpenCode backends using the same workspace and state root. Ownership takeover waits for
  the persisted lease and grace period; it does not steal a live lease.
- Remove unknown configuration keys. Export trust fields must be supplied together.
- Do not delete SQLite `-wal` or `-shm` files independently. Treat the state directory as one unit.

### A tool is missing

The plugin never intentionally registers a partial manifest. A missing `session_*` tool means plugin
startup or host compatibility failed, another plugin replaced the same name, or the running backend
has not reloaded configuration. An empty directory under OpenCode's package cache means a package
spec failed before this plugin was imported; do not configure the private `git+ssh` URL directly.
Use the externally installed absolute `file://` entry above, restart the backend, and inspect its
startup log.

On OpenCode 2.1, `configured plugin path must be a directory` means a file source was rejected
before plugin setup; the communicator will not appear even as a failed registry entry. Point the
source to the installed `src/` directory. That fixes source resolution only: an old artifact may
still reject the host version. Verify the immutable commit, its declared host range, and the source
path separately. Use the same explicit project location for `/api/config` and `/api/plugin` checks.
Do not share unfiltered configuration or logs, and coordinate shared-service restarts with active users.

### Ownership expires while OpenCode is running

A tool call that has not started validation may recover an expired communicator ownership lease
without restarting OpenCode. The plugin drains and discards the complete stale composition, acquires
a higher fencing epoch after one bounded wait through the persisted lease grace, runs full startup
recovery, and then executes the waiting call once. The wait is canceled by disposal and does not
retry acquisition. Disposal also aborts an in-progress successor startup and rolls its partial
resources back. Another backend taking ownership still fails closed with a sanitized contention
diagnostic. Calls that already started are aborted or settle on their original generation and are
never replayed.

Persisted lease renewal times never move backward when the wall clock regresses. Local expiry stays
monotonic, stored renewal/expiry remain nondecreasing, and fencing epochs still increase on takeover.

Recovery is deliberately one-shot and fail closed. Storage or contract faults, workflow shutdown,
host disposal, a drain timeout, takeover by another live backend, or a failed replacement remain
terminal for that plugin instance. Resolve the underlying condition and restart OpenCode; do not
blindly retry an effect whose outcome is unknown.

### A target looks idle

Default `session_send`, `session_ask`, `session_wait`, and `session_request_send` use durable public
queue admission after visibility checks and do not require a prior `busy` observation. Admission is
not activation evidence; inspect later state instead of assuming the target ran. Explicit legacy
`delivery: "context"` remains active-context-only and fails closed when activity is unknown.

### An outcome is unknown

Do not immediately retry a start, send, stop, or export after `admission_unknown` or
`native_outcome_unknown`. Use the returned IDs, request/delivery queries, direct OpenCode session
state, and the destination filesystem to reconcile first. A blind retry can duplicate the intended
native effect.

### Disk or quota pressure

Terminal delivery/request/start metadata is collected in bounded lifecycle-owned batches. Retained
request result content expires after 24 hours or acknowledgement. Start payloads and rate events have
separate configured limits. If a quota remains full, inspect unresolved operations and participant
state rather than deleting live SQLite rows by hand.

### Backups

Stop every backend using the state root before taking or restoring a file-level backup. Copy the
entire private directory, including SQLite sidecars. Application-level acknowledgement and retention
are logical deletion, not secure erasure from old pages, snapshots, or media.

## Upgrade, migrate, or roll back

### Upgrade to OpenCode v2

Stop every backend and back up the complete state directory before replacing an OpenCode 1.18
installation. Install a stable host in `>=2.1.3 <2.2.0`, update policy values to static `allow` or
`deny`, remove `export.executable`, `export.trustedWorkingDirectory`, and `exportUnsanitized`, then
restart with the v2 plugin entry. Legacy `ask` policy is rejected. Migration v17 creates the bounded
participant registry from historical communicator participant IDs without treating that history as
current visibility. Verify the exact 21-tool and three-skill manifests before resuming work. Older
plugin code must not open the migrated store.

### Upgrade to 0.7.0

Release `0.7.0` adds store-backed context admissions and a request `delivery_transport`
discriminator. Existing-root sends default to transcript-invisible `context`; use explicit
`delivery: "user"` when you need a native user turn or idle wake. Existing-root ask, wait, and
request-send also use context, while `session_request_start` retains its native initial user turn.
Stop every backend and back up the complete state directory before upgrading. Migration v16
terminalizes only legacy `steer`/`queue` requests whose native delivery remained `prepared`.
Ambiguous `submitting` and `delivery_unknown` requests retain their state and private recovery data;
none are replayed through the new transport. Older plugin code must not open the migrated store.

### Upgrade to 0.6.0

Release `0.6.0` adds bounded `session_read` transcript progress pages with opaque append-aware
cursors, exact cross-session approval, and strict native resource ceilings. It does not change the
SQLite schema. Install tag `v0.6.0` into a new private versioned directory, update the plugin entry,
restart OpenCode, and verify all 21 tools before removing the previous installation.

### Upgrade to 0.5.0

Release `0.5.0` makes blocked asks and waits reconcile promptly when either participant stops,
including authoritatively revalidated idle events and missed-event recovery. It does not change the
SQLite schema. Install tag `v0.5.0` into a new private versioned directory, update the plugin entry,
restart OpenCode, and verify all 20 tools before removing the previous installation.

### Upgrade to 0.4.1

Release `0.4.1` clarifies the nested `session_respond` answer shape for model tool use. It does not
change the SQLite schema. Install tag `v0.4.1` into a new private versioned directory, update the
plugin entry, restart OpenCode, and verify all 20 tools before removing the previous installation.

### Upgrade to 0.4.0

Release `0.4.0` adds the two immediate durable request tools and SQLite schema v15. Stop every
backend, back up the complete private state directory, install tag `v0.4.0` into a new private
versioned directory, update the plugin entry, and restart OpenCode. Existing requests migrate to
`delivery_mode: "steer"`; verify all 20 tools before resuming work.

### Upgrade to 0.3.0

Release `0.3.0` adds four advisory-lock tools, the `session-locks` skill, and SQLite schema v13.
Stop every backend, back up the complete private state directory, install tag `v0.3.0` into a new
private versioned directory, update the plugin entry, and restart OpenCode. Verify all 18 tools and
all three bundled skills. Older plugin code must not open the migrated store; restore the complete
pre-upgrade backup to roll back.

### Upgrade to 0.2.5

Release `0.2.5` reframes the plugin around durable peer communication between independent sessions.
It renames the bundled skills to `session-communication` and `session-request-participant` and
clarifies communicator-created provenance without changing the tool API, protocol, configuration,
SQLite schema, or authorization behavior. Install tag `v0.2.5` into a new private versioned
directory, update the plugin entry, restart OpenCode, and verify all 14 tools and both bundled skills.

### Upgrade to 0.2.4

Release `0.2.4` restores asynchronous `session_start` settlement and routes ordinary `session_send`
through the same public transcript used by managed sessions. Both tools return after their fixed user
message is observable, without waiting for assistant completion. SQLite schema v12 distinguishes
public-message evidence from historical V2 queue evidence without fabricating native sequence
numbers. Stop every backend, back up the complete private state directory, install tag `v0.2.4` into
a new private versioned directory, update the plugin entry, restart OpenCode, and verify all 14 tools.

### Upgrade to 0.2.3

Release `0.2.3` makes managed-root titles and initial transcripts visible through OpenCode's TUI and
`opencode export` by using the public session surface after deterministic V2 creation. It does not
change the supported host range or SQLite schema. Stop every backend, back up the complete private
state directory, install tag `v0.2.3` into a new private versioned directory, update the plugin entry,
restart OpenCode, and verify all 14 tools.

### Upgrade to 0.2.2

Release `0.2.2` restores managed-root creation through `session_start` by validating the complete
pinned SDK rejection envelope. It does not change the supported host range or SQLite schema. Stop
every backend, back up the complete private state directory, install tag `v0.2.2` into a new private
versioned directory, update the plugin entry, restart OpenCode, and verify all 14 tools.

### Upgrade to 0.2.1

Release `0.2.1` fixes direct `opencode run` startup by reusing OpenCode's injected in-process
transport for host health and V2 operations. It does not change the supported host range or SQLite
schema. Stop every backend, back up the complete private state directory, install tag `v0.2.1` into
a new private versioned directory, update the plugin entry, restart OpenCode, and verify all 14 tools.

### Upgrade to 0.2.0

Release `0.2.0` upgrades the build compiler to TypeScript 7 and runtime validation to Zod 4.4. It
does not change the supported host range or SQLite schema. Stop every backend, back up the complete
private state directory, install tag `v0.2.0` into a new private versioned directory, update the
plugin entry, restart OpenCode, and verify all 14 tools.

### Upgrade to 0.1.4

Release `0.1.4` replaces the unsupported direct private-Git cache path with an externally installed,
absolute `file://` entry. It does not change runtime behavior, the supported host range, or the SQLite
schema. Stop every backend, back up the complete private state directory, install tag `v0.1.4` into a
new private versioned directory, update the plugin entry, restart OpenCode, and verify all 14 tools.

### Upgrade to 0.1.3

Release `0.1.3` promotes the fully verified `0.1.2` runtime tree without changing behavior, the
supported host range, or the SQLite schema. All hosted quality, coverage, package, Docker security,
and OpenCode compatibility jobs passed for `0.1.2`; no GitHub-only correction was required. Follow
the `0.1.2` stop, backup, pin, restart, and manifest-verification procedure using tag `v0.1.3`.

### Upgrade to 0.1.2

Release `0.1.2` preserves the `>=1.18.21 <1.19.0` host range and SQLite schema while splitting
large runtime modules along existing security, persistence, and lifecycle boundaries. A negative
live backtest against `1.18.20` confirms that `1.18.21` remains the natural compatibility floor.
To upgrade, stop every backend, back up the complete private state directory, pin `v0.1.2`, and
restart OpenCode. Verify plugin startup and the exact 14-tool manifest.

### Upgrade to 0.1.1

Release `0.1.1` broadens the certified host range from exact OpenCode `1.18.21` to stable versions
`>=1.18.21 <1.19.0`. It does not change the SQLite schema. Before replacing `0.1.0` or a development
build:

1. Stop every OpenCode backend that uses the state directory.
2. Back up the entire private state directory, including SQLite sidecars, while no backend is running.
3. Pin the plugin to GitHub release tag `v0.1.1` and use a supported OpenCode patch.
4. Restart OpenCode and verify plugin startup and the 14-tool manifest.

Startup applies forward SQLite migrations atomically. Production never runs migration `downSql`.

### Roll back

1. Stop every OpenCode backend using the store.
2. Restore the complete pre-upgrade state-directory backup.
3. Restore the previous plugin reference and its matching OpenCode version, or remove the plugin
   entry to disable it.
4. Clear only the affected OpenCode package cache if OpenCode retained the unwanted package, then
   restart OpenCode.

Do not open a store migrated by a newer release with older plugin code. Removing the plugin does not
erase its state or exports; delete them only under your retention and backup policy.

## Development and release verification

Install exact dependencies and run the ordinary quality gate:

```bash
bun install --frozen-lockfile
bun run check
```

Run the remaining release evidence separately:

```bash
bun run test:coverage:branches
bun run test:coverage
bun run test:live
bun run test:acceptance:linux-store
bun run test:acceptance:secure-export
bun run test:acceptance:package-portability
bun run verify:package
```

The Docker acceptance commands require Docker. Store acceptance covers glibc/musl, OverlayFS,
tmpfs, read-only behavior, adversarial path objects, process interruption, and ENOSPC. Secure export
acceptance must complete all capability tests with zero skips on both glibc and musl.

### Package verification

The package entry is the TypeScript source module `src/index.ts`. Supported OpenCode v2 hosts load
the externally installed absolute `file://` source directory and execute its public `Plugin.define` Effect. The
archive includes only runtime source, bundled skills, operational documentation, and release/legal
files.

```bash
bun run verify:package
npm pack --dry-run
bun run test:black-box
```

`prepack` verifies the entry, Linux x64 package scope, host range, exact build-time dependencies,
exact ordered 21-tool manifest, all three bundled skills, and a reviewed
fingerprint of every path npm will pack. It rejects path-policy drift, symlinks, executable entries,
secret-like names, and generated/test output. The black-box test creates an archive without
publishing it, installs it into an isolated Bun project, imports the package by name, and checks
packaged runtime assets. Public v1 tags and release assets are immutable. Tag pushes trigger the
trusted-publication workflow; manual dispatch on the exact tag is a recovery path with the same
checks. GitHub and npm receive the same verified archive, with npm provenance. See the
[release operations guide](docs/releases.md) for trusted-publisher identity, bot permissions,
partial-failure recovery, and stable-readiness gates.

Live compatibility tests launch isolated OpenCode v2 hosts for the minimum supported patch and
the exact build-time patch:

```bash
bun run test:live
```

The live suite checks conservative unsupported observations and separately packs the archive,
extracts it into an isolated harness, wires its declared runtime dependencies from a reviewed local
snapshot, and loads the actual installed `src/` directory by absolute `file://` URL through the public Effect plugin
contract. It verifies the exact 21 primary tools and three skills, a correlated `session_list` result,
lock publication/list/renewal/release, self-read, queue delivery/recovery, and a durable peer ask with
target payload retrieval, response, source retrieval and acknowledgement. It also verifies the
explicit unsupported context/stop outcomes, deny-default start and configured export-unavailable
result. Additional live checks cover rejected file sources, authorized idempotent start, allowed and
denied cross-session reads, and durable wait/signal/ack. Positive packed-host export evidence runs in
the capability-required secure-export Docker cell; a host without that capability must instead
return `unsafe_path` without installing a file. The minimum and build-time patches currently coincide
at `2.1.3`, so one host exercises both
endpoints.
The Effect-plugin unit suite verifies the exact 21-tool and three-skill manifests, static policy,
and scoped disposal. Integration suites cover lock, delivery, durable request, start/stop, export,
visibility races and projection limits. These are separate from live journey evidence; the live
suite does not yet prove a complete multi-session lifecycle or the extended soak required by #46.
Actual consumer installation evidence comes from the black-box
packed-package test and the package-portability acceptance suite.

### Tokenless free-model evaluation

The deterministic live suite is the required compatibility gate. A separate scheduled/manual
workflow packs and installs the exact checkout into a clean consumer, then runs real OpenCode with a
currently available reviewed Zen free model:

```bash
bun run test:model-eval
```

The evaluator runs installation smoke, managed-session, advisory-lock, and durable multi-session
request journeys. It requires all three bundled skills to be loaded, verifies ordered and correlated
tool calls, and rejects workspace mutation or stop/export calls. It uses no API key and submits only
synthetic evaluation content. Because free models are temporary and rate-limited, this workflow is
weekly/manual evidence rather than a pull-request or release gate. Provider unavailability,
rate-limiting, model removal, harness failures, and behavioral failures receive distinct
classifications. Sanitized JSONL logs and a machine-readable score report are retained as workflow
artifacts; private OpenCode state and communicator databases are never uploaded.

See [`test/model-eval/README.md`](test/model-eval/README.md) for model selection and local execution
details.

See the
[development conventions](https://github.com/YidiDev/opencode-agent-communicator/blob/main/DEVELOPMENT.md)
in the source repository.

## License

[MIT](LICENSE) © 2026 YidiDev
