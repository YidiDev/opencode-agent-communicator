# OpenCode Session Communicator Plan

## 1. Executive Summary

OpenCode Session Communicator will be a workspace-scoped OpenCode plugin for
communication and coordination between first-class OpenCode sessions. It is for
users running several sessions concurrently against the same workspace and
OpenCode backend.

The first published prerelease target is exactly `0.1.0` and will expose the complete
revised surface:

- `session_list`
- `session_send`
- `session_delivery_get`
- `session_ask`
- `session_respond`
- `session_wait`
- `session_signal`
- `session_request_list`
- `session_request_get`
- `session_request_ack`
- `session_request_cancel`
- `session_stop`
- `session_start`
- `session_export`

`session_send` is message-only. Remote command execution is not part of the
communicator.

Every operation derives its verified source session ID from
`ToolContext.sessionID`; models cannot supply or override sender identity.
OpenCode owns prompt execution and transcript storage. The communicator stores delivery metadata, durable blocking requests,
retained results, start operations, authorization metadata, quotas, and store
ownership in SQLite. It does not duplicate the native prompt queue.

Only a normal asynchronous `session_send` message may wake an existing idle session.
Structured questions and milestone waits require a target observed as active
and use native steer admission. They never poll, retry, fall back to a queue, or
create synthetic wake reminders.

`session_ask` and `session_wait` block while their tool invocation survives,
but the underlying request is durable. A source can recover a terminal result
after backend or invocation loss through the request tools. The protocol
promises one atomic terminal transition and durable result retrieval, not
exactly-once delivery to a model invocation or exactly-once native side effects.

Implementation proceeds in internal vertical slices, but no partial public
tool surface will be published. Prerelease schemas remain explicitly unstable
through dogfooding and live acceptance. Compatibility commitments begin at the
stable schema-freeze gate.

## 2. Fixed Baseline and Feasibility Gate

Version one targets exactly:

```text
OpenCode 1.18.21
@opencode-ai/plugin 1.18.21
@opencode-ai/sdk 1.18.21
```

All versions are pinned exactly. Supporting another OpenCode release requires
a tested communicator release that changes the pin.

At plugin startup, `client.global.health()` must prove the host is exactly
1.18.21. A missing, malformed, or mismatched version fails closed and disables
all communicator tools with a compatibility diagnostic.

Export has a separate CLI dependency. Each export invocation resolves a
canonical absolute OpenCode executable, verifies that executable is exactly
1.18.21, and invokes that same path. A CLI failure disables only export and
returns `export_unavailable`; it does not disable communication tools.

The development machine currently has OpenCode 1.17.20. Phase 0 therefore uses
an isolated, project-pinned 1.18.21 harness and must not replace or mutate the
active user CLI installation.

The following are hypotheses until Phase 0 proves them against the pinned
source and a live host:

- `ToolContext` reliably exposes `sessionID`, `abort`, and operation-specific
  approval through `ask`.
- V2 prompt admission accepts caller-supplied message IDs and
  `delivery: "queue" | "steer"`.
- Admissions are durable and expose enough API/event evidence to distinguish
  admitted, promoted, failed, and ambiguous outcomes.
- Queue admission wakes an idle root session and preserves FIFO ordering.
- Steer admission is appropriate only for sessions observed as `busy` or
  `retry`, including the exact result when status races to idle.
- Interruption stops active execution without retracting admitted inputs.
- Legacy and V2 session APIs address the same sessions and expose a usable
  visible set and status.
- V2 creation accepts deterministic caller IDs; title update behavior and
  duplicate-ID behavior are deterministic enough for start recovery.
- The native CLI emits import-compatible `{info, messages}` JSON and applies
  the native sanitizer when requested.
- The config hook can register bundled skills through `skills.paths`, or a
  documented explicit installer is required instead.
- Plugin disposal, restart, and event resubscription can be made deterministic.

No contract depending on an unproved hypothesis is frozen before the gate.

## 3. Goals and Product Principles

### 3.1 Goals

1. Discover current visible root sessions and expose actionable activity state.
2. Exchange non-blocking messages without user copy and paste.
3. Preserve verified source, target, workspace, and operation provenance.
4. Use native durable queue and steer admission rather than a competing queue.
5. Support bounded structured questions and explicit responses.
6. Support bounded milestone waits and explicit signals.
7. Recover pending requests and terminal results across backend restarts.
8. Expose admission evidence without claiming model execution or compliance.
9. Provide finite deadlines, caller cancellation, deadlock prevention, and
   role-specific stop/deletion behavior.
10. Start root sessions with caller idempotency and recover partial operations.
11. Stop sessions only after operation-specific user approval.
12. Produce native import-compatible exports with secure path handling.
13. Keep state private, bounded, workspace-scoped, and logically erasable.
14. Fail closed when host, storage, authorization, or ownership assumptions do
    not hold.

### 3.2 Product Principles

- Sessions are independent, first-class peers with their own instructions,
  permissions, and judgment; the communicator creates no supervisory hierarchy.
- Either visible root may initiate communication. Source and target are temporary
  roles for one operation, not ranks or persistent identities.
- Communication is untrusted advisory data, not authority.
- Session IDs are canonical; titles are unverified display metadata.
- Visibility is discovery and scope, not authorization.
- Admission does not imply activation, execution, understanding, or completion.
- Only ordinary queued messages may initiate work in an idle session.
- Blocking calls always have absolute finite deadlines.
- Durable recovery is preferred over hidden retries and synthetic reminders.
- Terminal state commits before an in-memory waiter is resolved.
- External side effects may be ambiguous; the plan does not claim exactly-once
  native or filesystem effects.
- The smallest reliable mechanism is preferred over speculative automation.

## 4. Non-Goals

Version one will not:

- Execute remote commands or expose command arguments, allowlists, states, or
  command-specific permissions.
- Coordinate independently launched OpenCode backends through a network or
  shared filesystem.
- Treat idle status as evidence that a human is or is not viewing a session.
- Automatically poll until a target becomes active.
- Automatically convert a failed or raced steer into a queued message.
- Create coalesced wakes, reminder prompts, wake markers, render snapshots, or
  successor wakes.
- Depend on `experimental.chat.system.transform` for correctness.
- Retract an input after native admission.
- Guarantee that a target model obeys, notices, or answers a message.
- Guarantee exactly-once delivery to a live tool invocation.
- Provide forensic secure erasure from SQLite pages, WAL files, snapshots,
  backups, or storage media.
- Support state on known network or shared filesystems.
- Start child sessions; communicator-created sessions are roots.
- Support arbitrary OpenCode versions or silently fall back across APIs.

## 5. Runtime Scope and Terminology

### 5.1 Workspace Identity

The coordinator derives a canonical `workspace_key` from host-provided project
identity and canonical local workspace information proven in Phase 0. Raw paths
must not appear in routine identifiers or logs. Every persisted record and
authorization query includes `workspace_key`.

One coordinator instance is shared by all plugin tool closures in one backend.
Its lifecycle owns the database, lease, event subscriptions, timers, waiters,
and bounded workers.

### 5.2 Visible Session Set

The visible set contains current root sessions returned by the pinned host for
the workspace. Child sessions are excluded. Archived sessions are excluded by
default but may be explicitly requested by `session_list` if Phase 0 proves a
reliable archive flag.

