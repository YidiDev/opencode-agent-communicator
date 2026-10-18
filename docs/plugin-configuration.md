# Plugin configuration

The plugin accepts a strict options object. Unknown keys, relative paths, and values above compiled
safety ceilings stop startup before the SQLite store opens.

```json
[
  "file:///home/operator/.local/share/opencode-agent-communicator/v0.7.4/node_modules/opencode-agent-communicator/src/index.ts",
  {
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
]
```

## Runtime and registration

The supported runtime is Linux x64, Bun `1.4.0`, and stable OpenCode `>=2.0.26 <2.1.0`.
OpenCode loads the plugin through its public v2 Effect API. The entrypoint uses `Plugin.define`,
publishes all 21 tool IDs atomically through `tool.transform`, registers the three bundled skills
through `skill.transform`, and owns event/context subscriptions in the plugin scope. The plugin does
not start a server or use a private HTTP transport.

`stateDirectory` must be a normalized absolute private local path. When omitted, it derives from
`XDG_STATE_HOME` or `$HOME/.local/state`. The store verifies ownership, permissions, no-follow
traversal, and filesystem support. Package metadata also rejects non-Linux and non-x64 installation.

## Static policy

Every policy value is either `allow` or `deny`. OpenCode v2 does not provide the imperative approval
contract used by earlier communicator releases. A legacy `ask` value is a configuration error rather
than an implicit allow, prompt, or fallback.

| Policy | Default |
| --- | --- |
| `message`, `ask`, `wait` | `allow` |
| `readCrossSession`, `start`, `stop` | `deny` |
| `exportSelfSanitized` | `allow` |
| `exportCrossSession`, `exportOverwrite` | `deny` |

Sensitive actions are therefore deny-by-default. Enable only the exact capability you intend to
grant. Explicit start agent/model overrides remain subject to exact allowlists even when `start` is
`allow`. Unsanitized export is unsupported; `exportUnsanitized` and `sanitize: false` are rejected.

## Deadlines and bounds

`invocationDeadlineMs` is finite and at most one hour. Blocking `session_ask` and `session_wait`
extend their internal boundary when necessary to contain the requested timeout, a 30-second
pre-persistence margin, and a 30-second terminal-settlement margin. The invocation abort signal is
the explicit cancellation boundary.

`session_read` has immutable 100-default/500-maximum line limits, a 65,536-byte result cap, bounded
native calls and data examination, and opaque cursors. Its source is OpenCode's current model-context
snapshot, not complete transcript history. Cross-session read requires `readCrossSession: "allow"`;
there is no runtime approval prompt.

`session_list` reads at most the compiled participant-registry ceiling, then revalidates every
candidate through the public ID-addressed v2 session API. Registry presence is discovery evidence,
not current visibility or authorization. Missing, malformed, foreign, child, or no-longer-visible
candidates are omitted.

Export remains registered when `export.root` is omitted and then returns `export_unavailable`.
Configured export writes a bounded, versioned, sanitized current-context projection through the
Linux descriptor-relative destination boundary. It does not require an OpenCode executable or spawn
a subprocess. The only export limit keys are `maximumOutputBytes`, `maximumConcurrent`,
`maximumSourceExportsPerMinute`, and `maximumWorkspaceExportsPerMinute`. Removed CLI-process fields
`maximumStderrBytes`, `maximumDurationMs`, and `terminationGraceMs` are rejected as unknown keys
rather than accepted without effect.

Start operation count and retained private-payload bytes are hard admission quotas. Ambiguous creates
use the separate `unresolvedProvenancePerWorkspace` quota. Exact public v2 revalidation may confirm a
matching root; uncertain absence remains unresolved and is never treated as permission to retry.
