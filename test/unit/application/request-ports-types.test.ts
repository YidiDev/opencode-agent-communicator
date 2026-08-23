import { expectTypeOf, test } from "bun:test";

import type {
  AcknowledgeRequestResult,
  CancelPendingResult,
  ExpireAvailableResultsResult,
  ParticipantRequestGet,
  ParticipantRequestMetadata,
  RequestMetadataAtResolution,
  RequestTerminalWriteResult,
} from "../../../src/application/request-ports";
import type {
  AnsweredAskRequestMetadata,
  AskRequestPayload,
  AskRequestResult,
  PendingRequestMetadata,
  ReachedWaitRequestMetadata,
  RequestAvailableResultMetadata,
  RequestExpiredResultMetadata,
  RequestMetadata,
  WaitRequestPayload,
  WaitRequestResult,
} from "../../../src/domain/request-types";

test("request terminal ports reject contradictory state correlations", () => {
  type ContradictoryTerminalState = {
    readonly ok: true;
    readonly outcome: "terminal_state";
    readonly resolutionState: "answered";
    readonly request: RequestMetadataAtResolution<"reached">;
  };
  type ContradictoryCancellation = {
    readonly ok: true;
    readonly outcome: "applied";
    readonly resolutionState: "cancelled";
    readonly request: RequestMetadataAtResolution<"deadline_expired">;
  };
  expectTypeOf<ContradictoryTerminalState>().not.toExtend<CancelPendingResult>();
  expectTypeOf<ContradictoryCancellation>().not.toExtend<CancelPendingResult>();
});

test("acknowledgement and expiry successes cannot contain pending requests", () => {
  type PendingAcknowledgement = {
    readonly ok: true;
    readonly outcome: "applied";
    readonly request: PendingRequestMetadata;
  };
  type PendingExpiry = { readonly ok: true; readonly requests: readonly PendingRequestMetadata[] };
  expectTypeOf<PendingAcknowledgement>().not.toExtend<AcknowledgeRequestResult>();
  expectTypeOf<PendingExpiry>().not.toExtend<ExpireAvailableResultsResult>();
});

test("only state conflicts may expose authoritative request metadata on failure", () => {
  type AskWrite = RequestTerminalWriteResult<ReachedWaitRequestMetadata, AskRequestResult>;
  type StateConflictWithRequest = {
    readonly ok: false;
    readonly code: "state_conflict";
    readonly request: RequestMetadata;
  };
  type HiddenWithRequest = {
    readonly ok: false;
    readonly code: "not_found_or_unauthorized";
    readonly request: RequestMetadata;
  };
  expectTypeOf<StateConflictWithRequest>().toExtend<AskWrite>();
  expectTypeOf<HiddenWithRequest>().not.toExtend<AskWrite>();
});

test("participant projections cannot name private persistence or content fields", () => {
  type ForbiddenMetadataKey = Extract<
    keyof ParticipantRequestMetadata,
    | "workspaceKey"
    | "nativeMessageId"
    | "payloadByteLength"
    | "payloadSha256"
    | "resultByteLength"
    | "resultSha256"
    | "envelopeJson"
    | "claimedFencingToken"
    | "questions"
    | "milestone"
    | "answers"
    | "evidence"
  >;
  expectTypeOf<ForbiddenMetadataKey>().toEqualTypeOf<never>();

  type TargetResult = {
    readonly outcome: "available_result";
    readonly metadata: ParticipantRequestMetadata & { readonly participantRole: "target" };
    readonly result: AskRequestResult;
  };
  type SourcePayload = {
    readonly outcome: "pending_payload";
    readonly metadata: ParticipantRequestMetadata & { readonly participantRole: "source" };
    readonly payload: import("../../../src/domain/request-types").PendingRequestPayload;
  };
  expectTypeOf<TargetResult>().not.toExtend<ParticipantRequestGet>();
  expectTypeOf<SourcePayload>().not.toExtend<ParticipantRequestGet>();
});

test("participant exact-get discriminants reject every kind, state, result, and role mismatch", () => {
  type PendingAsk = ParticipantRequestMetadata<
    "target",
    PendingRequestMetadata & { readonly kind: "ask" }
  >;
  type PendingWait = ParticipantRequestMetadata<
    "target",
    PendingRequestMetadata & { readonly kind: "wait" }
  >;
  type AvailableAsk = ParticipantRequestMetadata<
    "source",
    AnsweredAskRequestMetadata & RequestAvailableResultMetadata
  >;
  type ExpiredAsk = ParticipantRequestMetadata<
    "source",
    AnsweredAskRequestMetadata & RequestExpiredResultMetadata
  >;
  type AvailableWait = ParticipantRequestMetadata<
    "source",
    ReachedWaitRequestMetadata & RequestAvailableResultMetadata
  >;
  type Impossible =
    | {
        readonly outcome: "pending_payload";
        readonly metadata: PendingAsk;
        readonly payload: WaitRequestPayload;
      }
    | {
        readonly outcome: "pending_payload";
        readonly metadata: PendingWait;
        readonly payload: AskRequestPayload;
      }
    | {
        readonly outcome: "available_result";
        readonly metadata: AvailableAsk;
        readonly result: WaitRequestResult;
      }
    | {
        readonly outcome: "available_result";
        readonly metadata: AvailableWait;
        readonly result: AskRequestResult;
      }
    | {
        readonly outcome: "available_result";
        readonly metadata: ExpiredAsk;
        readonly result: AskRequestResult;
      }
    | { readonly outcome: "result_expired"; readonly metadata: AvailableAsk }
    | {
        readonly outcome: "metadata";
        readonly view: "target_terminal";
        readonly metadata: PendingWait;
      }
    | {
        readonly outcome: "metadata";
        readonly view: "source_pending";
        readonly metadata: ExpiredAsk;
      };
  type EachImpossible = Impossible extends infer Candidate
    ? Candidate extends ParticipantRequestGet
      ? Candidate
      : never
    : never;
  expectTypeOf<EachImpossible>().toEqualTypeOf<never>();
});