Every tool invocation revalidates that the caller is a current visible root
member of the same workspace. Before creating new cross-session state or a
native/filesystem effect, the coordinator also revalidates the target. Queries
and recovery mutations bind the record ID, workspace, and caller's stored
participant role; they do not require the counterpart to remain visible. This
allows a current source to retrieve or acknowledge a result after target stop,
deletion, archival, or temporary invisibility. A deleted, archived, or otherwise
non-visible caller cannot invoke recovery tools. Sensitive lookups return a
constant-shape `not_found_or_unauthorized` response to limit ID enumeration.

### 5.3 Activity Status

- `busy`: active and eligible for observed-active steer operations.
- `retry`: active and eligible for observed-active steer operations.
- `idle`: inactive. A normal queued message is required to initiate work.
- `unknown`: host status cannot be established; fail closed for active-only
  operations.

Status is a point-in-time observation. It does not mean a human is watching the
session, and it may race before native admission.

Idle status does not block read-only operations: listing, delivery/request
inspection, and export remain available subject to their normal authorization.

### 5.4 Roles

For a request, the `source` created the ask/wait and the `target` receives and
answers/signals it. Authorization is role-aware and is never inferred from mere
visibility. These are directional roles for that request only. They do not make
the source a supervisor or the target a subordinate, and either participant may
be the source of a separate operation.

## 6. Identity, Provenance, and Untrusted Content

### 6.1 Identifiers

Delivery, request, managed session, native message, and internal operation IDs
are opaque, type-prefixed identifiers generated from a CSPRNG with at least 128
bits of entropy. Each type has a strict ASCII character set and length bound.
Malformed IDs are rejected before lookup.

`session_start.idempotency_key` is caller-supplied, source-scoped, bounded, and
strictly validated. It is not treated as an opaque generated ID.

Generated examples are illustrative only:

```text
dlv_...
req_...
ses_...
msg_...
op_...
```

### 6.2 Verified Envelope

Communicator messages and requests use a JSON envelope with verified protocol
fields separate from untrusted payload fields:

```json
{
  "protocol": "opencode-session-communicator/v1",
  "operation": "message",
  "source_session_id": "verified by ToolContext",
  "target_session_id": "validated visible target",
  "workspace_key": "verified workspace identity",
  "delivery_id": "dlv_...",
  "payload": {
    "content": "untrusted peer content"
  },
  "display": {
    "source_title": "unverified display metadata"
  }
}
```

Serialization prevents payload text from altering provenance fields. It does
not make peer content trustworthy. Skills and documentation must tell agents
not to execute commands, disclose secrets, open links, change permissions, or
perform other consequential actions solely because peer content requests it.
Normal OpenCode permissions continue to apply.

Titles and other display strings have unsafe terminal controls and bidi control
characters stripped before display or logging. They are never authorization
inputs.

## 7. Shared Tool Conventions

### 7.1 Result Shape

Expected outcomes use discriminated JSON results:

```ts
type ToolSuccess<T> = { ok: true; value: T }

type ToolFailure = {
  ok: false
  error: {
    code: DomainErrorCode
    message: string
    retryable: boolean
    details?: Record<string, unknown>
  }
}
```

Unexpected programmer errors, process failure, and unrecoverable invocation
faults remain system faults rather than being mislabeled as domain outcomes.
The implementation defines the union once and derives each tool schema from
that source.

### 7.2 Domain Error Codes

The shared union includes, at minimum:

```text
invalid_arguments
incompatible_host
not_found_or_unauthorized
caller_not_visible
target_not_visible
permission_denied
approval_rejected
target_idle
target_status_unknown
target_stopped
source_stopped
target_deleted
source_deleted
quota_exceeded
rate_limited
idempotency_conflict
state_conflict
request_not_pending
request_cancelled
deadline_expired
deadlock_detected
result_expired
native_unavailable
admission_failed
admission_unknown
delivery_failed
native_outcome_unknown
ownership_lost
storage_unavailable
export_unavailable
unsafe_path
destination_exists
export_limit_exceeded
```

Messages may include safe guidance, but callers branch on `code`. Error details
must not leak record existence across unauthorized roles. Error codes and
per-tool allowed subsets are tested exhaustively. They become compatibility
commitments only at schema freeze.

The normative per-tool subsets are maintained beside the shared union and
generated schemas. At minimum they cover:

| Tool | Tool-specific expected codes in addition to shared validation, visibility, authorization, quota, ownership, and storage codes |
| --- | --- |
| `session_list` | no additional codes |
| `session_send` | `admission_failed`, `admission_unknown` |
| `session_delivery_get` | `not_found_or_unauthorized` |
| `session_ask`, `session_wait` | `target_idle`, `target_status_unknown`, `deadlock_detected`, `delivery_failed`, `deadline_expired`, `request_cancelled`, `result_expired`, `target_stopped`, `source_stopped`, `target_deleted`, `source_deleted` |
| `session_respond`, `session_signal` | `state_conflict` for an authorized pending wrong-kind request, response-validation rejection, or provisional persistence conflict without an authoritative winner; `request_not_pending`, `request_cancelled`, `delivery_failed`, `deadline_expired`, `target_stopped`, `source_stopped`, `target_deleted`, `source_deleted` |
| `session_request_list` | no additional codes |
| `session_request_get` | `result_expired` |
| `session_request_ack` | `state_conflict` |
| `session_request_cancel` | provisional `state_conflict` for a persistence conflict without an authoritative winner; `request_not_pending`, `delivery_failed`, `deadline_expired`, `target_stopped`, `source_stopped`, `target_deleted`, `source_deleted`; repeated `cancelled` is success |
| `session_stop` | `approval_rejected`, `native_unavailable`, `native_outcome_unknown` |
| `session_start` | `approval_rejected`, `idempotency_conflict`, `admission_failed`, `admission_unknown`, `native_outcome_unknown`, `native_unavailable`, `start_payload_unavailable`, `unresolved_provenance_quota_exceeded` |
| `session_export` | `approval_rejected`, `export_unavailable`, `unsafe_path`, `destination_exists`, `export_limit_exceeded`, `native_outcome_unknown` |

Before schema freeze, implementation and tests must refine this provisional table into an
exhaustive generated mapping; tools may not return undeclared domain codes. Contract-violating or
malformed persistence adapter results fail closed as `storage_unavailable`, rather than expanding
the tool-specific state-conflict surface.

`session_ask` and `session_wait` can return `result_expired` when the blocking process was
suspended or disconnected for longer than the 24-hour retained-result window and later resumes.
That authoritative lifecycle outcome is not storage corruption.

### 7.3 Authorization and Approval

Administrator policy supports `allow`, `ask`, or `deny` per operation, subject
to hard secure defaults:

| Operation | Default | Non-bypassable rule |
| --- | --- | --- |
| list/inspect own role records | allow | Workspace and role checks |
| send message | allow | Quotas and source/target checks |
| ask/wait/respond/signal | allow | Quotas, role, and active-target rules |
| request ack/cancel | allow | Source role only |
| start | ask | Explicit overrides require allowlisting |
| stop | ask | Approval cannot be configured away |
| sanitized self-export | allow | Secure destination and native sanitizer |
| cross-session export | ask | Exact source, target, destination, and mode binding |
| unsanitized export | ask | Exact source, target, destination, and mode binding |
| overwrite existing export | ask | Exact destination and overwrite mode binding |

