# Linux SQLite store assumptions

The Bun SQLite adapter provides **single-backend-writer database integrity**, not
distributed coordination and not fencing of OpenCode or filesystem side effects.
Its fencing token is checked by every store mutation. A process must still check
ownership immediately before an external effect and again before recording its
outcome.

The in-process adapter is also a trusted finite-operation boundary. SQLite transactions cannot be
safely interrupted after dispatch without introducing commit ambiguity. Application abort signals
therefore bound native and foreground operations but do not pretend to cancel an in-flight
transaction; creation, claim, and delivery completion use fenced exact reconciliation after a
thrown or malformed settlement.

The configured state directory must be an absolute, normalized, non-root path on
Linux. Preparation opens `/`, walks one component at a time relative to each retained
parent descriptor, and opens every child with `O_DIRECTORY|O_NOFOLLOW`. Missing
children are created through that anchored parent and then opened and verified. Every
existing canonical ancestor must be a directory owned by root or the current UID and
must not be group/world writable. A root-owned
sticky traversal directory (for example `/tmp`) is the sole shared-write exception,
which permits private temporary test/deployment roots without trusting preplaced
children. The complete descriptor chain, not only the final directory, remains open
for the SQLite lifetime. The final directory's owner and type are checked with `fstat`,
and mode `0700` is applied and rechecked with `fchmod` on that same descriptor.
Existing unsafe final directories and all symlink/non-directory traversal are rejected.

The database is precreated and verified relative to the final descriptor with
`O_NOFOLLOW`; database, WAL, SHM, and rollback-journal objects are owner/type
verified, required to have exactly one hard link, and set to `0600` using `fchmod`
on their open descriptors. Bun SQLite receives the validated canonical absolute
database path and opens it with `SQLITE_OPEN_NOFOLLOW`; a descriptor path is not used
because that flag rejects the descriptor symlink. Before initialization and each
store operation, every retained child is reopened relative to its retained parent and
must keep the same device/inode identity. This detects replacement of any canonical
ancestor before SQLite work. The complete descriptor chain is closed only after
SQLite closes. A process of another UID cannot access the private directory through
ordinary permissions. A malicious process running as the same UID can access the
private files and is explicitly outside the confidentiality and integrity boundary.

The filename is strictly validated and preopened with kernel `O_NOFOLLOW`, while the
held `0700` directory descriptor anchors database and sidecar verification. If SQLite
cannot safely resolve the canonical absolute path without following a disallowed
final symlink, startup fails closed.

Descriptor-anchored `statfs` rejects known NFS, SMB/CIFS, 9P, AFS, Coda, Ceph,
Lustre, OCFS2, GFS2, GPFS, BeeGFS, PanFS, and OrangeFS/PVFS2 Linux magic values.
FUSE is rejected by default. The narrow
`allowFuseStateFileSystem` option is only for an operator who has independently
validated the exact FUSE implementation's POSIX locking, durability, ownership,
and SQLite WAL behavior; it does not weaken any no-follow or private-mode check.
The denylist cannot prove that an unknown filesystem or bind mount is suitable.
OverlayFS is accepted for local containers, whose backing storage must satisfy the
same requirements.

The database uses verified WAL, `foreign_keys=ON`, `synchronous=FULL`, private
in-memory temporary storage, a bounded busy timeout and cache, disabled mmap, a
bounded WAL autocheckpoint, `quick_check`, `foreign_key_check`, and SQLite
`max_page_count`. Before each operation that can mutate SQLite, anchored descriptor
stats check individual database, WAL, SHM, and rollback-journal ceilings and their
aggregate. An over-limit state requires a successful truncating checkpoint and a
passing recheck; a busy/blocked checkpoint or remaining excess fails closed. WAL
auto-checkpointing is fixed at 256 pages and clean owner close performs a truncating
checkpoint. A successful precheck cannot prevent the immediately following single
transaction from growing WAL; the residual is bounded by one already quota-bounded
transaction and is rejected or checkpointed before the next mutation. This is a
conservative operational bound, not an instantaneous hard quota during a commit.
SQLite failures are classified from `SQLiteError.code`/`errno`, never localized
messages. `SQLITE_IOERR` and `SQLITE_READONLY` are storage outages. `SQLITE_FULL`
is a configured quota only when the page limit was already reached with no free
pages before the mutation; otherwise, including kernel `ENOSPC`, it is
`storage_unavailable`.

`temp_store=MEMORY` prevents SQLite temp databases from being placed beside state.
WAL is mandatory. A `-journal` file can nevertheless exist during initial journal
mode establishment or recovery, so it receives the same no-follow, owner, mode,
and aggregate-size treatment. This store attaches no secondary databases, and thus
does not intentionally create super-journals. Logical payload deletion does not
promise forensic erasure from old pages, WAL, journals, snapshots, or storage media.

