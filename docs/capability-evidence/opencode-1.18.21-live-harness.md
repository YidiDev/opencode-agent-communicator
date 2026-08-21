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
| V2 caller session ID | Create returns HTTP 200 with the supplied ID. Repeating the same body and ID returns 200 with that ID. Conflicting duplicate bodies remain untested. | Same-input create recovery is available. |
| Legacy/V2 identity and title | Both listings contain the same root ID. A legacy title update is visible through V2 listing. | Session ID is canonical across adapters; legacy title update is usable. |
| Root/child/archive | Legacy `roots:true` excludes a child. Experimental `archived:false` excludes an archived root and `archived:true` returns its exact timestamp. | Root and archive filtering are proven on these surfaces. |
| Legacy-owned status | During a gated legacy provider turn, legacy status is `{type:"busy"}` and V2 active omits the session. After completion, both omit it. | Legacy status and V2 active describe different execution owners. |
| V2-owned status | During a gated V2 provider turn, V2 active is `{sessionID:{type:"running"}}` while legacy status omits the session. After the final step, V2 active omits it. | Use V2 active for V2 drains and legacy status for legacy drains; do not merge them as equivalent maps. |
| Admission response | Queue admission contains exactly `admittedSeq`, caller `id`, `sessionID`, `prompt`, `delivery`, and `timeCreated`; `promotedSeq` is absent from the immediate response. | HTTP success proves admission only. |
| Idle queue wake | A queue admission to an initialized idle V2 session emits admitted then prompted, starts a provider turn containing the exact prompt marker, and appears in V2 active separately from admission. | Queue wake of an idle V2 session is proven; the earlier blocker was a fixture initialization defect. |
| FIFO | Three queue inputs execute through three separately gated provider turns. Admission sequence, durable promotion sequence, and provider request sequence are all FIFO. | Native queue ordering is usable. |
| Active steer | Steer during a V2-owned active turn is admitted immediately, promotes after the current step, and executes in the next gated provider turn with `delivery:"steer"`. | Active steer is proven against V2 active state. |
| Busy-to-idle race | The steer HTTP request is held before network submission; the original V2 step ends and inactive state is observed first. Releasing the request returns HTTP 200, preserves `delivery:"steer"`, wakes a new V2 drain, emits admitted/prompted, and executes. | In 1.18.21, raced steer is accepted and can wake idle execution; do not translate it to queue or report a conflict. |
| V2 interrupt | Idle interrupt returns 204. Active interrupt returns 204, cancels the gated provider response, and V2 active becomes absent. | Native interrupt of a V2-owned drain is proven. |
| Queue survival across interrupt | Two queue inputs admitted behind the interrupted turn survive. A later queue trigger wakes the session; the survivors execute before the trigger in FIFO order. | Interrupt does not retract admitted queue entries. |
| Event correlation | Admitted and prompted events carry exact session ID, caller message ID, prompt, delivery, timestamp, and durable sequence. | Admission and promotion are exactly correlatable. |
| Execution-start evidence | Three `session.next.step.started` events are observed, but they identify assistant message IDs and contain no admitted caller message ID. Provider gates prove execution of marker text, but no native event exactly links execution start to an admitted input ID. | Omit a native `started` delivery state; promotion remains the strongest exact native input correlation. |
| Subscription/server disposal | The exact SDK event generator returns `done:true`; `instance.dispose()` returns true. The companion test correlates plugin disposal to process and instance identity. | Consumer, server, and plugin disposal are proven. |

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

### Remaining deterministic gaps

- Legacy retry status still needs a provider gate that controls the native
  retry scheduler without wall-clock assertions.
- No native event links `session.next.step.started` to the admitted caller
  message ID; provider marker evidence is exact for the harness but is not a
  native execution-start correlation contract.
- Duplicate session IDs with conflicting model, agent, or location remain
  untested.
- Restart and event resubscription from a durable cursor remain separate Phase
  0 work.