An approval resource binds workspace, source, target, operation, and all
relevant exact values or cryptographic digests, including export destination
and sanitization mode. A broad approval must not silently authorize a different
target or changed parameters.

## 8. Tool Contracts

All sizes and limits below are provisional until Phase 0 and stress testing.

### 8.1 `session_list`

```ts
type SessionListArgs = {
  status?: "active" | "idle" | "all"
  include_archived?: boolean
  limit?: number
}
```

The default is the 50 newest non-archived visible root sessions. Status is
evaluated and filtered before `limit` is applied. Each item includes canonical
session ID, sanitized unverified title, `busy | retry | idle | unknown`, active
boolean, updated time, and communicator-managed provenance when applicable.

The result includes enough current state for this explicit workflow:

1. Submit a normal message with `session_send` to wake/resume an idle session.
2. Inspect `session_list` until the target is observed `busy` or `retry`.
3. Invoke `session_ask` or `session_wait`.

Listing never claims a human is viewing a session.

### 8.2 `session_send`

```ts
type SessionSendArgs = {
  session_id: string
  content: string
}
```

The coordinator validates source, target, authorization, size, and quotas;
creates a delivery record and caller-supplied native message ID; then submits
the escaped message envelope once through the public asynchronous prompt surface and reconciles it
through fixed-message read-back.

The result reports admission evidence only. It never reports that an idle
target became active. The caller uses `session_list` for a later status
observation. After confirmed native admission, the communicator does not retain
a duplicate normal-message payload.

`session_send` is the only communicator operation that may initiate work in an
existing idle session.

### 8.3 `session_delivery_get`

```ts
type SessionDeliveryGetArgs = {
  delivery_id: string
}
```

Only the source or target participant may inspect a delivery in the same
workspace. The result contains payload-free metadata, native correlation
evidence, timestamps, and one of:

```text
prepared
submitting
admission_unknown
admitted
promoted
failed
cancelled
```

`cancelled` means only that the caller aborted before native admission began or
before admission could possibly succeed. It never means retraction. There is no
delivery cancellation tool, and admitted inputs are non-retractable.

An abort while the record is still `prepared` may produce `cancelled`. Once
`submitting` is committed, abort cannot prove non-admission; the coordinator
records the authoritative result or `admission_unknown` instead of `cancelled`.

`started` is added only if Phase 0 proves exact, reliable execution evidence.
Otherwise it is omitted from version one rather than inferred from promotion,
status, transcript content, or timing.

`prepared` is committed before an admission worker claims the operation; no
native call can have started in this state. `submitting` is committed immediately
before the native call and is treated as ambiguous after process or ownership
loss. Allowed transitions are monotonic:

```text
prepared -> submitting -> admitted -> promoted [-> started, only if proven]
prepared -> cancelled
submitting -> admission_unknown
submitting -> failed
admission_unknown -> admitted | promoted | failed
```

A native promoted result may be persisted directly from `submitting` to
`promoted` in one atomic database mutation. That mutation records both admitted
and promoted sequence evidence and timestamps; it does not expose a separately
committed intermediate `admitted` state.

Ambiguous records are reconciled only from authoritative native evidence and
are never automatically resubmitted.

On restart, a `prepared` operation may perform its first submission because the
committed state proves no prior call began. A recovered `submitting` operation
becomes `admission_unknown` and is never retried. The normal-message payload is
retained only while `prepared`; it is logically erased after the worker commits
`submitting`, leaving the fixed native message ID and payload digest for
correlation.

### 8.4 `session_ask`

```ts
type AskQuestion = {
  prompt: string
  options: string[]
  multiple?: boolean
  allow_custom?: boolean
}

type SessionAskArgs = {
  session_id: string
  questions: AskQuestion[]
  timeout_seconds: number
}
```

The target must be observed `busy` or `retry`. If idle, no request is persisted
and `target_idle` tells the caller to queue a wake message and inspect status.
If status is unknown, the operation fails closed.

After the active check, the coordinator persists the durable request and
absolute deadline before V2 steer admission. A target may race to idle between
the check and admission. The exact native result is reported or recorded; the
coordinator never polls, retries, or converts the request into a queued wake.

On confirmed admission failure, the request transitions terminal and content
is logically erased. On admission ambiguity, it remains pending with
`delivery_unknown`, is not resubmitted, remains answerable through the inbox,
and expires at its original deadline.

While the invocation survives, the tool blocks until an atomic terminal
transition. If the invocation disappears without an explicit abort, the durable
request continues. If the backend restarts, the request and timer are recovered.

Answers are represented as one array per question. Entries are exact option
labels or arbitrary custom text when allowed. Input order is preserved. A
single-choice question accepts zero or one value; a multiple-choice question
accepts zero or more values. Empty arrays mean unanswered. Unknown option labels
are rejected unless custom text is allowed.

Provisional bounds are 32 KiB total request payload, 10 questions, 20 options
per question, bounded string sizes, and `1..3600` seconds.

### 8.5 `session_respond`

```ts
type SessionRespondArgs = {
  request_id: string
  answers: string[][]
}
```

Only the request target may respond to a pending ask. Validation enforces the
question count, option/custom rules, and cardinality. A single compare-and-set
transaction records `answered`, retains the answer for source retrieval, clears
the pending request payload, and commits before any in-memory waiter resolves.
Late or duplicate responses return the mapped stored terminal outcome defined in
Section 9.1 without changing state.

### 8.6 `session_wait`

```ts
type SessionWaitArgs = {
  session_id: string
  milestone: string
  timeout_seconds: number
}
```

`session_wait` follows the same observed-active, persist-before-steer, status
race, ambiguity, blocking, restart, deadline, and explicit-abort rules as
`session_ask`. It never wakes an idle target.

### 8.7 `session_signal`

```ts
type SessionSignalArgs = {
  request_id: string
  evidence?: string
}
```

Only the target may signal a pending wait. A compare-and-set transaction records
`reached`, retains bounded evidence for source retrieval, clears the pending
milestone payload, and commits before resolving a waiter. Late or duplicate
signals return the mapped stored terminal outcome defined in Section 9.1.

### 8.8 `session_request_list`

```ts
type SessionRequestListArgs = {
  role?: "inbox" | "outbox" | "all"
  cursor?: string
  limit?: number
}
```

The result is metadata-only and role-aware:

- Inbox: pending requests for which the caller is the target.
- Outbox: pending requests created by the caller plus retained terminal metadata
  that the source has not acknowledged where acknowledgement applies, including
  records whose answer/evidence result has expired.
- All: both role views without relaxing either authorization check.

Items include request ID, kind, participant IDs, state, delivery state,
timestamps, deadline, acknowledgement applicability/state, and result
availability. `deadline_expired` is a request terminal state; `result_expired`
means an answered/reached result exceeded its retrieval window. Questions,
milestone text, answers, and evidence are never returned by list. Pagination
and a hard maximum limit are mandatory.

### 8.9 `session_request_get`

```ts
type SessionRequestGetArgs = {
  request_id: string
}
```

The target may retrieve the payload of a pending inbound request. The source may
retrieve a retained terminal answer or milestone result from its outbound
request. Pending sources receive metadata, not a duplicate target payload.

Resolved result content remains available until source acknowledgement or 24
hours after terminal resolution, whichever comes first. After that window,
metadata remains but source retrieval returns `result_expired` and no content.
Unauthorized roles receive constant-shape `not_found_or_unauthorized`.