Startup composition must acquire ownership and finish stale-submitting
classification through `RecoveryStartupBarrierPort` before it starts ordinary
workers. The barrier object is process-local and cannot be forged into the store's
stale-token recovery query. Recovery drains repeated bounded stale batches before
it reads prepared work and stops on abort, deadline, or ownership loss.

After a live generation observes its own lease expiry, it never renews that stale token. The next
not-yet-started tool call may trigger one process-local composition replacement: stale tool admission
closes synchronously, active calls are aborted and must drain within the bound, and stale resources
and the store close before one abortable wait through the persisted expiry plus configured takeover
grace. The wait is capped by the startup deadline. Disposal cancels the wait or an in-progress fresh
startup with the same signal, preventing later startup phases and rolling partial resources back.
One fresh store then runs this full startup barrier; its acquisition remains authoritative if clocks
diverged or another backend took ownership. Contention is retained only as a typed sanitized
diagnostic, never an owner label or raw adapter error. The successor is published only when its
fencing token is strictly greater.
Concurrent callers share the replacement; callbacks that already began, including argument parsing,
never transfer or replay.

Lease renewal is hardened against wall-clock regression. Persisted `renewed_wall_ms` and
`expires_wall_ms` never move backward: renewal uses the maximum of the current wall reading and the
stored renewal instant, then extends from that non-regressing point. Local liveness still uses the
monotonic clock. A backward wall-clock jump cannot shorten a valid stored lease, revive an expired
local lease, reduce a fencing epoch, or authorize premature takeover. Malformed or overflowing clock
values fail closed.

A stale close naturally performs no ownership release mutation. A drain timeout leaves unresolved
work quarantined rather than pretending it drained; eventual settlement triggers exactly one stale
resource disposal while the timeout remains terminal. Storage, contract, or workflow faults, host
disposal, takeover/non-advancing epochs, and any replacement failure are not recoverable in-process
and do not loop.

Session-start recovery also scans bounded `outcome_unknown` creation records. Requested agent/model
identity and whether a title was requested remain in bounded non-message columns independently of the
erasable initial-message payload. Native read-back must prove the deterministic ID is an exact root
in the pinned directory with the requested overrides. Exact matches atomically confirm provenance;
proven stable absence and collisions atomically release it. The pinned API's exact 404 is not stable
absence after submission because an accepted create may commit later. Uncertain observations stay in
a separate hard-bounded `unresolved` provenance class and do not consume the ordinary quota for
communicator-started sessions.

All pending schema migrations run in one `BEGIN IMMEDIATE` bootstrap transaction.
Before its first DDL statement, startup inspects both legacy (pre-v3) and current
ownership rows and refuses migration beneath any non-released lease until
`expires_wall_ms + takeoverGraceMs`; an explicit release permits immediate migration.
Every declared migration checksum is recomputed from canonical UTF-8 forward SQL before
history is trusted or schema mutation begins. `downSql` is non-published test tooling used
only to exercise reversibility; production startup never executes it and published migration
identity does not include it.

Each adapter instance is bound to exactly one validated workspace. Mutations and
recovery scans for another workspace fail closed; participant lookup for another
workspace keeps the constant-shape `undefined` result. A stale submission in a
different workspace therefore cannot block startup for this store. Deployments
must construct and recover one store instance per workspace they intend to serve.
Schema v7 caps all request rows with `delivery_state = submitting` at 4096 per
workspace, regardless of pending or terminal resolution. Its insert/update triggers
and pre-install audit use `requests_submitting_recovery`; request claim checks the same
indexed count in its immediate transaction. Stale-submitting startup recovery uses
that exact 4096 bound and a residual probe, while pending prepared and expiry work
remain bounded at 1024.

Participant-deletion reconciliation uses no schema migration. A fenced query unions distinct
pending target/source IDs, available-result source IDs, and `created` session-start provenance,
with a compiled 7168-row hard ceiling. Presence is classified for the complete candidate snapshot
before mutation. One immediate transaction receives the validated absent-ID set as a single JSON1
value, retires matching created provenance, erases results owned by absent sources, validates and
erases affected pending private state, and terminalizes all affected requests. Target membership is
tested before source membership, so crossed roles and cycles always resolve as `target_deleted`
when both endpoints are absent. Empty sets are no-ops; duplicate, malformed, sparse, accessor-backed,
or over-ceiling sets fail closed. The single-session live-event API safely reuses the same transaction.
Committed terminal notifications are emitted only after the transaction returns successfully.

