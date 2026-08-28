# OpenCode 1.18.20 negative compatibility backtest

OpenCode `1.18.20` is the first stable patch below the supported floor. It was tested in a detached
worktree at commit `8abe74b2b1494df393b78e20de42fe2dbfead029`, using Bun `1.4.0` and exact
`@opencode-ai/plugin`, `@opencode-ai/sdk`, and `opencode-ai` packages at `1.18.20`. Production code,
the compatibility harness, and host responses were not modified or shimmed.

The exact dependency switch, test, and restoration commands were:

```bash
bun add --no-save --exact \
  @opencode-ai/plugin@1.18.20 \
  @opencode-ai/sdk@1.18.20 \
  opencode-ai@1.18.20
OPENCODE_COMPAT_VERSION=1.18.20 bun run test:live
bun install --frozen-lockfile
```

The five-test suite reported three passes and two failures after 259 assertions:

- The native diagnostic path launched the exact `1.18.20` CLI, exercised its server and plugin, and
  exported a sanitized session. Strict native export validation rejected the resulting envelope as
  `malformed`, so the sanitized export contract required by the communicator is absent.
- The packed production plugin exposed no `session_*` tools. This is the expected fail-closed result
  from the declared `>=1.18.21 <1.19.0` production host gate and is not the basis for the natural
  floor finding.

The same unmodified suite passes all five tests on `1.18.21`. The independent native export failure
on the immediately preceding stable patch therefore establishes `1.18.21` as the natural contiguous
compatibility floor. No older patch can extend that contiguous supported range, so the descending
backtest stopped at `1.18.20`.
