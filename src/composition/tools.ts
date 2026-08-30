import type { OpenCodeNativeAdapter } from "../adapters/native/opencode-1-18";
import type { LinuxBunSqliteStore } from "../adapters/store/sqlite-store";
import type {
  AdvisoryLockPostCommitNotificationPort,
  AdvisoryLockWakePort,
} from "../application/advisory-lock-use-cases";
import type { RequestDeadlineTimerPort } from "../application/blocking-session-request-boundaries";
import type { CommunicatorStartupRecoveryLifecycle } from "../application/communicator-startup-lifecycle";
import type { ContextAdmissionRuntime } from "../application/context-admission-runtime";
import type { ClockPort } from "../application/delivery-ports";
import type { ParticipantOperationPort } from "../application/participant-operation-gate";
import type { RequestRuntime } from "../application/request-runtime";
import { sessionExportPolicyPort } from "../application/session-export-policy";
import type { SessionExportAdapterPort } from "../application/session-export-ports";
import { createGeneratedIdFactory } from "../domain/generated-ids";
import { createSessionExportPolicy } from "../domain/session-export";
import { createSessionStartPolicy } from "../domain/session-start-policy";
import type { WorkspaceKey } from "../domain/workspaces";
import { createSessionAskTool } from "../tools/session-ask";
import { createSessionDeliveryGetTool } from "../tools/session-delivery-get";
import { createSessionExportTool } from "../tools/session-export";
import { createSessionListTool } from "../tools/session-list";
import {
  createSessionLockListTool,
  createSessionLockPublishTool,
  createSessionLockReleaseTool,
  createSessionLockRenewTool,
} from "../tools/session-locks";
import { createSessionRequestAckTool } from "../tools/session-request-ack";
import { createSessionRequestCancelTool } from "../tools/session-request-cancel";
import { createSessionRequestGetTool } from "../tools/session-request-get";
import { createSessionRequestListTool } from "../tools/session-request-list";
import { createSessionRequestSendTool } from "../tools/session-request-send";
import { createSessionRequestStartTool } from "../tools/session-request-start";
import { createSessionRespondTool } from "../tools/session-respond";
import { createSessionSendTool } from "../tools/session-send";
import { createSessionSignalTool } from "../tools/session-signal";
import { createSessionStartTool } from "../tools/session-start";
import { createSessionStopTool } from "../tools/session-stop";
import { createSessionWaitTool } from "../tools/session-wait";
import type { CommunicatorOptions } from "./config";
import {
  productionBlockingTimers,
  productionClock,
  productionEntropy,
  productionSha256,
} from "./primitives";

export const communicatorToolIds = Object.freeze([
  "session_list",
  "session_lock_list",
  "session_lock_publish",
  "session_lock_release",
  "session_lock_renew",
  "session_send",
  "session_delivery_get",
  "session_ask",
  "session_respond",
  "session_wait",
  "session_signal",
  "session_request_list",
  "session_request_get",
  "session_request_ack",
  "session_request_cancel",
  "session_request_send",
  "session_request_start",
  "session_stop",
  "session_start",
  "session_export",
] as const);

function configuredUnresolvedProvenanceLimit(value: number | undefined) {
  return value === undefined ? {} : { unresolvedProvenancePerWorkspace: value };
}