### 8.10 `session_request_ack`

```ts
type SessionRequestAckArgs = {
  request_id: string
}
```

Only the source may acknowledge an answered/reached request. Acknowledgement is
idempotent. The first acknowledgement immediately and logically erases retained
answer/evidence content and records `acknowledged_at`; payload-free metadata is
retained. An acknowledgement after automatic result expiry is also idempotent,
marks the metadata acknowledged, and does not restore content.

### 8.11 `session_request_cancel`

```ts
type SessionRequestCancelArgs = {
  request_id: string
}
```

Only the source may cancel one pending durable request. Cancellation is
idempotent. The atomic terminal transition logically erases request and result
content, clears local waiter/timer state after commit, and causes all late
responses or signals to return the mapped stored terminal outcome. It cannot retract
the already admitted native input.

### 8.12 `session_stop`

```ts
type SessionStopArgs = {
  session_id: string
  reason?: string
}
```

Stop always requires operation-specific user approval; configuration cannot
bypass it. Approval binds source, target, and the exact reason digest.

If the approved target is already idle, the result is `already_idle`; no native
interrupt occurs. Applicable communicator requests are still terminated.

Stopping a session transitions pending requests by role:

- Requests targeting the stopped session become `target_stopped`.
- Requests sourced by the stopped session become `source_stopped`.

Each transition is atomic, logically erases payload/result content, and rejects
late actions with the stored reason. Here `source_stopped`/`target_stopped` mean
the approved communicator stop was applied to coordination state; they do not
assert that a native interrupt occurred. This is why an already-idle stop still
terminates requests with those reasons.

For an active target, ownership and visibility are rechecked immediately before
native interruption. The stop result reports communicator-state application and
native interruption outcome separately. Native timeout, transport failure, or
ownership loss returns `native_outcome_unknown`; the communicator does not claim
interruption succeeded and does not reverse committed request terminal states.

### 8.13 `session_start`

```ts
type SessionStartArgs = {
  idempotency_key: string
  initial_message: string
  title?: string
  agent?: string
  model?: string
}
```

Start creates only root sessions and requires operation-specific approval by
default. With no configured allowlist, callers must omit `agent` and `model` so
host defaults are used. Explicit overrides must exactly match administrator
allowlists. A communicator-created session is an independent peer, not a
subordinate of its source. Source and workspace start rates, communicator-started
session counts, retained operation records, and private start-payload bytes are bounded.

The coordinator persists a source-scoped start operation before external work.
It fixes the generated session ID, initial native message ID, arguments digest,
and independent sub-operation states:

```text
creation: prepared | submitting | created | failed | policy_denied | approval_rejected | outcome_unknown
title: not_started | prepared | submitting | updated | failed | outcome_unknown | payload_unavailable | skipped
admission: not_started | prepared | submitting | admitted | admission_unknown | payload_unavailable | failed
```

For each external step, `prepared` proves the call has not begun and may be
claimed for its first attempt after restart; a recovered `submitting` step is
unknown until reconciled from authoritative native state and is not blindly
retried. Creation must resolve to `created` before later steps. A failed or
unknown title update does not block initial-message admission because title is
unverified convenience metadata; both outcomes remain exposed. Admission uses
the fixed native message ID and follows the delivery ambiguity rule.

Repeating the same source, idempotency key, and arguments returns or resumes the
same operation with the same IDs. Reusing the key with different arguments
returns `idempotency_conflict`. Recovery must never adopt an unrelated existing
session solely because an ID collides.

Startup and same-key retries reconcile ambiguous creation by bounded authoritative reads of the fixed
session ID; they never retry create. The pinned adapter distinguishes an exact root match (directory
plus requested agent/model), collision, and unknown. A direct 404 after submission is unknown because
the pinned API supplies no bounded proof that an accepted create cannot still commit; absence may be
returned only by a native port with such a proof. Bounded non-message creation
identity survives private payload erasure. A match confirms provenance and resumes title/admission
only when their payload is still available; otherwise `start_payload_unavailable` reports the exact
partial state. Proven absence and collision terminalize failure and release the reservation without
adoption. Remaining unknown provenance has a separate configurable quota and immutable hard ceiling,
does not consume ordinary managed-session quota, and reports
`unresolved_provenance_quota_exceeded` when operator action is required.

Policy denial and invocation-approval rejection atomically erase the private
start payload, release the reserved managed-session identity, and commit the
corresponding terminal creation state. Same-key retries therefore reproduce the
same denial without requesting approval again while that terminal metadata is
retained. Startup and recurring fenced maintenance delete aged unreserved
terminal metadata and expired start-rate events in bounded batches; after the
configured retention window, a collected key is a new operation.

The result exposes the durable operation and partial state rather than hiding
title or admission failures. No ambiguous external step is automatically
repeated unless Phase 0 proves a native idempotency guarantee for the fixed ID.

Creation provenance is recorded. Communicator-created sessions cannot call
`session_start` recursively by default; only an explicit administrator opt-in
may permit it, still subject to approval and quotas.

### 8.14 `session_export`

```ts
type SessionExportArgs = {
  session_id?: string
  destination: string
  sanitize?: boolean
  overwrite?: boolean
}
```

`session_id` defaults to the caller and `sanitize` defaults to `true`.
Sanitized self-export is allowed by default. Cross-session export and every
unsanitized export default to operation-specific approval. An administrator may
explicitly configure `allow`, `ask`, or `deny`, but the shipped secure defaults
remain `ask` and a broad unrelated approval never applies.

`overwrite: true` independently defaults to operation-specific approval even
for sanitized self-export. Its approval is bound to the exact destination. The
default self-export permission never authorizes destruction of an existing file.

Export uses only the native OpenCode sanitizer. There is no custom or fallback
sanitizer. It returns summary metadata only: exported session ID, contained
destination, sanitization mode, byte count, and a content digest. It never
returns transcript content through the tool result.

The complete filesystem and process contract is in Section 13.

## 9. Request Lifecycle and Recovery

### 9.1 States

Requests have a durable kind (`ask` or `wait`), delivery state, and resolution
state. Resolution begins `pending` and has exactly one terminal transition:

```text
answered
reached
deadline_expired
cancelled
delivery_failed
target_stopped
source_stopped
target_deleted
source_deleted
```

Only `answered` applies to asks and only `reached` applies to waits. The stored
terminal reason is authoritative for all late actions.

Terminal state maps to tool results consistently:

| Stored state | Source blocking result | Late respond/signal/cancel result |
| --- | --- | --- |
| `answered` | ask success with answers | `request_not_pending` with `terminal_state: "answered"` |
| `reached` | wait success with evidence | `request_not_pending` with `terminal_state: "reached"` |
| `cancelled` | `request_cancelled` | repeated cancel succeeds; other actions return `request_cancelled` |
| `deadline_expired` | `deadline_expired` | `deadline_expired` |
| `delivery_failed` | `delivery_failed` | `delivery_failed` |
| `target_stopped` | `target_stopped` | `target_stopped` |
| `source_stopped` | `source_stopped` | `source_stopped` |
| `target_deleted` | `target_deleted` | `target_deleted` |
| `source_deleted` | `source_deleted` if the invocation survives the deletion race | `source_deleted` |

`answered` and `reached` are successful states, not domain error codes. An
admission ambiguity remains pending as `delivery_unknown`; ask/wait do not
return it as `admission_unknown`. If the live blocking invocation survives, it
continues waiting for an ordinary terminal result.

