# OpenCode 1.18.21 live-harness evidence

`bun run test:live` is the isolated compatibility check for the pinned
`opencode-ai@1.18.21` development dependency. It does not use a user-installed
CLI, user configuration, credentials, providers, or state.

The test proves the following surfaces against the live binary:

- exact project-local CLI resolution and `--version` output;
- isolated HOME, XDG, and temporary paths with user project configuration,
  external skills, model catalog fetches, and auto-update disabled without
  enabling `OPENCODE_PURE`; required built-in V2 catalog/config plugins remain
  enabled;
- dynamic loopback `serve` startup and exact `/global/health` version;
- black-box unknown tool arguments (1.18.21 preserves undeclared keys through plugin `execute`, so
  composition's strict runtime parser can authoritatively reject them);
- explicit local plugin loading and diagnostic tool registration;
- local OpenAI-compatible streaming tool-call behavior;
- ToolContext identifiers, agent, directory, worktree, abort signal, metadata,
  and approval API availability, plus live allow/deny/ask execution;
- active ToolContext cancellation, the persisted tool result at the cancellation
  boundary, retry status, config-hook skill behavior, and durable replay across
  a process restart;
- native unsanitized and `--sanitize` export envelope, strict pinned schema validation, session
  identity, exact proven `[redacted:session-title:<id>]` /
  `[redacted:session-directory:<id>]` markers, and a live sanitized `import` round trip;
- instance disposal reaching the plugin disposer.
- a separately packed and installed production entry loaded directly, with the exact 14-tool
  manifest, both bundled skills, and successful production disposal. The test invokes every tool
  through the live host. It proves successful list/send/delivery, ask/respond/get/ack, wait/signal,
  and approved start/stop paths; request listing; an authoritative target-role cancel rejection; and
  the exact configured export-unavailable result. Managed start evidence includes deterministic V2
  creation followed by a public title update and blocking initial prompt; the public messages API and
  pinned CLI export both contain the initial user message and assistant response under the requested
  title. Dynamic request, delivery, operation, native message, and session identities are correlated
  across those exact outputs. This does not claim a successful cancel path or secure export, nor
  exhaustive policy/recovery coverage.
- production receives the host's unmodified pinned `PluginInput`; there is no test client `Proxy`,
  fabricated health/list result, or loader wrapper. The exact first host effect is global health via
  a location-free narrow 1.18.21 V2 client. Only after that proof does production construct the
  native adapter and persistent resources. Runtime legacy root listing is reached through a narrow
  pinned adapter because its generated `PluginInput` type omits the method; public title/transcript,
  archive, and V2-only operations use the pinned internal client.

All runtime evidence is written below a mode-0700 temporary root and recursively
removed after the test. This is cleanup, not a forensic secure-erasure claim.
The committed test and this capability summary contain
no captured transcript, raw workspace path, credential, or generated export.
Live tests are intentionally excluded from normal tests and coverage.

The V2 prompt error declaration/source pins definitive pre-admission rejection to exact 400
`InvalidRequestError`, 401 `UnauthorizedError`, and target-correlated 404
`SessionNotFoundError` tuples. A no-admission rejection is not currently feasible to induce in the
isolated live harness. That classification is therefore declaration/source-bound rather than
live-proven; 409 conflicts and every unlisted, mismatched, or proxy-like response remain unknown.

## Phase 0 native-session capability matrix

`test/live/phase0-native-session.test.ts` uses the project-local
`@opencode-ai/sdk@1.18.21` V2 client and the same project-local 1.18.21 CLI.
Provider turns, durable events, V2 active state, and the pre-network steer race
have explicit gates; the test contains no timing sleeps.

### Required initialization

V2 execution is not valid until all of these location-scoped prerequisites are
complete:

1. Initialize the isolated Git project.
2. Call legacy `project.current()` for the configured directory.
3. Call `tool.ids()` and verify the explicit diagnostic plugin is visible.
4. Resolve V2 location, agents, and models, and verify the configured model is
   present before creating or prompting a V2 session.
5. Supply V2-native `agents` and `providers` configuration through
   `OPENCODE_CONFIG_DIR/opencode.json`. The legacy `OPENCODE_CONFIG` document
   alone does not populate the V2 model catalog.
6. Keep required built-in catalog/config plugins enabled. Network model catalog
   refresh remains disabled; the deterministic model endpoint is loopback-only.

This matrix is normative only with those prerequisites. IDs, sequence numbers,
timestamps, paths, titles, and transcript text below are symbolic.

| Capability | Deterministic live result | Adapter consequence |
| --- | --- | --- |
| V2 caller session ID | Create returns HTTP 200 with the supplied ID. Repeating the same body and ID returns 200 with that ID. The alternate location is separately Git-initialized and resolved through V2; its alternate agent and model are present in their location-scoped lists. A distinct control create using the complete alternate agent/model/location payload succeeds and is retrieved unchanged. Reusing that proven-valid complete payload with the original ID still returns HTTP 200 and an object exactly equal to the original; a subsequent get is unchanged. | Create is first-write-wins by ID in 1.18.21. A conflicting retry is not rejected and does not update the session, so callers must compare the returned canonical payload instead of treating 200 as proof that the requested payload won. |
| Legacy/V2 identity and title | Both listings contain the same root ID. A legacy title update is visible through V2 listing. | Session ID is canonical across adapters; legacy title update is usable. |
| Root/child/archive | Legacy `roots:true` excludes a child. Experimental `archived:false` excludes an archived root and `archived:true` returns its exact timestamp. | Root and archive filtering are proven on these surfaces. |
| Legacy-owned status | During a gated legacy provider turn, legacy status is `{type:"busy"}` and V2 active omits the session. After completion, both omit it. | Legacy status and V2 active describe different execution owners. |
| Legacy retry status | An explicitly observed first loopback provider request receives HTTP 503 with `retry-after-ms: 60000`. Before any second request, legacy status is `{type:"retry",attempt:1,message:"phase0 deterministic retryable 503",next:<epoch ms>}`. `next` is within 2 seconds of the request receipt time plus the advertised 60 seconds. Aborting returns true and removes the status. The wait uses a real monotonic deadline, not a fixed scheduler-turn count. | Retry is a live legacy drain state. Observe it on legacy status; do not infer it from V2 active or wall-clock sleeps. |
| V2-owned status | During a gated V2 provider turn, V2 active is `{sessionID:{type:"running"}}` while legacy status omits the session. After the final step, V2 active omits it. | Use V2 active for V2 drains and legacy status for legacy drains; do not merge them as equivalent maps. |
| Admission response | Queue admission contains exactly `admittedSeq`, caller `id`, `sessionID`, `prompt`, `delivery`, and `timeCreated`; `promotedSeq` is absent from the immediate response. | HTTP success proves admission only. |
| Idle queue wake | A queue admission to an initialized idle V2 session emits admitted then prompted, starts a provider turn containing the exact prompt marker, and appears in V2 active separately from admission. | Queue wake of an idle V2 session is proven; the earlier blocker was a fixture initialization defect. |
| FIFO | Three queue inputs execute through three separately gated provider turns. Admission sequence, durable promotion sequence, and provider request sequence are all FIFO. | Native queue ordering is usable. |
| Active steer | Steer during a V2-owned active turn is admitted immediately, promotes after the current step, and executes in the next gated provider turn with `delivery:"steer"`. | Active steer is proven against V2 active state. |
| Busy-to-idle race | The steer HTTP request is held before network submission; the original V2 step ends and inactive state is observed first. Releasing the request returns HTTP 200, preserves `delivery:"steer"`, wakes a new V2 drain, emits admitted/prompted, and executes. | In 1.18.21, raced steer is accepted and can wake idle execution; do not translate it to queue or report a conflict. |
| V2 interrupt | Idle interrupt returns 204. Active interrupt returns 204, cancels the gated provider response, and V2 active becomes absent. | Native interrupt of a V2-owned drain is proven. |
| Queue survival across interrupt | Two queue inputs admitted behind the interrupted turn survive. A later queue trigger wakes the session; the survivors execute before the trigger in FIFO order. | Interrupt does not retract admitted queue entries. |
| Event correlation | Admitted and prompted events carry exact session ID, caller message ID, prompt, delivery, timestamp, and durable sequence. | Admission and promotion are exactly correlatable. |
| ToolContext.ask allow | After the tool has invoked `context.ask`, the legacy permission list contains no request for its session. `permission:"live_allow"` resolves and the tool part completes with its exact returned output. | A configured allow rule does not expose a pending approval at the observed ask boundary. |
| ToolContext.ask deny | `permission:"live_deny"` rejects with the native configured-rule message, including the effective wildcard allow and specific deny rules. The tool part persists as `status:"error"` with that exact message and no pending request remains. | Denial is an exception from `ask`; tools must not perform the protected action before it resolves. |
| ToolContext.ask ask | `permission:"live_ask"` blocks and is listed by the legacy permission API. The request preserves both patterns, the `always` pattern, nested metadata, session ID, tool message ID, and exact provider call ID `call_live_diagnostic`. That ID also matches the persisted tool part and the follow-up provider request's `tool_call_id`. Replying `once` returns HTTP 200, resolves `ask`, and persists the exact tool output. | Approval correlation is exact from provider tool call through pending request, persisted part, and provider result turn. Use the legacy permission surface for this legacy ToolContext request; V2 resource terminology must not be substituted for its `patterns`/`always` fields. |

| ToolContext abort | The tool records the live ToolContext signal as exactly `false` before interruption and exactly `true` after legacy session abort. The cooperative diagnostic tool then returns `tool-observed-abort`, and 1.18.21 persists that invocation as `status:"completed"` with that output (not `Cancelled`). | AbortSignal is active, but abort is cooperative and does not guarantee an error result. Treat the persisted tool part as authoritative and make side-effecting tools abort-aware. |
| Execution-start evidence | Three `session.next.step.started` events are observed, but they identify assistant message IDs and contain no admitted caller message ID. Provider gates prove execution of marker text, but no native event exactly links execution start to an admitted input ID. | Omit a native `started` delivery state; promotion remains the strongest exact native input correlation. |
| Restart/cursor replay | After the serving process exits and a new exact 1.18.21 process opens the same isolated state, `session.events({after:String(seq)})` replays the next durable event exclusively. A subscription opened at the current sequence then receives a newly admitted event live with the admission sequence. | Persist a sequence per session aggregate and resubscribe with it after restart. Replay and live continuation are one stream, but consumers still need deduplication at their durable checkpoint boundary. |
| Finite history/reconciliation | `session.history({after,limit:1})` returns one event after the exclusive sequence; history at the latest sequence is empty. For the known aggregate, `sync.history.list({body:{[knownSession]:cursor}})` returns a sequence list exactly equal to complete post-restart session history after that cursor, every sequence is greater than the cursor, and the observed range is contiguous through the live admission. An omitted aggregate receives full history including sequence 1. | There is no single global durable cursor. Reconciliation state is an aggregate-ID-to-sequence map; accidentally omitting a known aggregate requests its complete history. Bound and persist the map externally. |
| Fixture failure cleanup | `createIsolatedOpenCodeState` wraps every operation after temporary-root creation and recursively removes that root on failure while preserving the original failure. A deterministic injected failure after private-directory creation proves both error identity and root absence. Fixture setup also tracks provider, isolation, and server incrementally. A readiness failure terminates the launched server before propagation; every setup, test, and close failure path independently attempts server, provider, and isolation cleanup while preserving the first failure. | Live evidence must not leak processes or private roots, and cleanup errors must not mask the causal test/setup failure. |
| Config-hook `skills.paths` | The plugin config hook runs in the correct process and appends the exact private skill root. The legacy `app.skills` list discovers the hooked skill with its exact name, description, and `SKILL.md` location. A statically configured control skill is also present. The separate V2 location-scoped skill list contains neither one. | Config-hook registration works for the 1.18.21 legacy/runtime skill registry. Verify with `app.skills`; do not use `v2.skill.list` as its registration check or assume the two registries are equivalent. |
| Subscription/server disposal | Explicit iterator return yields `done:true`; restarted `instance.dispose()` returns true. The companion test correlates plugin disposal to process and instance identity. Session abort does not dispose the server, while process/instance disposal is a separate boundary. | Consumer, execution, server, and plugin disposal must be managed separately. |

### Participant deletion and admission reconciliation

The pinned `@opencode-ai/plugin` 1.18.21 hook consumes the legacy SDK `Event` union. Its
authoritative deletion member is exactly `type: "session.deleted"` with
`properties: { info: Session }`; `Session` carries `id`, `projectID`, `directory`, optional
`parentID`, and the remaining session metadata. It carries **no native message ID and no admission
or promotion sequence**. Production therefore uses this event only as deletion evidence after
strict data-only shape, project/directory binding, root identity, and bounded session-ID checks.

The exact live harness also proves the stronger anti-entropy primitive used when a hook is missed:
`v2.session.get({sessionID})` returns HTTP 200 with the same ID for an archived root even though the
root is absent from the visible-root list. The same archived root remains directly retrievable from
a client bound to the fixture's alternate location. After authoritative legacy deletion, both
location bindings return HTTP 404 with exactly `_tag`, `message`, and the requested `sessionID` in a
`SessionNotFoundError`, and no data. Production classifies only that correlated direct 404 as
`absent`; list omission, malformed responses, transport failures, and uncorrelated errors are
`unknown`.

No request delivery promotion is inferred from deletion timing or event order. A submission with
authoritative admission response remains `admitted` (or `promoted` when that response itself
contains both sequences); an ambiguous submission remains `delivery_unknown`. This is deliberately
conservative: correlating a `session.deleted` event to a request would invent evidence absent from
the pinned native event and could incorrectly promote an unadmitted request.

### Exact observed shape templates

Successful admission:

```json
{
  "data": {
    "admittedSeq": "<integer>",
    "id": "<caller-message-id>",
    "sessionID": "<session-id>",
    "prompt": { "text": "<text>" },
    "delivery": "queue | steer",
    "timeCreated": "<integer>"
  }
}
```

Correlated durable events:

```json
{
  "type": "session.next.prompt.admitted | session.next.prompted",
  "durable": { "aggregateID": "<session-id>", "seq": "<integer>", "version": "<integer>" },
  "data": {
    "timestamp": "<integer>",
    "sessionID": "<session-id>",
    "messageID": "<caller-message-id>",
    "prompt": { "text": "<text>" },
    "delivery": "queue | steer"
  }
}
```

Pending ToolContext approval (symbolic IDs, exact field names):

```json
{
  "id": "<permission-request-id>",
  "sessionID": "<session-id>",
  "permission": "live_ask",
  "patterns": ["resource:ask:primary", "resource:ask:secondary"],
  "always": ["resource:ask:*"],
  "metadata": { "proof": "phase0", "mode": "ask", "nested": { "ordinal": 21 } },
  "tool": { "messageID": "<assistant-message-id>", "callID": "<tool-call-id>" }
}
```

### Conservative limits and negative evidence

- No native event links `session.next.step.started` to the admitted caller
  message ID; provider marker evidence is exact for the harness but is not a
  native execution-start correlation contract. The installed V2 SDK event type
  likewise exposes the assistant step data rather than an admitted input ID.
- Config-hook skill registration is visible through `app.skills` but not
  `v2.skill.list`, including for a pre-start `skills.paths` control. The
  installed declarations expose both list APIs without claiming they are the
  same registry. The conservative implementation consequence is to register
  the path through the hook, verify the runtime registry through `app.skills`,
  and never infer failure from the unrelated V2 list.
- Session event replay is aggregate-local. The installed SDK contract describes
  `session.history` as a finite page and `session.events` as replay-then-live;
  `sync.history.list` explicitly says omitted aggregates receive full history.
  Therefore the communicator must own durable per-aggregate checkpoints,
  bounded reconciliation, and deduplication. OpenCode does not supply a global
  durable consumer cursor.
- The generated SSE iterator declaration describes an SSE envelope while the
  exact 1.18.21 client yields decoded durable event objects for this endpoint.
  The proof accepts and validates the observed decoded form without weakening
  durable event assertions; adapter code must remain pinned and contract-tested.
