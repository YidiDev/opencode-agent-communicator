import { expect, test } from "bun:test";
import { LinuxBunSqliteStore as FacadeSqliteStore } from "../../src/adapters/store/sqlite-store";
import { LinuxBunSqliteStore as DirectSqliteStore } from "../../src/adapters/store/sqlite-store-implementation";
import { StartOperationRepository as FacadeStartRepository } from "../../src/adapters/store/start-operation-repository";
import { StartOperationRepository as DirectStartRepository } from "../../src/adapters/store/start-operation-repository-implementation";
import {
  admitClaimedMessage as FacadeAdmitClaimedMessage,
  deliveryStoreFailure as facadeDeliveryStoreFailure,
} from "../../src/application/admit-message-delivery";
import { blockUntilRequestTerminal as DirectBlockUntilTerminal } from "../../src/application/blocking-request-terminal-wait";
import { createBlockingSessionRequest as DirectCreateBlockingRequest } from "../../src/application/blocking-session-request-orchestration";
import { blockUntilRequestTerminal as FacadeBlockUntilTerminal } from "../../src/application/blocking-session-request-wait";
import { deliveryStoreFailure as directDeliveryStoreFailure } from "../../src/application/claimed-message-admission";
import { admitClaimedMessage as DirectAdmitClaimedMessage } from "../../src/application/claimed-message-admission-effect";
import { createBlockingSessionRequest as FacadeCreateBlockingRequest } from "../../src/application/create-blocking-session-request";
import { sendSessionMessage as FacadeSendSessionMessage } from "../../src/application/send-session-message";
import { sendSessionMessage as DirectSendSessionMessage } from "../../src/application/session-message-delivery";
import {
  classifyStaleSessionRequests as FacadeClassifyStaleRequests,
  recoverPreparedSessionRequests as FacadeRecoverPreparedRequests,
} from "../../src/application/session-request-recovery-implementation";
import {
  classifyStaleSessionRequests as DirectClassifyStaleRequests,
  recoverPreparedSessionRequests as DirectRecoverPreparedRequests,
} from "../../src/application/session-request-recovery-phases";

test("legacy refactor facades preserve runtime export identity", () => {
  expect(FacadeSqliteStore).toBe(DirectSqliteStore);
  expect(FacadeStartRepository).toBe(DirectStartRepository);
  expect(FacadeAdmitClaimedMessage).toBe(DirectAdmitClaimedMessage);
  expect(facadeDeliveryStoreFailure).toBe(directDeliveryStoreFailure);
  expect(FacadeBlockUntilTerminal).toBe(DirectBlockUntilTerminal);
  expect(FacadeCreateBlockingRequest).toBe(DirectCreateBlockingRequest);
  expect(FacadeSendSessionMessage).toBe(DirectSendSessionMessage);
  expect(FacadeClassifyStaleRequests).toBe(DirectClassifyStaleRequests);
  expect(FacadeRecoverPreparedRequests).toBe(DirectRecoverPreparedRequests);
});
