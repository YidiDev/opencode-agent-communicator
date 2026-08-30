# Plugin configuration

The plugin accepts a strict options object. Unknown keys, relative paths, partial export trust
configuration, and values above compiled safety ceilings stop startup before the SQLite store opens.

```json
[
  "file:///home/operator/.local/share/opencode-agent-communicator/v0.5.0/node_modules/opencode-agent-communicator/src/index.ts",
  {
    "stateDirectory": "/home/operator/.local/state/opencode-agent-communicator",
    "startupDeadlineMs": 30000,
    "invocationDeadlineMs": 3600000,
    "policies": {
      "message": "allow",
      "ask": "allow",
      "wait": "allow",
      "start": "ask",
      "exportSelfSanitized": "allow",
      "exportCrossSession": "ask",
      "exportUnsanitized": "ask",
      "exportOverwrite": "ask"
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
      "executable": "/usr/bin/opencode",
      "trustedWorkingDirectory": "/var/empty",
      "limits": {
        "maximumOutputBytes": 16777216,
        "maximumStderrBytes": 16384,
        "maximumDurationMs": 30000,
        "maximumConcurrent": 2,
        "terminationGraceMs": 500,
        "maximumSourceExportsPerMinute": 4,
        "maximumWorkspaceExportsPerMinute": 16
      }
    }
  }
]
```

`stateDirectory` must be an absolute private local Linux x64 host path. When omitted, it derives from
`XDG_STATE_HOME` or `HOME/.local/state`, outside the workspace; the store verifies ownership,
permissions, no-follow traversal, and filesystem support. This implementation fails closed on any
runtime other than Linux x64 before it opens the state store. Linux ARM64 and all other CPU
architectures are outside the certified `0.5.0` package scope; package metadata also restricts
installation to x64. Install the immutable private Git release externally with npm, then configure
its absolute `file://` source entry; OpenCode `1.18.x` does not reliably populate its cache directly
from a private `git+ssh` spec. Bun `1.4.0` remains the exact development and verification target.
OpenCode executes plugins in its own embedded Bun, which is not the external npm installer.

`invocationDeadlineMs` remains the finite per-invocation duration (default and maximum one hour).
For blocking `session_ask` and `session_wait` only, it is a floor: the plugin extends the internal
invocation when necessary so a request timeout through 3600 seconds has a 30-second bounded
pre-persistence external-I/O margin and a separate 30-second terminal-read/cleanup margin. A request
is not persisted unless its deadline plus the cleanup margin is strictly inside the invocation
boundary.
`ToolContext.abort` remains the only explicit action that durably cancels the request.

Export remains registered when its three trust fields are omitted or its secure adapter cannot be
opened. Only `session_export` then returns `export_unavailable`; the other 20 tools remain
available. The executable must report a stable version in `>=1.18.21 <1.19.0` and satisfy the
root-owned OpenCode trust checks. No shell is used.

Stop has no configurable bypass and is always narrowed to `ask` by the mandatory permission hook.
Explicit start agent/model overrides remain subject to exact allowlists even when start policy is
`allow`.

The established `allowManagedSessionRecursion` and `managedSessionsPerWorkspace` names refer to
sessions created and tracked through `session_start`. This provenance supports idempotency, quotas,
recovery, and chained-start policy; it does not make one session the supervisor of another. Started
sessions remain independent roots with their own instructions, permissions, and judgment.

Advisory locks have no configuration switch or policy bypass. Any current visible root may list and
publish workspace locks; only their holder may renew or release them. Locks are advisory and do not
enforce exclusion or grant authorization. Their TTL, UTF-8 field bounds, list limits, and 1024-active
workspace quota are immutable compiled safety policies documented in the README.

`session_read` also has no configuration override in this release. The current visible root may read
its own bounded projection; reading another current visible root always requests exact
per-invocation approval. Projection version, approval binding, repeated visibility checks, 100/500
line limits, 4,096-byte rendered-line cap, 65,536-byte content cap, 4,096-character public cursor,
8-message native pages, 96 transcript page/fixed-message calls, 512 examined messages, 4 MiB transcript-response cap before
deserialization, and 512-character native cursors are immutable compiled policies. See
[Session read security](session-read-security.md).

Start operation count and retained private-payload bytes are hard admission quotas below immutable
compiled ceilings. Denied and approval-rejected starts keep only payload-free idempotency metadata
for `terminalRetentionMs`; fenced startup and recurring maintenance then collect it in bounded
batches. Start rate events are collected after `rateWindowMs`. A same-source retry with the same key
and arguments is deterministic while its terminal metadata remains retained.

Ambiguous creates use a separate `unresolvedProvenancePerWorkspace` quota (default 16, immutable
ceiling 128), not the ordinary active communicator-started session quota. Reaching it returns
`unresolved_provenance_quota_exceeded` so an operator can investigate native state. Startup and
same-key retries only read the fixed native session ID: an exact root match confirms provenance,
proven stable absence or an identity collision releases the reservation, and an uncertain read
remains unresolved. In the pinned adapter, an exact 404 after submission remains uncertain because
there is no bounded native proof that a delayed create cannot still commit. The create call is never retried.
