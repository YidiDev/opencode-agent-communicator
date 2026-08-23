import { expect, expectTypeOf, test } from "bun:test";

import type { SessionRequestAckResult } from "../../../src/application/acknowledge-session-request";
import type { SessionRequestCancelResult } from "../../../src/application/cancel-session-request";
import {
  type CommittedRequestNotificationPort,
  noopCommittedRequestNotifications,
} from "../../../src/application/request-notification-port";
import type { SessionRespondResult } from "../../../src/application/respond-to-session-request";
import type { SessionSignalResult } from "../../../src/application/signal-session-request";

test("terminal application DTOs are minimal snake-case projections", () => {
  expectTypeOf<SessionRespondResult>().toEqualTypeOf<{
    readonly request_id: string;
    readonly state: "answered";
    readonly answered_at_ms: number;
  }>();
  expectTypeOf<SessionSignalResult>().toEqualTypeOf<{
    readonly request_id: string;
    readonly state: "reached";
    readonly reached_at_ms: number;
  }>();
  expectTypeOf<SessionRequestCancelResult>().toEqualTypeOf<{
    readonly request_id: string;
    readonly state: "cancelled";
    readonly cancelled_at_ms: number;
  }>();
  expectTypeOf<SessionRequestAckResult>().toEqualTypeOf<{
    readonly request_id: string;
    readonly state: "acknowledged";
    readonly acknowledged_at_ms: number;
  }>();
});

test("terminal notification port is synchronous", () => {
  expectTypeOf<
    ReturnType<CommittedRequestNotificationPort["notifyTerminal"]>
  >().toEqualTypeOf<undefined>();
  expect(noopCommittedRequestNotifications.notifyTerminal({} as never)).toBeUndefined();
  type AsyncObserver = {
    notifyTerminal(event: never): Promise<void>;
  };
  expectTypeOf<AsyncObserver>().not.toExtend<CommittedRequestNotificationPort>();
});
