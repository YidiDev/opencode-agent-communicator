# Tokenless free-model evaluation

Run manually from the repository root:

```sh
bun test/model-eval/run.ts
```

The harness fetches the live Zen model catalog and intersects it with this reviewed tokenless
allowlist, in preference order:

1. `nemotron-3.5-lightning-free`
2. `mimo-v2.5-free`

`OPENCODE_FREE_MODEL` may select one of those models, but only while it remains in the live catalog.
`MODEL_EVAL_ARTIFACT_DIR` changes the artifact destination. By default artifacts are written to
`model-eval-artifacts`.

One full scenario suite is one provider attempt. A transient network or rate-limit result may use
the second available allowlisted model, for a maximum of two attempts. Behavior failures are never
retried. The process exits successfully only for the `passed` classification.

The managed-request journey accepts a participant that handles its canonical initial request before
the scripted follow-up only when that follow-up cleanly observes an empty inbox and the source later
recovers the exact `[["pass"]]` answer for the same request and acknowledges it. Missing correlation,
unexpected participant tools, and every other incomplete journey remain behavior failures.

The evaluator uses the exact checkout's OpenCode CLI, but loads the plugin from an `npm pack`
archive installed with lifecycle scripts disabled in a clean private consumer. Its OpenCode home,
XDG roots, project, plugin state, and config are temporary and isolated. Authentication content is
the empty JSON object. The saved artifacts are sanitized text and metadata; temporary OpenCode
state and database files are removed rather than copied.
