# Development Conventions

This document is the normative engineering guide for OpenCode Session
Communicator. `PLAN.md` defines product behavior and architecture; this document
defines how the implementation is built and maintained.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are used in
their ordinary RFC 2119 sense. A rule marked MUST is enforced by tooling where
practical and otherwise during review.

## 1. Priorities

### OpenCode 2.1.3 compatibility evidence (#49)

The isolated v0.8.0/2.0.26 control passed (2 tests, 35 assertions). One earlier control run failed
during ownership startup; that result is not evidence that the prolonged-runtime issue #46 is fixed.
With OpenCode 2.1.3, both the released source and the configured pre-release migration artifact were
omitted when configured as `src/index.ts` files. The host's diagnostic was
`configured plugin path must be a directory`. Pointing those artifacts to their `src/` directories
instead produced failed registry entries with the old `>=2.0.26 <2.1.0` version-guard diagnostic.
Source resolution and host compatibility are separate boundaries.

The new packed tests load the actual installed `src/` directory, with no wrapper module. Exact
`@opencode/plugin@2.1.3` declarations and `@opencode/client` operations were checked for Effect-scoped
acquisition/finalization, tool/skill transforms, primary tool options, context hooks, event envelopes,
root identity and timestamps, fixed-ID creation/update, queue admission, interrupt, typed absence,
and current-context projection. The existing adapter shapes typecheck with aligned Effect `4.0.1`;
live completed results and the existing adversarial regressions remain required beyond typechecking.
Public `session.list` is now available, but the plugin context has no authoritative current-activity
query. Registry-driven discovery and explicit unsupported context/stop results are retained.

Support is deliberately narrowed to stable `>=2.1.3 <2.2.0`; this change does not certify the old
2.0/Effect-RC combination. The minimum and build-time host coincide. A later compatibility release,
side-by-side immutable installation, coordinated service restart, and actual-environment smoke test
are separate from isolated acceptance. Do not publish to npm or restart the active shared service
as part of a compatibility test. Keep #46 open for its independent soak and causal investigation.

When rules compete, use this order:

1. Correctness and preservation of documented invariants.
2. Security and fail-closed behavior.
3. Explicitness at native, storage, filesystem, and authorization boundaries.
4. Testability and deterministic recovery.
5. Cohesion and readability.
6. Reduction in line count or abstraction count.

Passing a size check never justifies splitting one atomic invariant across
several unclear functions. Conversely, a cohesive name does not justify an
unbounded file or function.

## 2. Source Size

### 2.1 Files

- Production source files SHOULD remain at or below 300 physical lines.
- Production source files MUST remain at or below 500 physical lines.
- Test files MUST remain at or below 800 physical lines.
- The 300-line threshold is a review trigger, not an automatic failure.
- Blank lines and comments count because they still affect navigation cost.
- A file SHOULD expose one primary responsibility even when below the limit.

Generated files, immutable database migrations, test fixtures, and platform
test vectors MAY be exempt. Every exemption MUST appear in the central quality
exception allowlist with:

- The exact path.
- The rule being waived.
- Why splitting or regenerating the file is currently worse.
- The condition that will remove the exemption.

Inline linter-disable comments MUST NOT be used to bypass size limits.

### 2.2 Functions

- Cognitive complexity MUST NOT exceed 20.
- Nesting depth SHOULD NOT exceed four blocks.
- Functions MUST NOT exceed 200 physical lines.
- Complexity is the primary constraint; 200 lines is an emergency backstop.
- Functions with more than three conceptual inputs SHOULD accept an argument
  object.
- State transitions and transactions SHOULD remain cohesive when extraction
  would hide ordering, atomicity, or rollback behavior.

Code MUST be extracted by responsibility, not into arbitrary fragments created
only to satisfy a metric.

## 3. TypeScript