### 9.2 Delivery States

Requests use this delivery state machine independently from their resolution
state:

```text
prepared -> submitting -> admitted -> promoted
submitting -> delivery_unknown
submitting -> delivery_failed
delivery_unknown -> admitted | promoted | delivery_failed
```

Direct `submitting -> promoted` persistence is one atomic mutation that records
the implied admitted and promoted history together, rather than two commits.

`prepared` is committed before the first steer attempt and proves no native call
has begun, so restart recovery may perform that first submission. `submitting`
is committed immediately before the call; restart or ownership loss converts it
to `delivery_unknown` unless authoritative native evidence resolves it. Unknown
delivery is never resubmitted. Confirmed admission failure atomically resolves
the request as `delivery_failed` and logically erases its payload. Resolution
may become `answered` or `reached` even while delivery is unknown because the
durable inbox and target action are authoritative.

### 9.3 Deadlines and Restart

Deadlines are persisted as absolute instants. At coordinator startup, pending
requests are loaded, already elapsed requests are expired transactionally, and
bounded timers are reconstructed for the remainder. A restart does not orphan
or cancel a valid request merely because the process generation changed.

The number of live timers is bounded. If pending volume exceeds the direct timer
budget, a bounded deadline scheduler uses the database index rather than one
unbounded timer per request.

### 9.4 Invocation Loss and Explicit Abort

Loss of an in-memory waiter or backend restart leaves the request pending until
its ordinary terminal event. Durable inbox/outbox tools are the recovery path.

An explicit `ToolContext.abort` while the invocation is alive is intentional
cancellation. The coordinator atomically transitions the request to `cancelled`
and logically erases its content, then clears the waiter/timer and rejects late
actions. If abort races a response, signal, deadline, stop, or deletion, the
single successful compare-and-set transition wins.

### 9.5 Target Later Becomes Idle

A request validly created while the target was active remains pending if the
target later becomes idle. The communicator creates no reminder or wake. The
target can retrieve it from its inbox after later resumption. It remains pending
until response, signal, deadline, explicit source cancellation, stop, or
participant deletion.

### 9.6 Participant Deletion

Target deletion transitions pending inbound requests to `target_deleted`.
Source deletion transitions its pending outbound requests to `source_deleted`,
logically erases content because no authorized source remains to retrieve a
result, and removes local waiters after commit. Deletion reconciliation is
idempotent. Late actions return the mapped stored terminal outcome.

Deletion does not rely on root-list absence. Under the current fencing token the
store returns one bounded candidate union: pending targets, pending
sources, available-result sources, and only `created` managed provenance.
`reserved`, `unresolved`, and `deleted` provenance are excluded. Each candidate
is checked with the pinned OpenCode 1.18.21 direct V2 per-ID get and classified
`present`, `absent`, or `unknown`; only an exact response-correlated
`SessionNotFoundError` 404 proves absence. Archived roots and roots directly
retrievable through another supported location remain present. Unknown evidence
does not mutate state. Startup performs this pass before request native recovery
or effects, and a lifecycle-owned 30-second bounded anti-entropy pass closes the
startup-to-hook installation race. The native deletion hook remains a low-latency
path. Reconciliation first classifies the complete candidate snapshot, then passes
the validated absent set to one fenced atomic transaction. The transaction tests
target membership before source membership, preserving `target_deleted` for crossed
roles and cycles when both endpoints are absent. The live hook safely reuses that
transaction with a singleton set. Both paths use strict post-commit notification validation.

### 9.7 Result Retention

Answer/evidence content is retained for at most 24 hours after resolution and
is erased sooner on acknowledgement. Pending source payload is erased on the
terminal transition. Payload-free request metadata remains for 30 days, then is
garbage-collected in bounded batches.

These are logical deletion guarantees. SQLite free pages, WAL data, filesystem
snapshots, backups, and storage media may retain forensic remnants. Checkpoint
and truncation are hygiene measures, not secure-erasure claims.

## 10. Native Admission Semantics

### 10.1 Messages

Messages use one public asynchronous prompt submission. Exact fixed-message read-back proves public
transcript admission but is not proof that an
idle session became active. Payload is not stored in SQLite after confirmed
admission.

### 10.2 Questions and Milestones

Ask/wait require an observed active target and use steer. Persistence occurs
before native admission so ambiguity cannot lose request identity. The target
receives the request ID and guidance to use `session_respond` or
`session_signal`; the durable inbox remains authoritative.

There is an unavoidable status-to-admission race. The coordinator returns or
stores the native outcome and never silently changes delivery mode.

### 10.3 Admission Ambiguity

Timeout, transport loss, backend ownership loss, or a crash between native
effect and SQLite update may make admission unknowable. Such operations are
marked `admission_unknown` or request `delivery_unknown`, never retried
automatically, and reconciled only from authoritative evidence. A pending
request with unknown delivery remains visible and answerable until its original
deadline.

### 10.4 Non-Retractability

No version-one operation promises to remove an admitted input. Request
cancellation, abort, timeout, stop, or deletion controls communicator state and
late responses, not native transcript retraction.

## 11. Architecture

### 11.1 Components

- Plugin entrypoint: exact host check, config parsing, tool registration,
  lifecycle wiring, and fail-closed diagnostics.
- Coordinator: authorization, quotas, request/delivery/start state machines,
  waiters, deadline scheduling, and ownership checks.
- Native adapter: the narrow proven V2/legacy API and event surface.
- Store: SQLite migrations, fenced transactions, retention, and recovery.
- Export service: CLI identity verification, bounded spawn, secure destination
  handling, native JSON validation, and durability.
- Policy engine: administrator policy plus operation-specific host approval.
- Skills package: optional workflow guidance with no correctness dependency.

### 11.2 Adapter Rules

Use V2 for queue/steer admissions, deterministic IDs, creation, and correlation
where Phase 0 proves behavior. Use a legacy endpoint only when 1.18.21 lacks a
proven V2 equivalent for status, visible-set discovery, title update, or stop.
Every fallback is isolated behind a typed adapter and covered by live tests.
There is no silent fallback after an unexpected native failure.

### 11.3 Plugin Hooks

The plugin uses only hooks required for tool registration, event correlation,
configuration, approval, and disposal. `experimental.chat.system.transform` is
not required. If `skills.paths` mutation through the config hook is unreliable,
the package provides explicit project/global installer commands instead of
silently copying files.

## 12. Durable Store and Ownership

### 12.1 Storage Location and Privacy

The database lives in a configurable private local state directory outside
transcript export paths. Startup securely creates or opens the directory and
database, verifies ownership, rejects symlinks/reparse points, and enforces
private POSIX modes or Windows ACLs for the directory, database, WAL, SHM, and
temporary files.

If privacy or no-follow requirements cannot be established and verified,
communicator tools fail closed. Known network/shared filesystem locations are
rejected where practical; documented local-filesystem assumptions remain.

### 12.2 Core Records

The schema includes:

- Workspace metadata and migration version.
- Backend lease and monotonically increasing fencing token.
- Deliveries and native correlation evidence.
- Requests, role participants, deadlines, delivery state, terminal state,
  retained result, acknowledgement, and retention timestamps.
- Source-scoped start operations and managed-session provenance.
- Deadlock edges.
- Quota/rate counters and bounded GC cursors.
- Audit metadata without peer payloads or raw workspace paths.

