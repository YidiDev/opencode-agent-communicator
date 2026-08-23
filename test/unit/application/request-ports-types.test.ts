import { expectTypeOf, test } from "bun:test";

import type {
  AcknowledgeRequestResult,
  CancelPendingResult,
  ExpireAvailableResultsResult,
  RequestMetadataAtResolution,
  RequestTerminalWriteResult,
} from "../../../src/application/request-ports";
import type {
  AskRequestResult,
  PendingRequestMetadata,
  ReachedWaitRequestMetadata,
  RequestMetadata,
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