The project MUST enable strict TypeScript checking, including:

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "useUnknownInCatchVariables": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "noImplicitReturns": true
}
```

Additional rules:

- `any` MUST NOT be used in production or test code.
- Catch values MUST remain `unknown` until narrowed.
- Unchecked type assertions MUST NOT be used to replace validation.
- Non-null assertions MUST NOT be used in production code.
- `@ts-ignore` MUST NOT be used.
- `@ts-expect-error` MAY be used in a type-level test with a reason.
- Public and persistence-boundary return types MUST be explicit.
- Persistence adapters are internal trusted ports, not public readiness boundaries. Public
  composition MUST complete lifecycle recovery before registering or exposing any tool. Every
  tool-facing application use case MUST also call `CommunicatorReadinessPort.assertReady()` before
  validation or effects.
- Exhaustive discriminated-union switches MUST end in a `never` check.
- IDs MUST use branded types after runtime validation.
- Runtime schemas and TypeScript types MUST come from one canonical definition.
- Optional properties MUST represent true omission; use explicit `null` only
  when null is a meaningful protocol or persisted value.

Default exports are reserved for the plugin entrypoint when OpenCode requires
one. Other modules MUST use named exports.

The production entrypoint MUST use the OpenCode v2 public Effect API: `Plugin.define` with scoped
effects, `tool.transform` for the exact 21-tool manifest, and `skill.transform` for bundled skills.
Production code MUST NOT create or depend on a private OpenCode HTTP transport.

## 4. Naming and API Shape

- Names MUST use complete domain terms rather than unexplained abbreviations.
- Boolean names SHOULD begin with `is`, `has`, `can`, `should`, or `did`.
- Functions that perform external effects SHOULD use verbs that expose the
  effect, such as `admitMessage`, `commitResponse`, or `writeExport`.
- Validation functions SHOULD return a validated type or a typed failure; they
  MUST NOT return a boolean when callers need failure context.
- Time values MUST include their unit in the name unless represented by a
  dedicated type, for example `timeoutSeconds` or `leaseDurationMs`.
- Persisted timestamps MUST use one documented UTC representation.
- Digest fields MUST identify their algorithm in schema or type documentation.
- Public wire names use `snake_case`; internal TypeScript names use
  `camelCase`. Conversion occurs at the boundary.

## 5. Architecture and Imports

Dependency direction MUST be checked in CI.

The intended direction is:

```text
tool handlers -> coordinator/application -> domain contracts and ports
                                           ^
