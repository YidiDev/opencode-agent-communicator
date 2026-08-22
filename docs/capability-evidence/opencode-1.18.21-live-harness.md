# OpenCode 1.18.21 live-harness evidence

`bun run test:live` is the isolated compatibility check for the pinned
`opencode-ai@1.18.21` development dependency. It does not use a user-installed
CLI, user configuration, credentials, providers, or state.

The test proves the following surfaces against the live binary:

- exact project-local CLI resolution and `--version` output;
- isolated HOME, XDG, and temporary paths with project/default plugins, model
  catalog fetches, and auto-update disabled without enabling `OPENCODE_PURE`;
- dynamic loopback `serve` startup and exact `/global/health` version;
- explicit local plugin loading and diagnostic tool registration;
- local OpenAI-compatible streaming tool-call behavior;
- ToolContext identifiers, agent, directory, worktree, abort signal, metadata,
  and approval API availability;
- native unsanitized and `--sanitize` export envelope and session identity;
- instance disposal reaching the plugin disposer.

All runtime evidence is written below a mode-0700 temporary root and recursively
removed after the test. This is cleanup, not a forensic secure-erasure claim.
The committed test and this capability summary contain
no captured transcript, raw workspace path, credential, or generated export.
Live tests are intentionally excluded from normal tests and coverage.
