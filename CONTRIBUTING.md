# Contributing

OpenCode Agent Communicator is created and maintained by Yidi Sprei
([@YidiDev](https://github.com/YidiDev)). Original project work is MIT licensed.

By submitting a contribution, you offer it under the project's MIT license and
confirm that you have the right to do so. You retain copyright in your work;
contributing does not assign it to the maintainer. Do not remove upstream notices
or contribute code with incompatible or unknown licensing. Identify copied or
adapted material, its source, and its license in the pull request.

Use Conventional Commits and focused pull requests. Include regression tests for
bug fixes and public documentation for behavior changes. Follow `AGENTS.md` and
`DEVELOPMENT.md`; do not weaken fencing, privacy, failure classification, test
skips, or coverage gates to make a check pass.

Run `bun install --frozen-lockfile`, `bun run check`, both coverage commands,
`bun run check:licenses`, `bun run check:security`, `bun run verify:package`, and applicable acceptance
suites. Live tests must be isolated from your active OpenCode installation.

Use issues for reproducible bugs and feature proposals. Use the private reporting
instructions in `SECURITY.md` for sensitive vulnerabilities. Never attach private
transcripts, credentials, communicator databases, or unsanitized logs.

Automation changes use their real bot identity, not the maintainer's identity.
The maintainer reviews release pull requests; publishing authority belongs only
to the exact npm trusted-publisher workflow and protected release environment.