All tables and indexes include or join through `workspace_key`. Payload columns
are separated from metadata to make logical erasure explicit and testable.

### 12.3 Lease Guarantee

The lease and fencing token protect SQLite single-writer ownership and database
integrity. They cannot atomically fence an OpenCode API call or filesystem
effect and therefore do not guarantee that a stale process performs no external
side effect.

Every mutating transaction checks the current fencing token. The coordinator
also checks ownership immediately before a native/filesystem effect and again
before recording its result. Renewal failure aborts/drains active work. If
ownership is lost around an external call, the record expresses ambiguity
rather than claiming success or retrying.

Lease timing uses a conservative renewal cadence and expiry multiple. Local
decisions use monotonic time where available; persisted wall time is diagnostic.
Phase 0 and tests cover suspend/resume, clock jumps, delayed event loops, disk
full, WAL contention, stale takeover, and ownership loss around every external
effect.

### 12.4 Transaction Ordering

For a response, signal, deadline, cancellation, stop, or deletion:

1. Validate current ownership, authorization, and expected pending state.
2. Perform one compare-and-set terminal transition and logical content erasure.
3. Commit successfully.
4. Resolve/reject the process-local waiter from bounded process-local data.
5. Clear timer/waiter bookkeeping.

A failed commit never produces a successful blocking result.

## 13. Export and Filesystem Security

The threat model includes an adversarial local user able to mutate path
components concurrently.

### 13.1 Destination Containment

Export resolves destinations relative to a securely opened workspace export
root, not through string-prefix or check-then-use path validation.

- Linux prefers `openat2` with `RESOLVE_BENEATH` and no-symlink constraints, or
  descriptor-relative component traversal with `O_NOFOLLOW`.
- macOS uses descriptor-relative no-follow traversal and equivalent containment
  checks.
- Windows uses handle-based canonical verification, rejects junction/reparse
  traversal, and applies non-replacing move semantics.
- Temporary output names are unpredictable and created exclusively with
  no-follow semantics and owner-only permissions/ACLs.
- `overwrite: false` uses an atomic no-replace primitive, never an existence
  check followed by rename.
- Overwrite mode still verifies the destination object and containment at the
  effect boundary.
- File contents are flushed before rename/move; the destination directory is
  flushed where supported. Windows uses `FlushFileBuffers` and equivalent
  durable move behavior.

The state path receives equivalent handle/descriptor-relative no-follow and
privacy treatment.

Full adversarial Linux x64 handling is required before the prerelease. Additional architectures on Linux,
macOS, and Windows implementations and race matrices are required before stable.

### 13.2 CLI Invocation

Export uses `Bun.spawn`, never `PluginInput.$` or a shell. Per invocation it:

1. Resolves and canonicalizes an exact absolute executable path outside
   untrusted workspace/plugin locations.
2. Verifies executable identity and exact version 1.18.21.
3. Invokes that same path with an argv array and minimal environment.
4. Removes dangerous runtime injection variables.
5. Streams bounded stdout into the securely created temporary output.
6. Bounds stderr, elapsed time, output bytes, and concurrent exports.
7. Propagates abort and terminates the child process tree.
8. Treats timeout, ownership loss, or uncertain child termination as explicit
   failure/ambiguity and never retries automatically.

There is no long-lived trust in a PATH-resolved executable. For the pinned 1.18.21 adapter, bounded
fixture and allocation stress measurements freeze a 16 MiB default and 64 MiB immutable stdout
ceiling, a 16 KiB default and 64 KiB immutable stderr ceiling, and at most four concurrent exports.
Configuration may only lower these bounds.

### 13.3 Output Validation

Before commit, the service incrementally validates bounded native JSON with the
top-level `{info, messages}` shape, confirms the embedded session ID equals the
requested session, validates import compatibility, verifies requested sanitizer
mode, rechecks ownership and containment, and enforces overwrite policy.
Malformed or oversized output is removed and never renamed into place.

## 14. Quotas, Rate Limits, and Deadlocks

Configurable limits may only lower immutable hard safety ceilings. Enforcement
exists per source, per target, and workspace-wide as applicable.

The quota model covers:

- Message payload size and admission rate.
- Pending ask/wait count and aggregate bytes.
- Blocking invocations and retained unacknowledged result bytes.
- Live timers/deadline scheduler load.
- Delivery records and admission throughput.
- Start rate, total managed sessions, and recursive-start prohibition.
- Concurrent exports, export rate, duration, stdout/stderr, and output bytes.
- List page sizes and pagination work.
- Database size, retention backlog, and GC batch work.

Existing provisional bounds remain 32 KiB request payload, 10 questions, 20
options per question, `1..3600` second timeout, 24-hour result availability,
and 30-day payload-free metadata retention. Other defaults are conservative and
provisional until measured, then frozen before stable.

Before creating a blocking request, the coordinator checks a workspace-scoped
wait-for graph. A cycle is rejected with `deadlock_detected` before native
admission. Edges are removed only after the terminal transaction commits.
Deadlock prevention is not a substitute for deadlines.

## 15. Configuration

Configuration is validated strictly at startup. Unknown keys and values above
hard ceilings fail closed. The conceptual shape is:

```ts
type CommunicatorConfig = {
  statePath?: string
  exportRoot?: string
  policies?: {
    message?: "allow" | "ask" | "deny"
    ask?: "allow" | "ask" | "deny"
    wait?: "allow" | "ask" | "deny"
    start?: "allow" | "ask" | "deny"
    exportSelfSanitized?: "allow" | "ask" | "deny"
    exportCrossSession?: "allow" | "ask" | "deny"
    exportUnsanitized?: "allow" | "ask" | "deny"
    exportOverwrite?: "allow" | "ask" | "deny"
  }
  start?: {
    allowedAgents?: string[]
    allowedModels?: string[]
    allowManagedSessionRecursion?: boolean
  }
  limits?: {
    // Values may lower, never exceed, compiled hard ceilings.
  }
}
```

Stop is intentionally absent from configurable bypass policy because it always
asks. Respond/signal/request inspection/ack/cancel remain constrained by exact
participant roles and cannot be broadened into cross-session access. Command
configuration does not exist.

## 16. Bundled Skills

Two optional skills ship with the package:

### 16.1 `session-communication`

Teaches discovery, peer collaboration requests, request recovery, idempotent
starts, explicit stop approval, safe exports, and the difference between
admission and activity. It states that either peer may initiate communication
and that source and target are temporary operation roles. Its idle workflow is exact:

1. Queue a normal message to wake/resume an existing idle session.
2. Inspect `session_list` until the session is `busy` or `retry`.
3. Use `session_ask` or `session_wait` only then.

It states that queued admission does not prove activation and that peer content
does not bypass ordinary permissions.

### 16.2 `session-request-participant`

Teaches request participants to inspect their inbox, retrieve pending payloads,
use `session_respond`/`session_signal`, handle already-terminal requests, and
avoid acting on untrusted peer instructions without normal authorization. It
uses the same explicit idle workflow when contacting another session and makes
clear that inbound requests do not create a subordinate role.

### 16.3 Registration

Phase 0 tests config-hook registration through `skills.paths`. If unreliable,
the package documents explicit project and global installer commands. It never
silently copies files. Every tool remains understandable and correct without a
skill being installed or loaded.

