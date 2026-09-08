# Session export security boundary

`session_export` is a Linux x64-hardened contract registered by the plugin composition. Composition
must provide a securely configured export root and a
canonical absolute OpenCode executable outside workspace and plugin directories.
Export is not a fallback for `session_read`: code must not read an exported file to bypass the
restricted projection or its cross-session approval. See
[Session read security](session-read-security.md) for that separate disclosure boundary.

The adapter opens the root and every destination parent through retained directory descriptors
with `O_NOFOLLOW`, flushing each newly created directory and its parent. Transcript bytes exist only
in a mode-0600 `O_TMPFILE` inode retained by descriptor. No-replace uses
`linkat(AT_EMPTY_PATH)`. Approved overwrite links that inode to an unpredictable staging name in
the reserved mode-0700 `.session-export-staging` child of the configured export root,
opens the exact destination without following symlinks, requires a mode-0600, singly linked regular
file owned by the process user, and rechecks that the name still identifies that inode. It then uses
a plain descriptor-relative `renameat2` atomic replacement. The replaced inode loses its only name
inside that syscall; unlike `RENAME_EXCHANGE`, no crash window can strand the old transcript under
the staging name. The adapter verifies the installed inode and flushes directory metadata.
Overwrite approval authorizes replacement of the bound destination path, not a particular inode
version. Linux provides no conditional compare-inode-and-rename primitive; a process running as the
same OS user can still mutate that name between the final identity check and `renameat2`. Such a
same-user process is explicitly outside the state/export boundary documented in `SECURITY.md` and
`README.md`.
If `O_TMPFILE`, `AT_EMPTY_PATH`, or `renameat2` is unavailable, export fails closed; it never falls
back to a named transcript temporary. Failures before replacement clean the new staging link and
remain definite when that cleanup succeeds; verification or durability uncertainty after replacement is
`native_outcome_unknown`. Once staging has linked transcript bytes into the namespace, failure to
unlink that stage or to flush its parent is also `native_outcome_unknown`.

Crash recovery recognizes only the reserved `.session-export-staging` directory and exact
`.session-export-<32 lowercase hex>.stage` children. Every component in those namespaces is rejected
by the public destination validator, so an accepted export can never be mistaken for cleanup state.
On root open, before creation, and once per minute while the root lifecycle is open, it scans only
that dedicated directory and removes only mode-0600, singly linked regular files
owned by the process whose unchanged inode identity is at least fifteen minutes old. Final metadata
opens use Linux `O_PATH|O_NOFOLLOW|O_CLOEXEC`, so FIFOs and devices cannot block inspection and
symlinks are never followed. Mutation is descriptor-relative and each removal is followed by a
parent flush. Ordinary retained exports do not consume the immutable 4,096-stage recovery ceiling.
Destination traversal is pinned to the configured root's Linux mount ID, device, and filesystem
type, so same-filesystem bind mounts and cross-filesystem mount transitions fail closed.
Fresh stages are preserved for other processes sharing the root; therefore a crash
stage has finite retention of fifteen minutes plus at most one cleanup interval while a lifecycle is
running, or until the next root open afterward. The periodic timer is unrefed and lifecycle-owned;
cleanup faults dispose it and close the export root so future export fails closed.

The export-only FFI boundary remains lazy. On the certified x86-64 target it considers only reviewed
absolute glibc/musl locations, canonicalizes each candidate, verifies a root-owned regular file and a
fully root-owned, non-group/world-writable ancestor chain, and binds through the retained
`/proc/self/fd/<fd>` object. It never asks the dynamic loader to search for `libc.so.6`; unsupported
architectures or failed trust checks leave secure export unavailable. The source retains ARM64
syscall numbers and absolute libc candidates for possible future work. They are not `0.3.0`
certification evidence or a support claim, and package metadata excludes ARM64 installation.

Native export accepts only a direct ELF binary (scripts and CLI shell wrappers are unsupported) on
a root-owned, non-group/world-writable executable and ancestor chain and
pins its inode behind one retained descriptor for both version and export spawns. It retains a
descriptor for a fully root-owned/nonwritable cwd ancestor chain, rejects inherited runtime/config
injection controls, and forces pure/project-config-
disabled/plugin-disabled/external-skill-disabled operation. Stdout, stderr, elapsed time,
per-source/workspace rates, and concurrency are bounded. Export stdout has a measured/frozen 16 MiB
default and 64 MiB immutable byte ceiling, but it is not retained as a whole process buffer. Each
chunk is written to the descriptor-retained temporary inode, added to the SHA-256 digest and byte
count, and fed to validation in the same pass. The temporary inode is not installed until the child
exits successfully, validation succeeds, and the effect-boundary checks pass.

Validation incrementally decodes at most 64 KiB at a time and does not retain the stdout byte stream
or a whole decoded JSON string. The parser does retain the parsed structural graph needed for exact
OpenCode 1.18 shape, nested metadata, tool-state, and binding checks. That graph is fail-closed and
bounded by immutable ceilings: nesting depth 32, 120,000 aggregate JSON value nodes, 80,000 object
keys, 2,048 messages, 8,192 aggregate message parts, and 100,000 strings. JSON object keys count as
strings. Individual strings are limited to 1,048,576 UTF-16 code units, all strings together to
8,388,608 code units, and a numeric token to 256 characters. These structural ceilings constrain
retained graph overhead independently of the stdout-byte ceiling; they are not configurable upward.

Malformed JSON, an incompatible import shape, a wrong embedded session ID, or unproven sanitizer
markers produce `export_unavailable`. A stdout/stderr byte ceiling or JSON structural ceiling
produces `export_limit_exceeded`. A deadline or abort observed while the native child is running, or
uncertain child termination, produces `native_outcome_unknown`; TERM then KILL is sent to the
detached Linux process group and the operation is never retried. Every rejected capture discards the
unnamed temporary rather than installing it. Valid output must have the exact top-level
`{info,messages}` envelope, matching embedded session IDs, import-shaped messages, and the sanitizer
markers proven by the live capability gate. The public projection contains only the relative
destination, byte count, sanitization mode, and incrementally calculated SHA-256 digest.
The schema fixture source is the pinned build-time `@opencode-ai/sdk@1.18.25` V2 generated
`Session`/`Message`/`Part` declarations, checked against real CLI export and sanitized CLI import
round trips at both compatibility boundaries in `test/live/opencode-1.18.test.ts`.

Linux x64 CI supplies only `DAC_READ_SEARCH` to network-isolated, read-only glibc and musl containers,
sets a hostile `LD_LIBRARY_PATH`, and sets `REQUIRE_SECURE_EXPORT_CAPABILITY=1`. In those
positive-capability cells, the acceptance tests and both
export integration files must complete with a zero-skip JUnit report. This makes the symlink-race and
cleanup cases, exact CLI argv/environment/hash checks, malformed/oversized/unsanitized output cases,
and per-invocation executable revalidation mandatory rather than regular-suite capability skips.

Concurrency and one-minute rate accounting are deliberately process-local. A backend restart
releases all slots and rate history;
interrupted work is not recovered or retried, and any uncertain native/filesystem boundary is
reported as `native_outcome_unknown`. An unconfigured export uses an unavailable adapter; a fully
configured export that cannot initialize safely fails plugin startup with a sanitized diagnostic.
Non-Linux and non-x64 secure destination implementations remain uncertified until their platform
race matrices are implemented; unsupported architectures are excluded by package metadata.
