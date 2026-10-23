# Session export security boundary

`session_export` writes a bounded, versioned, sanitized projection of a visible root's **current
OpenCode model context**. It does not export complete history and is not a workaround for
`session_read` authorization. Both operations use the public OpenCode v2 Effect context; export does
not spawn an OpenCode executable, run a shell, or use a private HTTP transport.

## Export document

The installed JSON document identifies itself as:

```json
{
  "version": 1,
  "kind": "opencode-sanitized-current-context",
  "history_complete": false,
  "projection_version": 1
}
```

It includes bounded communicator source/target metadata and the projected current-context messages.
It excludes user text, reasoning, tool inputs/outputs, and unsupported host fields. Included assistant
text remains untrusted peer content; structural sanitization is not an authorization claim or a
prompt-injection defense.

Unsanitized export is unsupported in the v2 contract. `sanitize: false` and the legacy
`exportUnsanitized` policy are rejected. Static policy defaults allow sanitized self-export and deny
cross-session export and overwrite. OpenCode v2 has no communicator runtime `ask` fallback.

## Bounded acquisition

The adapter pages only through the current-context projection, using the same immutable native page,
message, part, byte, call, and cursor ceilings as `session_read`. Duplicate IDs, cursor loops,
malformed context, changed snapshots, limit exhaustion, deadline expiry, abort, visibility loss, or
ownership loss fail closed. No omitted or compacted history is inferred.

Unlike recent reads, export does not accept a tail that excludes older current-context entries.
If the context exceeds the 512-entry window, export returns `export_limit_exceeded` before creating
an output file. It never silently installs an export of just that window.

The complete encoded document must fit `maximumOutputBytes`. `maximumConcurrent`,
`maximumSourceExportsPerMinute`, and `maximumWorkspaceExportsPerMinute` bound process-local export
work. A backend restart resets only these process-local counters; it does not retry interrupted
export. The deleted CLI exporter fields `maximumStderrBytes`, `maximumDurationMs`, and
`terminationGraceMs` are not part of this boundary and are rejected during configuration parsing.

## Destination containment

The configured export root and every destination parent are opened through retained Linux directory
descriptors with `O_NOFOLLOW`. New directories and parent metadata are flushed. Transcript bytes
exist first in a mode-0600 `O_TMPFILE` inode retained by descriptor.

No-replace installation uses `linkat(AT_EMPTY_PATH)`. An allowed overwrite links the temporary inode
to an unpredictable name in the mode-0700 `.session-export-staging` directory, revalidates the exact
mode-0600 singly linked destination inode, and performs descriptor-relative `renameat2` replacement.
The adapter then verifies the installed inode and flushes directory metadata.

If `O_TMPFILE`, `AT_EMPTY_PATH`, or `renameat2` is unavailable, export fails closed. It never falls
back to a named temporary. Destination traversal is pinned to the export root's Linux mount ID,
device, and filesystem type, so bind-mount and cross-filesystem transitions fail closed.

## Crash recovery

Recovery recognizes only `.session-export-staging` and exact
`.session-export-<32-lowercase-hex>.stage` children. Public destinations cannot use those names.
Cleanup removes only unchanged mode-0600, singly linked regular files owned by the process and at
least 15 minutes old, then flushes the parent directory. It never scans or deletes ordinary exports.

Failure before installation is definite only when temporary cleanup succeeds. Uncertain cleanup,
installation, verification, durability, abort, deadline, or post-effect ownership state returns
`native_outcome_unknown`; the operation is never retried automatically.

## Platform boundary

Secure export supports Linux x64 only. Its lazy FFI boundary trusts only reviewed canonical
root-owned glibc/musl paths and uses retained descriptors. Unsupported architectures, unsafe
filesystems, missing kernel capabilities, symlinks, unsafe ownership or modes, and same-name races
fail closed. A malicious process running as the same OS user remains outside this boundary.

The public tool result contains only the target session ID, relative destination, sanitization mode,
byte count, and SHA-256 digest. It never returns projected content.