## 17. Repository Layout

```text
package.json
tsconfig.json
src/
  index.ts
  config.ts
  errors.ts
  ids.ts
  coordinator.ts
  policy.ts
  tools/
    list.ts
    send.ts
    delivery-get.ts
    ask.ts
    respond.ts
    wait.ts
    signal.ts
    request-list.ts
    request-get.ts
    request-ack.ts
    request-cancel.ts
    stop.ts
    start.ts
    export.ts
  native/
    adapter.ts
    v2.ts
    legacy.ts
    events.ts
  store/
    sqlite.ts
    migrations.ts
    ownership.ts
    deliveries.ts
    requests.ts
    starts.ts
    retention.ts
  export/
    process.ts
    paths.ts
    validate.ts
skills/
  session-communication/SKILL.md
  session-request-participant/SKILL.md
test/
  unit/
  integration/
  black-box/
  live/
```

The exact module split may be simplified during implementation; boundaries are
valuable only where they isolate native APIs, storage, policy, or platform
filesystem behavior.

## 18. Implementation Phases

Internal slices may be exercised privately, but the first published prerelease
contains all fourteen tools.

### Phase 0: Live 1.18.21 Feasibility Gate

Use an isolated project-pinned harness to prove and record fixtures for:

- Host version through `client.global.health()` and fail-closed mismatch.
- Visible root listing, archive behavior, and `busy`/`retry`/`idle` status.
- Legacy/V2 identity over the same sessions.
- Caller identity, abort, and exact approval-resource behavior.
- Queue admission, idle activation, FIFO ordering, caller message IDs, and
  admission/promotion correlation.
- Delivery crash recovery at `prepared` and `submitting`, including payload
  erasure and prohibition on resubmitting an ambiguous operation.
- Whether exact execution-start evidence exists; omit `started` if not.
- Active-only steer behavior and the busy-to-idle status race.
- Interruption behavior and preservation of admitted inputs.
- Deterministic create IDs, duplicate handling, title updates, and partial start
  recovery/idempotency.
- Restart recovery of requests, reconstructed deadlines, inbox/outbox access,
  and terminal result retrieval.
- CLI resolution and per-invocation version verification with `Bun.spawn`.
- Native sanitizer and import-compatible `{info, messages}` output.
- Skill registration through `skills.paths` and explicit fallback installation.
- Event subscription and plugin disposal behavior.
- Lease behavior under suspend, clock jumps, delayed event loop, disk full, and
  stale takeover.

The gate removes or revises any contract the pinned implementation cannot
support. It contains no remote command or synthetic wake experiments.

### Phase 1: List, Send, and Delivery Vertical Slice

- Create the pinned package, exact runtime check, strict config, IDs, shared
  domain errors, source/target validation, and minimal private SQLite store.
- Implement `session_list`, message-only `session_send`, and
  `session_delivery_get` end to end with real native correlation.
- Implement source/target/workspace message and delivery quotas.
- Dogfood idle message -> status inspection without claiming activation.

### Phase 2: Durable Request Recovery and Blocking Tools

- Add request schema, fenced terminal transitions, absolute deadline recovery,
  bounded scheduler, deadlock edges, result retention, and logical erasure.
- Implement request list/get/ack/cancel with role authorization.
- Implement ask/respond and wait/signal with active-only steer and admission
  ambiguity.
- Test invocation loss, explicit abort, restart, later-idle targets, and all
  response/signal/deadline/cancel races.

### Phase 3: Stop and Start

- Implement non-bypassable stop approval, already-idle behavior, role-specific
  request termination, and interruption ambiguity.
- Implement source-scoped start idempotency, partial operation states,
  agent/model allowlists, provenance, quotas, and recursion prohibition.

### Phase 4: Export, Skills, and Hardening

- Implement native sanitized export through bounded `Bun.spawn`.
- Complete descriptor/handle-relative containment and adversarial Linux tests.
- Add both skills and proven registration or explicit installation paths.
- Complete retention, GC, database ceilings, observability, fault injection,
  and threat-model review.

### Phase 5: Complete Prerelease and Dogfooding

- Publish only when all fourteen tools and Linux security requirements pass.
- Exercise multi-session workflows and collect schema/limit evidence.
- Keep schemas explicitly unstable; make breaking corrections discovered during
  dogfooding.

### Phase 6: Stable Schema Freeze and Cross-Platform Release

- Complete macOS and Windows process/filesystem implementations and adversarial
  matrices.
- Freeze tool schemas, domain errors, defaults, and compatibility policy.
- Pass live acceptance on Linux, macOS, and Windows.
- Let user testing of the complete `0.1.0` prerelease lead to `1.0.0`; publish that
  stable release only after all acceptance criteria hold.

## 19. Testing Strategy

### 19.1 Contract and Authorization Tests

- Exact schema tests for all fourteen tools and per-tool domain errors.
- Malformed, wrong-prefix, wrong-length, collision, and entropy tests for IDs.
- Caller/target stale, deleted, invisible, foreign-workspace, and malformed
  context tests.
- Recovery reads/mutations require a current visible caller but continue to work
  when the stored counterpart is stopped, deleted, archived, or invisible.
- Constant-shape unauthorized lookup tests.
- Approval binding tests for changed source, target, operation, parameters,
  digests, destination, and sanitization mode.
- Prompt-injection fixtures in message, title, question, answer, milestone, and
  evidence fields; provenance must remain separate and display controls stripped.

### 19.2 Admission and Activity Tests

- Message queue admission to active and idle sessions.
- Idle activation observed separately through `session_list`.
- Admission never represented as activation.
- Queue FIFO, promotion correlation, interruption preservation, and ambiguity.
- Crash before and after `prepared -> submitting`: only `prepared` performs a
  first submission after restart; recovered `submitting` becomes unknown and is
  never resubmitted.
- `target_idle` persists no ask/wait request.
- Busy/retry-to-idle races report native behavior with no queue fallback.
- No hidden polling, retry, synthetic wake, reminder, or system-transform use.
- `started` absent unless the Phase 0 evidence test passes.

### 19.3 Request Tests

- Durable pending requests across backend restart and process replacement.
- Reconstructed timers and immediate expiry of elapsed deadlines.
- Metadata-only inbox/outbox lists and strict role-aware get access.
- Answer labels/custom text, order, cardinality, empty arrays, and bounds.
- Terminal transition races among respond/signal/deadline/abort/cancel/stop/delete.
- Commit-before-waiter resolution and injected commit failure.
- Explicit abort cancels; mere invocation/backend loss does not.
- Admission unknown remains pending, is never retried, and can be answered.
- Request delivery states recover `prepared`, conservatively mark `submitting`,
  and terminalize confirmed admission failure as `delivery_failed`.
- Target later idle creates no wake and leaves request in inbox.
- Source/target stop and deletion reasons remain distinguishable.
- Missed deletion hooks reconcile at startup and by bounded periodic anti-entropy
  from direct per-ID evidence; list absence and malformed/uncorrelated 404s do not
  delete. Archived and alternate-location direct retrieval remain present.
- Ack idempotency, immediate result erasure, 24-hour expiry, and
  `result_expired` retrieval.
- Thirty-day payload-free metadata retention and bounded GC.

### 19.4 Start and Stop Tests