Schema v8 adds the private nullable `creation_operation_id` column and a partial unique
workspace/operation index. Repository-created requests always carry a validated `op_…` value;
legacy null rows remain readable but cannot be adopted by new creation reconciliation.

Schema v14 adds the start operation's `idempotency_arguments_sha256` and each request's immutable
`delivery_mode` (`steer`, `queue`, or `initial`) plus optional `linked_start_operation_id`. A partial
unique workspace/link index and insert/update triggers require every `initial` request, and only an
`initial` request, to carry a linked start operation. Existing rows migrate as `steer`; existing start
operations copy their former argument digest into the new complete-public-argument digest. The
composite start path then inserts or resumes the start operation and its linked prepared request in
one fenced `BEGIN IMMEDIATE` transaction. Recovery follows the persisted mode and link rather than
inferring which native effect to use from transient process state.

Schema v15 adds an immutable `request_terminal` reason for a linked start whose native creation
provably never began. Correlation atomically erases its private start payload, releases only the
reserved managed-session row, and exposes the operation as `request_terminal` rather than an
approval or policy rejection. If native creation may have begun, recovery reconciles it first. A
matching or created root keeps managed provenance while any not-yet-started title or initial
admission becomes `payload_unavailable`; submitting or known admission outcomes are preserved and
never replayed.

Schema v16 adds `requests.delivery_transport` (`native` or `context`) and the
`context_admissions` table. Existing-root context requests keep the legacy physical
`delivery_mode = 'steer'` value but are distinguished by `delivery_transport = 'context'`; linked
`initial` requests must remain native. The context table stores a bounded canonical envelope only
while its state is `prepared` or `awaiting_context`, caps one envelope at 64 KiB, and uses the
existing delivery record, byte, and rate ceilings. One provider transform selects at most 32 rows
and 64 KiB for a visible `busy`/`retry` target, then atomically claims the exact digest-bound set and
erases its payload. It may also include at most 20 payload-free available-result reminders and an
active-lock count. These values are provider-visible, transcript-invisible, and explicitly marked
as untrusted. Bounded 24-hour GC applies only to standalone terminal message admissions; request
admissions cascade with their parent after request retention.

Migration v16 does not reinterpret legacy native delivery as context. Pending existing-root
`steer`/`queue` rows still in `prepared` have private payload and wait edges erased and become
`delivery_failed`. Ambiguous `submitting` and `delivery_unknown` rows retain their state and recovery
data. At every startup, any context admission left `awaiting_context` is failed and erased in bounded
batches, because a crash cannot prove whether the provider already received the transformed
messages. Neither path replays content.

OpenCode v2 delivery no longer depends on private steer/queue HTTP endpoints or a prior `busy`
observation. Ordinary transcript-visible sends and existing-root ask/wait request envelopes are
persisted before one public `session.prompt` queue admission. Prepared state proves the effect has not
begun; submitting state remains ambiguous after interruption and is never blindly replayed. Legacy
v16 context rows retain their existing fail-closed recovery rules, but public queue admission is the
durable default.

Schema v17 adds the bounded `communicator_participants` registry. It migrates historical source,
target, and managed-session IDs as root candidates while deliberately leaving visibility, archive,
activity, and title evidence unknown. Current host observations may update sanitized metadata. The
registry is discovery state only: `session_list` selects bounded root candidates and then performs an
authoritative public v2 ID-addressed revalidation before returning each item. Registry presence,
historical protocol participation, or list absence never proves current visibility, authorization,
deletion, or activity. A per-workspace trigger enforces the compiled row ceiling.

An administrator owner label is diagnostic only. Every store construction creates
a fresh random process-generation identity. Repeated acquisition by one live
generation returns its existing token, while every valid new-generation takeover
increments it. Clean close checkpoints and marks current ownership released so a
new generation can acquire immediately. Crash recovery waits for lease expiry plus
the configured grace. Persisted lease times are wall-clock diagnostics and
takeover inputs; the live owner also uses a monotonic deadline and fails closed
after missed renewal. Cross-host clocks and shared filesystems are unsupported.

Connection-local pragmas are established while a handle is opened. File-persistent and
shared settings (`journal_mode`, `max_page_count`, journal limits, and WAL checkpoint
policy) are changed only after serialized lease acquisition. Construction beneath another
live or grace-period owner therefore performs no shared SQLite configuration change. On
close, a current owner capacity-checks and truncating-checkpoints before marking release;
release is its final SQLite mutation. A stale closer only closes its existing handles.

Prepared-envelope retention is atomically bounded by aggregate UTF-8 bytes per
source, target, and workspace, in addition to record and admission-rate limits.
Expired rate events are pruned only in bounded batches. These controls bound live
retention and database growth; they do not change the logical-deletion-only
guarantee.