export function configuredStartPolicy(options: CommunicatorOptions) {
  const configured = options.start;
  const limits = configured?.limits;
  return createSessionStartPolicy({
    decision: options.policies?.start ?? "ask",
    ...(configured?.allowedAgents === undefined ? {} : { allowedAgents: configured.allowedAgents }),
    ...(configured?.allowedModels === undefined ? {} : { allowedModels: configured.allowedModels }),
    ...(configured?.allowManagedSessionRecursion === undefined
      ? {}
      : { allowManagedSessionRecursion: configured.allowManagedSessionRecursion }),
    ...(limits === undefined
      ? {}
      : {
          limits: {
            ...(limits.managedSessionsPerWorkspace === undefined
              ? {}
              : { managedSessionsPerWorkspace: limits.managedSessionsPerWorkspace }),
            ...configuredUnresolvedProvenanceLimit(limits.unresolvedProvenancePerWorkspace),
            ...(limits.operationsPerWorkspace === undefined
              ? {}
              : { operationsPerWorkspace: limits.operationsPerWorkspace }),
            ...(limits.payloadBytesPerWorkspace === undefined
              ? {}
              : { payloadBytesPerWorkspace: limits.payloadBytesPerWorkspace }),
            ...(limits.startsPerSourceWindow === undefined
              ? {}
              : { startsPerSourceWindow: limits.startsPerSourceWindow }),
            ...(limits.startsPerWorkspaceWindow === undefined
              ? {}
              : { startsPerWorkspaceWindow: limits.startsPerWorkspaceWindow }),
            ...(limits.rateWindowMs === undefined ? {} : { rateWindowMs: limits.rateWindowMs }),
            ...(limits.terminalRetentionMs === undefined
              ? {}
              : { terminalRetentionMs: limits.terminalRetentionMs }),
          },
        }),
  });
}