- Stop always asks, including permissive administrator configuration.
- Approved idle stop returns `already_idle` without native interrupt.
- Ownership loss and native interruption ambiguity.
- Same-key/same-arguments start resume and same-key/different-arguments conflict.
- Crash at every create/title/admission boundary and deterministic recovery.
- Creation/title/admission `prepared`, `submitting`, failed, and unknown branches;
  title failure/ambiguity remains visible while admission may continue.
- Agent/model defaults and exact allowlists.
- Per-source/workspace rates and managed-session counts.
- Managed-session recursive start denied by default and explicitly opt-in only.

### 19.5 Store and Ownership Tests

- Migration atomicity, corruption, WAL behavior, disk full, and private sidecars.
- Every mutation rejects a stale fencing token.
- Suspend/resume, clock jumps, delayed renewal, stale takeover, and contention.
- Ownership loss immediately before and after every external effect records
  ambiguity and never triggers automatic retry.
- Logical deletion assertions and documentation that avoids forensic claims.
- Source, target, workspace, timer, retained-result, delivery, start, export,
  list, and database hard ceilings.

### 19.6 Export Tests

- Exact executable path/version verified for every invocation.
- Executable replacement, hostile PATH, writable executable location, dangerous
  environment variables, shell metacharacters, and argv boundary tests.
- Timeout, abort, process-tree termination, stderr/stdout, size, and concurrency
  limits.
- Native sanitizer required; no fallback.
- `overwrite: true` requires its independently bound approval under shipped
  defaults, including sanitized self-export.
- Native JSON shape, embedded session ID, import compatibility, and malformed or
  oversized stream rejection.
- Parent/destination symlink swaps, junction/reparse points, path traversal,
  no-replace races, overwrite rules, temp-file attacks, and durability faults.
- Equivalent adversarial tests for state/database/WAL/SHM paths.
- Linux x64 matrix before prerelease; additional architecture and Linux/macOS/Windows matrices before stable.

### 19.7 Skills and Live Acceptance

- Skill discovery through config hook or documented explicit installers.
- No silent file copy and no correctness dependency on skills.
- Both skills teach message -> inspect active -> ask/wait and state that
  admission does not prove activity.
- Both skills describe independent peers and temporary per-operation source and
  target roles without supervisor/worker authority.
- Live multi-session acceptance covers all tools, restart recovery, idle flow,
  role authorization, partial starts, stop approval, and sanitized export.
- Live tests run against isolated exact 1.18.21, never the user's active 1.17.20
  installation.

## 20. Observability

Structured diagnostics include workspace hash, operation type, opaque IDs,
states, durations, quota class, native evidence IDs, ownership generation, and
safe error code. They exclude peer payloads, answers, evidence, raw workspace
paths, unsanitized titles, transcript content, approval secrets, and export JSON.

Metrics cover admissions and ambiguity, request age/outcomes, deadline lag,
retained result bytes, quota rejection, database/GC size, lease renewal,
ownership loss, start partial states, export limits, and child termination.

Diagnostics must distinguish:

- Native admission from observed session activity.
- Communicator terminal state from model compliance.
- Atomic visibility from power-loss durability.
- Logical deletion from forensic secure erasure.
- Database ownership guarantees from ambiguous external effects.

## 21. Acceptance Criteria

The first prerelease requires:

1. Exact 1.18.21 host validation and isolated Phase 0 evidence.
2. All fourteen tools implemented with tested role/workspace authorization.
3. Message-only queue admission and explicit idle activation workflow.
4. Active-only ask/wait with `target_idle`, no persisted idle request, no hidden
   retry/fallback, and tested status races.
5. Durable request restart recovery, reconstructed deadlines, metadata-only
   inbox/outbox, source retrieval, acknowledgement, and cancellation.
6. Atomic terminal transitions, commit-before-waiter ordering, and retained
   results for acknowledgement or 24 hours.
7. Role-specific stop/deletion outcomes and non-bypassable stop approval.
8. Durable source-scoped start idempotency, partial states, allowlists, quotas,
   provenance, and recursion protection.
9. Shared discriminated domain errors and constant-shape sensitive lookups.
10. Source, target, and workspace quotas under immutable hard ceilings.
11. Private local state with verified Linux x64 no-follow protections and logical
    deletion language.
12. Bounded exact-path `Bun.spawn` export, native sanitizer, validated output,
    overwrite approval, and adversarial Linux x64 containment tests.
13. Both peer-communication skills available through a proven registration or
    explicit installer.
14. No command execution, synthetic wake/reminder subsystem, system-transform
    dependency, restart orphaning, or exactly-once external-effect claim.

Stable additionally requires complete macOS and Windows filesystem/process
security matrices, cross-platform live acceptance, measured frozen limits, and
the schema compatibility freeze.

## 22. Risks and Mitigations

### 22.1 Native Evidence Is Weaker Than Expected

Phase 0 may show that admissions cannot be correlated or that execution-start
evidence is unreliable. Mitigation: keep conservative states, represent
ambiguity, and omit `started`; never infer stronger evidence.

### 22.2 Status Races

An active target can become idle before steer admission. Mitigation: document
the point-in-time check, expose the exact native outcome, keep ambiguous durable
requests recoverable, and never auto-queue.

### 22.3 Model Compliance

A model may ignore a request or never inspect its inbox. Mitigation: bounded
deadlines, durable recovery, explicit cancellation, request-participant skill guidance, and
no claim that admission means compliance.

### 22.4 Stale External Effects

SQLite fencing cannot atomically guard native or filesystem effects. Mitigation:
ownership checks around every effect, draining on lease loss, deterministic IDs
where native semantics prove them, explicit ambiguity, and no automatic retries.

### 22.5 Local Path Mutation

String path checks are vulnerable to symlink/reparse and TOCTOU races.
Mitigation: descriptor/handle-relative traversal, exclusive no-follow temp
creation, atomic no-replace, durability flushes, fail-closed privacy checks, and
platform-specific adversarial tests.

### 22.6 Native Export Availability

The plugin API has no export endpoint and CLI behavior may differ. Mitigation:
exact per-invocation executable/version validation, native output fixtures,
bounded spawn, and export-only failure isolation.

### 22.7 State Privacy

SQLite logical erasure cannot remove every forensic copy. Mitigation: minimize
retention, use private local state and sidecars, checkpoint/truncate as hygiene,
exclude payloads from logs, and accurately document residual exposure.

### 22.8 Resource Amplification

One source can fan out across targets or recursively create work. Mitigation:
source, target, and workspace rates/counts/bytes, hard ceilings, bounded lists
and timers, start approval/allowlists, and recursion disabled by default.

### 22.9 Platform Differences

Filesystem, process-tree, ACL, and durability primitives differ. Mitigation:
Linux x64-only prerelease dogfooding after complete Linux x64 hardening, no stable
release until Linux/macOS/Windows matrices pass, and fail closed on unsupported
semantics.

## 23. Future Work

Future versions may consider, only with evidence and separate review:

- Additional tested OpenCode version adapters.
- Optional execution-start state if native evidence becomes reliable.
- Target consent workflows beyond administrator policy.
- User-facing request inbox views.
- Stronger payload confidentiality such as application-level encryption.
- Remote/shared-backend coordination with a purpose-built distributed protocol.
- Metrics-driven batching or notification features that do not hide activation
  or compromise durable recovery.

Remote command execution and automatic synthetic wake/reminder systems are not
implicitly deferred features; adding either requires a new product, security,
and reliability decision.
