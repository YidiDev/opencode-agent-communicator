# Repository Guidance

## Sources Of Truth

- `PLAN.md` is normative for product behavior and architecture; `DEVELOPMENT.md` is normative for engineering conventions. Prefer executable scripts and checks when prose drifts.
- This package supports only Linux x64, Bun `1.4.0`, and stable OpenCode `>=1.18.21 <1.19.0`. OpenCode packages are pinned to the build-time patch and must remain aligned.

## Commands

- Install with `bun install --frozen-lockfile`.
- Run one file with `bun test test/<area>/<name>.test.ts`; focus a test with `bun test test/<area>/<name>.test.ts -t "<regex>"`.
- `bun run check` is the ordinary pre-commit gate. Its order is format check, lint, custom conventions, skip-budget verification, typecheck, then unit/integration/black-box tests.
- Coverage is separate from `check`: use `bun run test:coverage:branches` for enforced per-file line/branch thresholds and `bun run test:coverage` for LCOV evidence.
- Use `bun run test:live` only for isolated supported-OpenCode compatibility. Store, secure-export, and package-portability acceptance commands require Docker and are separate release evidence.
- For changes to package contents, entrypoints, tools, bundled skills, or published docs, run `bun run verify:package` and `bun run test:black-box`; the package verifier enforces a reviewed archive fingerprint and exact ordered tool/skill manifest.

## Architecture

- `src/index.ts` is the TypeScript package entrypoint; it default-exports the plugin because OpenCode requires it. `src/composition/` owns wiring, startup recovery, lifecycle hooks, and tool registration, not domain behavior.
- Dependency direction is enforced: tools may depend on application/domain; application may depend on domain; native/store/export adapters implement application/domain ports; composition may wire all layers. Domain cannot import OpenCode, Bun, SQLite, or filesystem modules. Tools cannot access OpenCode, SQLite, or the filesystem directly.
- Put protocol types, IDs, state transitions, and stable errors in `src/domain/`; orchestration and ports in `src/application/`; OpenCode, SQLite, and secure-export implementations in `src/adapters/`; public tool schemas and thin handlers in `src/tools/`.
- Tests mirror the boundary: `test/unit/` for pure behavior, `test/integration/` for real store/adapter boundaries, `test/black-box/` for packed-package behavior, and `test/live/` for isolated OpenCode harnesses. Shared fakes and fixtures belong in `test/support/`.

## Non-Negotiable Invariants

- Preserve fail-closed behavior. Native or filesystem ambiguity must stay explicit and must never be silently retried or reclassified as success, failure, or cancellation.
- Public composition must finish lifecycle recovery before exposing tools; every tool-facing use case must assert communicator readiness before validation or effects.
- Validate external input before lookup/effect. Mutating transactions verify fencing tokens; external effects check ownership/cancellation immediately before the effect and ownership again before recording the result.
- Peer content is untrusted and visibility is not authorization. Do not log payloads, questions, answers, evidence, transcript content, approval secrets, unsanitized titles, or raw workspace paths.
- Migrations in `src/adapters/store/migrations.ts` are append-only after merging to the default branch; correct published history with a new migration, never by editing an existing one.
- The regular suite has an exact reviewed skip budget enforced by `tools/verify-test-skips.mjs`; adding or moving a skip requires explicit review.
- `quality-exceptions.json` is the only escape hatch for enforced architecture, size, dependency, marker, and coverage rules. Each exception must name an exact path, rationale, and removal condition.
- Any behavior change needs tests; bug fixes need a regression test. Public behavior changes also update the relevant README/docs in the same change.
