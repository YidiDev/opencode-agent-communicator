# Linux SQLite store assumptions

The Bun SQLite adapter provides **single-backend-writer database integrity**, not
distributed coordination and not fencing of OpenCode or filesystem side effects.
Its fencing token is checked by every store mutation. A process must still check
ownership immediately before an external effect and again before recording its
outcome.

The configured state directory must be an absolute, normalized, non-root path on
Linux. Preparation opens `/`, walks one component at a time through
`/proc/self/fd/<parent-fd>/<component>`, and opens every child with
`O_DIRECTORY|O_NOFOLLOW`. Missing children are created through that anchored parent
and then opened and verified. The final directory remains open for the complete
SQLite lifetime. Its owner and type are checked with `fstat`, and mode `0700` is
applied and rechecked with `fchmod` on that same descriptor. Existing unsafe final
directories and all symlink/non-directory traversal are rejected.

The database is precreated and verified through the final descriptor with
`O_NOFOLLOW`; database, WAL, SHM, and rollback-journal objects are owner/type
verified, required to have exactly one hard link, and set to `0600` using `fchmod`
on their open descriptors. Bun SQLite is
given `/proc/self/fd/<dir-fd>/<validated-name>`, not the canonical pathname, so its
database and sidecar lookup stays attached to the opened directory if canonical
parents are subsequently renamed. `databasePath` is canonical-path metadata only.
The directory descriptor is closed only after SQLite closes. A process of another
UID cannot redirect this traversal or later sidecar creation. A malicious process
running as the same UID can access `/proc/<pid>/fd` and the private files and is
explicitly outside the confidentiality and integrity boundary.

`SQLITE_OPEN_NOFOLLOW` cannot be combined with this Bun-compatible design because
SQLite treats the intentional `/proc/self/fd/<dir-fd>` descriptor link as a
symlink. No untrusted pathname is delegated to that flag: the filename is strictly
validated and preopened with kernel `O_NOFOLLOW`, and the held `0700` directory
descriptor anchors every SQLite and sidecar path. This is the strongest practical
descriptor anchoring available through Bun's current filename-only SQLite API.

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