native/store/export adapters ---------------|
plugin entrypoint -> composition only
```

Rules:

- Tool handlers MUST remain thin and MUST NOT access SQLite, the filesystem, or
  OpenCode clients directly.
- Domain contracts, state machines, IDs, and errors MUST NOT import OpenCode,
  Bun, SQLite, or platform filesystem modules.
- Coordinator/application modules MUST depend on typed ports rather than
  concrete adapters.
- Native, store, and export adapters MUST implement ports and MUST NOT import
  tool handlers.
- The plugin entrypoint owns composition and lifecycle wiring, not domain logic.
- Cross-feature imports MUST use a declared public module boundary.
- Internal barrel files MUST NOT be introduced when they obscure dependencies
  or permit cycles.
- Circular imports are prohibited.
- Domain and tool layers MUST treat both current `@opencode/*` and legacy `@opencode-ai/*` package
  imports as OpenCode boundary imports. Only native adapters and composition may import them.
- Classes SHOULD be used only when resource lifetime, identity, or encapsulated
  mutable state requires them. Plain functions and data are preferred.

The import checker is authoritative. Any temporary exception follows the same
central allowlist process as size exceptions.

## 6. Domain Results and Faults

- Expected domain outcomes MUST use the shared discriminated result union.
- Domain failures MUST have stable machine-readable codes and safe messages.
- Exceptions are reserved for programmer errors and unrecoverable system or
  invocation faults.
- Native ambiguity MUST remain explicit and MUST NOT be silently converted into
  success, confirmed failure, cancellation, or retry.
- Sensitive lookups MUST preserve the constant-shape not-found-or-unauthorized
  contract.
- Adapters MUST retain the original fault as an internal cause when wrapping it
  does not expose secrets.
- Tool handlers MUST NOT branch on error message text.

## 7. Side Effects and State

- External input MUST be validated before lookup or effect.
- Every mutating database transaction MUST verify the current fencing token.
- Every native or filesystem effect MUST check ownership and cancellation
  immediately before the effect and check ownership again before recording its
  result.
- Persisted `prepared` state MUST prove an external call has not begun.
- Persisted `submitting` state MUST be treated as ambiguous after process loss
  unless authoritative evidence resolves it.
- Request startup recovery has separate immutable workspace bounds: 1024 pending
  prepared/expiry records and 4096 `delivery_state = submitting` records across
  every resolution state, including terminal metadata.
- Ambiguous external effects MUST NOT be retried automatically.
- Terminal transitions MUST commit before an in-memory waiter resolves.
- Cleanup MUST be idempotent.
- Abort handling MUST preserve the distinction between pre-effect cancellation
  and post-effect ambiguity.
- Functions that can block or perform I/O MUST accept or derive an abort signal
  and a finite deadline.

Raw SQL MUST remain inside store modules. Store APIs SHOULD express domain
operations rather than expose generic query execution.

Database migrations become append-only after merging into the default branch.
A correction requires a new migration rather than editing published history.

## 8. Security and Privacy

- Peer-controlled content is always untrusted, including titles, answers, and
  evidence inside a correctly escaped envelope.
- Authorization MUST be distinct from visibility.
- Workspace identity and participant role MUST be included in persisted-record
  authorization queries.
- Quotas and rate limits MUST be centralized and bounded by immutable hard
  ceilings.
- Logs MUST NOT include message payloads, questions, answers, evidence,
  transcript content, approval secrets, unsanitized titles, or raw workspace
  paths.
- Filesystem access MUST go through the secure path abstraction.
- Process execution MUST use argv without a shell, a minimal environment,
  bounded streams, a deadline, and process-tree cancellation.
- New permissions, external effects, retained sensitive fields, or filesystem
  paths REQUIRE a threat-model review.
- Sensitive operations MUST use deny-by-default static `allow`/`deny` policy. OpenCode v2 has no
  supported imperative approval equivalent; legacy `ask` configuration MUST be rejected.
- Session read and export are bounded, sanitized projections of OpenCode's current model context.
  They MUST NOT claim completeness, history access, or private transcript transport.
- Deletion documentation MUST say logical deletion unless a stronger guarantee
  is independently proven.

## 9. Testing

Tests live in a mirrored tree:

```text
test/
  unit/          # mirrors src/ for pure behavior
  integration/   # real store and adapter boundaries
  black-box/     # packaged plugin behavior
  live/          # isolated supported OpenCode v2 harness
```

### 9.1 Required Practices

- Every behavior change MUST include or update tests.
- Every bug fix MUST include a regression test that fails without the fix.
- Tests MUST be deterministic and independent of execution order.
- Arbitrary sleeps MUST NOT be used for coordination.
- Regular, coverage, and capability test entrypoints use a 15-second per-test ceiling to tolerate
  hosted-runner scheduling and instrumentation overhead without retries. Tests that inherently need
  longer MUST declare their own finite timeout.
- Process-based store acceptance allows 30 seconds for a child process while retaining the
  harness's 120-second per-container kill boundary.
- Clocks, randomness, native APIs, and external effects MUST be injectable at
  the relevant port.
- Unit tests SHOULD test public behavior rather than private implementation.
- Mocks and fakes SHOULD be placed at architectural ports.
- State-machine tests MUST cover every allowed transition and rejected edge.
- Race tests MUST control ordering explicitly through barriers or fakes.
- Security boundary tests MUST include malformed, adversarial, and concurrent
  inputs.
- Snapshot tests MAY supplement but MUST NOT replace semantic assertions.
- Live tests MUST use isolated, project-selected supported OpenCode v2 harnesses and
  MUST NOT alter the user's active OpenCode installation.
- The regular suite has an exact reviewed skip declaration budget enforced by
  `tools/verify-test-skips.mjs`; adding or moving a skip requires explicit review.
- Linux CI MUST run `test:acceptance:secure-export` with the capability requirement enabled. That
  cell runs the two capability acceptance tests, the actual packed OpenCode 2.1.3 loading/start/read/export
  journeys, and `linux-export-destination.test.ts`, including its
  four normally capability-skipped tests. The cell fails when descriptor-backed installation or
  atomic replacement is absent and parses Bun's JUnit report to require exactly zero skipped tests.
  It uses a reviewed Debian container with no network, a read-only root, bounded CPU/memory/PIDs,
  all capabilities dropped except `DAC_READ_SEARCH`, `no-new-privileges`, and a small private tmpfs;
  this is the minimum privilege required for `linkat(AT_EMPTY_PATH)` evidence on hosted runners.

### 9.2 Coverage Gates

Critical modules require at least 95% line coverage and 90% branch coverage:

- State machines and terminal transitions.
- Authorization and approval binding.
- Ownership, fencing, and recovery.
- Quotas and hard ceilings.
- Identifier generation and validation.
- Filesystem containment and process execution.

All other production source requires at least 85% line coverage and 80% branch
coverage. Generated code and unreachable platform branches MAY be excluded only
through the reviewed central allowlist.

The coverage checker treats `src/domain`, `src/application`, and native, store,
and export adapters as critical. `bun run test:coverage:branches` preloads an
Istanbul instrumentation plugin because Bun 1.4.0 LCOV omits branch data. It
writes `coverage/coverage-final.json` and enforces the line and branch
thresholds per runtime-bearing file. Modules containing only erased TypeScript
declarations and type-only imports/exports are identified structurally and
excluded. `bun run test:coverage` remains available to generate LCOV evidence.

Coverage is a backstop, not evidence of correctness. A change with weak
assertions is incomplete even when percentages pass.

## 10. Comments and Documentation

Comments SHOULD explain:

- Why an invariant exists.
- Why operation ordering matters.
- Why a tempting retry or fallback is unsafe.
- Which native or platform guarantee is being relied upon.

Comments MUST NOT restate obvious syntax. Stale comments are defects.

TODOs MUST include a reason and a concrete removal condition. Bare `TODO`,
`FIXME`, and `HACK` markers are prohibited.

Durable architecture decisions that are not fully captured by `PLAN.md` require
a short ADR under `docs/adr/`. ADRs record context, decision, consequences, and
status. They are not used for routine implementation details.

Public behavior changes MUST update relevant documentation in the same commit.

## 11. Dependencies and Tooling

- Runtime and OpenCode dependencies MUST be pinned exactly.
- The lockfile MUST be committed.
- `@opencode/cli` is the only trusted lifecycle dependency; its pinned
  postinstall selects the certified Linux x64 binary used by the live harness.
- New runtime dependencies REQUIRE a documented reason and maintenance/security
  review.
- Platform APIs are preferred over dependencies for small, well-tested tasks.
- Biome owns formatting, import organization, and standard lint rules.
- TypeScript owns static type checking.
- Custom checks own file/function limits, architecture direction, forbidden
  imports, and exception allowlists.
- Developer and CI commands MUST use the same scripts.

The package MUST provide scripts for:

```text
format
format:check
lint
typecheck
check
test
test:unit
test:integration
test:coverage
test:live
```

`check` is the local pre-commit quality gate and MUST run formatting checks,
linting, custom convention checks, type checking, and non-live tests.
Type checking uses `skipLibCheck` because the original OpenCode 2.0.26 package
publishes declarations that fail its own exact-optional constraints; project
source and tests remain fully checked.

## 12. Git and Review

Commits use Conventional Commits:

```text
feat: add visible session query
fix: preserve request result across restart
refactor: isolate native admission adapter
test: cover response and deadline race
docs: define ownership guarantees
chore: update development tooling
build: pin OpenCode SDK packages
ci: enforce architecture boundaries
perf: bound request deadline scans
```

Rules:

- Each commit MUST have one coherent purpose.
- Commits SHOULD be independently understandable and testable.
- Mechanical refactoring MUST NOT be mixed with behavioral changes.
- Commit subjects use imperative mood, lowercase after the type, and no period.
- Commit bodies SHOULD explain non-obvious invariants and tradeoffs.
- Generated output MUST be committed separately from handwritten source when
  doing so improves reviewability.
- Secrets, credentials, personal paths, and machine-specific state MUST never be
  committed.
- History rewriting and force pushing require explicit maintainer coordination.

Before committing, inspect status, the full intended diff, recent history, and
test results. Stage only files belonging to that commit.

Pull requests SHOULD lead with behavioral impact and risk. They MUST identify
test evidence, protocol/schema changes, security implications, known ambiguity,
and follow-up work. Large changes SHOULD be presented as a sequence of coherent
commits rather than one undifferentiated diff.

## 13. Definition of Done

A change is complete only when:

1. Behavior matches `PLAN.md` and any accepted ADRs.
2. Input, authorization, failure, cancellation, and ambiguity paths are handled.
3. Tests cover the behavior and relevant races or adversarial cases.
4. Coverage gates pass for affected modules.
5. Formatting, lint, architecture, size, and type checks pass.
6. Logs and errors contain no sensitive payloads.
7. Documentation and schemas are updated with the implementation.
8. The commit contains only the coherent change being described.

## 14. Changing These Conventions

These rules may evolve when implementation evidence shows a rule is harmful or
insufficient. A change to a hard rule requires:

1. A concrete example from this repository.
2. An explanation of the maintenance, correctness, or security tradeoff.
3. Updated enforcement and tests in the same commit.
4. No silent weakening through an inline suppression.

Prefer changing an incorrect rule openly over accumulating exceptions that make
the documented standard untrue.