export function constructToolContracts(input: {
  readonly options: CommunicatorOptions;
  readonly workspaceKey: WorkspaceKey;
  readonly native: OpenCodeNativeAdapter;
  readonly store: LinuxBunSqliteStore;
  readonly runtime: RequestRuntime;
  readonly contextRuntime?: ContextAdmissionRuntime;
  readonly lifecycle: CommunicatorStartupRecoveryLifecycle;
  readonly participantOperations: ParticipantOperationPort;
  readonly exporter: SessionExportAdapterPort;
  /** Controlled composition seams used by deterministic deadline regression tests. */
  readonly clock?: ClockPort;
  readonly blockingTimers?: RequestDeadlineTimerPort;
  readonly advisoryLockWake?: AdvisoryLockWakePort;
  readonly advisoryLockNotifications?: AdvisoryLockPostCommitNotificationPort;
}) {
  const { options, workspaceKey, native, store, runtime, contextRuntime, lifecycle } = input;
  const clock = input.clock ?? productionClock;
  const blockingTimers = input.blockingTimers ?? productionBlockingTimers;
  const ids = createGeneratedIdFactory(productionEntropy);
  const invocationDeadlineMs = (minimumDurationMs = 0): number => {
    if (!Number.isSafeInteger(minimumDurationMs) || minimumDurationMs < 0) {
      throw new Error("Minimum invocation duration is invalid.");
    }
    const value = clock.nowMs() + Math.max(options.invocationDeadlineMs, minimumDurationMs);
    if (!Number.isSafeInteger(value)) throw new Error("Invocation deadline overflowed.");
    return value;
  };
  const identityScope = { workspaceKey, fencingToken: lifecycle.fencingToken };
  const requestScope = { ...identityScope, invocationDeadlineMs };
  const common = { readiness: lifecycle, membership: native };
  const mutation = {
    ...common,
    clock,
    requests: store,
    notifications: runtime,
  };
  const blocking = {
    ...mutation,
    activity: native,
    nativeSteer: native,
    nativeQueue: native,
    ownership: store,
    runtime,
    participantOperations: input.participantOperations,
    scheduler: lifecycle.scheduler,
    deadlineTimer: blockingTimers,
    workflowFault: {
      fault(fault: { readonly fencingToken: typeof lifecycle.fencingToken }): void {
        if (fault.fencingToken === lifecycle.fencingToken) lifecycle.stop("shutdown");
      },
    },
    ids,
    digest: productionSha256,
  };
  const policies = options.policies ?? {};
  const advisoryLocks = {
    ...common,
    locks: store,
    ids,
    ...(input.advisoryLockWake ? { wake: input.advisoryLockWake } : {}),
    ...(input.advisoryLockNotifications ? { notifications: input.advisoryLockNotifications } : {}),
  };
  return Object.freeze({
    session_list: createSessionListTool(
      { ...common, sessions: native },
      workspaceKey,
      invocationDeadlineMs,
    ),
    session_lock_list: createSessionLockListTool(advisoryLocks, identityScope),
    session_lock_publish: createSessionLockPublishTool(advisoryLocks, identityScope),
    session_lock_release: createSessionLockReleaseTool(advisoryLocks, identityScope),
    session_lock_renew: createSessionLockRenewTool(advisoryLocks, identityScope),
    session_send: createSessionSendTool(
      {
        ...common,
        deliveries: store,
        nativeQueue: native,
        ownership: store,
        clock,
        ids,
        digest: productionSha256,
        contexts: store,
        ...(contextRuntime ? { contextRuntime } : {}),
        activity: native,
        participantOperations: input.participantOperations,
      },
      workspaceKey,
      policies.message ?? "allow",
      invocationDeadlineMs,
    ),
    session_delivery_get: createSessionDeliveryGetTool(
      { ...common, deliveries: store, contexts: store },
      workspaceKey,
      invocationDeadlineMs,
    ),
    session_ask: createSessionAskTool(blocking, requestScope, policies.ask ?? "allow"),
    session_respond: createSessionRespondTool(
      { ...mutation, digest: productionSha256 },
      requestScope,
    ),
    session_wait: createSessionWaitTool(blocking, requestScope, policies.wait ?? "allow"),
    session_signal: createSessionSignalTool(
      { ...mutation, digest: productionSha256 },
      requestScope,
    ),
    session_request_list: createSessionRequestListTool(mutation, requestScope),
    session_request_get: createSessionRequestGetTool(mutation, requestScope),
    session_request_ack: createSessionRequestAckTool(mutation, requestScope),
    session_request_cancel: createSessionRequestCancelTool(mutation, requestScope),
    session_request_send: createSessionRequestSendTool(
      {
        ...common,
        requests: store,
        scheduler: lifecycle.scheduler,
        nativeQueue: native,
        ownership: store,
        clock,
        ids,
        digest: productionSha256,
        contexts: store,
        ...(contextRuntime ? { contextRuntime } : {}),
        activity: native,
        participantOperations: input.participantOperations,
      },
      requestScope,
      {
        message: policies.message ?? "allow",
        ask: policies.ask ?? "allow",
        wait: policies.wait ?? "allow",
      },
    ),
    session_request_start: createSessionRequestStartTool(
      {
        ...common,
        starts: store.starts,
        requests: store,
        requestStarts: store,
        scheduler: lifecycle.scheduler,
        nativeStart: native,
        ownership: store,
        clock,
        ids,
        digest: productionSha256,
        policy: configuredStartPolicy(options),
      },
      requestScope,
      { ask: policies.ask ?? "allow", wait: policies.wait ?? "allow" },
    ),
    session_stop: createSessionStopTool(
      {
        readiness: lifecycle,
        activity: native,
        requests: store,
        nativeInterrupt: native,
        ownership: store,
        notifications: runtime,
        participantOperations: input.participantOperations,
        digest: productionSha256,
      },
      workspaceKey,
      invocationDeadlineMs,
    ),
    session_start: createSessionStartTool(
      {
        ...common,
        starts: store.starts,
        nativeStart: native,
        ownership: store,
        clock,
        ids,
        digest: productionSha256,
        policy: configuredStartPolicy(options),
      },
      { workspaceKey, invocationDeadlineMs },
    ),
    session_export: createSessionExportTool(
      {
        ...common,
        ownership: store,
        policy: sessionExportPolicyPort(
          createSessionExportPolicy({
            selfSanitized: policies.exportSelfSanitized ?? "allow",
            crossSession: policies.exportCrossSession ?? "ask",
            unsanitized: policies.exportUnsanitized ?? "ask",
            overwrite: policies.exportOverwrite ?? "ask",
          }),
        ),
        exporter: input.exporter,
      },
      { workspaceKey, invocationDeadlineMs },
    ),
  });
}
