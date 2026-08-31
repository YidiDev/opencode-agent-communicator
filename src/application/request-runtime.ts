import { type RequestId, validateRequestId } from "../domain/generated-ids";
import { type RequestKind, requestKinds } from "../domain/request-types";
import { type SessionId, validateSessionId } from "../domain/sessions";
import { validateWorkspaceKey, type WorkspaceKey } from "../domain/workspaces";
import {
  type ContextAdmissionNotificationPort,
  notifyContextAdmissionSafely,
} from "./context-admission-runtime";
import type {
  CommittedRequestNotificationPort,
  CommittedRequestTerminalEvent,
} from "./request-notification-port";
import { snapshotCommittedRequestTerminalEvent } from "./request-terminal-notification";

export const requestRuntimeDefaultMaximumWaiters = 256;
export const requestRuntimeMaximumWaitersHardCeiling = 4_096;
export const requestRuntimeDefaultMaximumWaitersPerSource = 16;
export const requestRuntimeDefaultMaximumWaitersPerWorkspace = 256;

// Lifecycle startup/start/wake wiring and participant-maintenance notifications belong to the
// subsequent coordinator/use-case slice; these runtime/scheduler primitives remain unregistered.

export type RequestRuntimeStopReason = "shutdown" | "ownership_lost";
export type RequestRuntimeOutcome =
  | Readonly<{ readonly outcome: "terminal"; readonly event: CommittedRequestTerminalEvent }>
  | Readonly<{ readonly outcome: "reconcile" }>
  | Readonly<{ readonly outcome: RequestRuntimeStopReason }>;

export interface RequestRuntimeRegistration {
  readonly expectedKind: RequestKind;
  readonly outcome: Promise<RequestRuntimeOutcome>;
  detach(): void;
}

export class RequestRuntimeCapacityError extends Error {
  override readonly name = "RequestRuntimeCapacityError";
}

interface Waiter {
  readonly expectedKind: RequestKind;
  readonly sourceSessionId: SessionId;
  readonly workspaceKey: WorkspaceKey;
  readonly resolve: (outcome: RequestRuntimeOutcome) => void;
  accounted: boolean;
  routed: boolean;
}

interface RuntimeState {
  readonly waiters: Map<RequestId, Set<Waiter>>;
  readonly effects: AbortController;
  readonly accounted: Set<Waiter>;
  totalWaiters: number;
  readonly sourceWaiters: Map<string, number>;
  readonly workspaceWaiters: Map<string, number>;
  stoppedReason: RequestRuntimeStopReason | undefined;
}

/**
 * Bounded process-local waiter registry. Invalid notifications are ignored and kind collisions
 * wake conflicting waiters for durable reconciliation; no terminal event cache intentionally exists.
 */
export class RequestRuntime implements CommittedRequestNotificationPort {
  private readonly state: RuntimeState;

  constructor(
    readonly maximumWaiters: number = requestRuntimeDefaultMaximumWaiters,
    readonly maximumWaitersPerSource: number = Math.min(
      requestRuntimeDefaultMaximumWaitersPerSource,
      maximumWaiters,
    ),
    readonly maximumWaitersPerWorkspace: number = Math.min(
      requestRuntimeDefaultMaximumWaitersPerWorkspace,
      maximumWaiters,
    ),
    private readonly contextNotifications?: ContextAdmissionNotificationPort,
  ) {
    if (
      !Number.isSafeInteger(maximumWaiters) ||
      maximumWaiters < 1 ||
      maximumWaiters > requestRuntimeMaximumWaitersHardCeiling
    ) {
      throw new RangeError("The request runtime waiter bound is invalid.");
    }
    if (
      !Number.isSafeInteger(maximumWaitersPerSource) ||
      maximumWaitersPerSource < 1 ||
      maximumWaitersPerSource > maximumWaiters ||
      !Number.isSafeInteger(maximumWaitersPerWorkspace) ||
      maximumWaitersPerWorkspace < 1 ||
      maximumWaitersPerWorkspace > maximumWaiters
    )
      throw new RangeError("The request runtime scoped waiter bounds are invalid.");
    this.state = {
      waiters: new Map(),
      effects: new AbortController(),
      accounted: new Set(),
      totalWaiters: 0,
      sourceWaiters: new Map(),
      workspaceWaiters: new Map(),
      stoppedReason: undefined,
    };
  }

  get effectSignal(): AbortSignal {
    return this.state.effects.signal;
  }

  attach(input: {
    readonly requestId: RequestId;
    readonly expectedKind: RequestKind;
    readonly sourceSessionId: SessionId;
    readonly workspaceKey: WorkspaceKey;
  }): RequestRuntimeRegistration {
    return this.register(input);
  }

  attachProvisional(input: {
    readonly requestId: RequestId;
    readonly expectedKind: RequestKind;
    readonly sourceSessionId: SessionId;
    readonly workspaceKey: WorkspaceKey;
  }): RequestRuntimeRegistration {
    return this.register(input);
  }

  notifyTerminal(event: CommittedRequestTerminalEvent): undefined {
    try {
      if (this.state.stoppedReason !== undefined) return undefined;
      const snapshot = snapshotCommittedRequestTerminalEvent(event);
      if (!snapshot) return undefined;
      if (this.contextNotifications) {
        notifyContextAdmissionSafely(this.contextNotifications, {
          id: snapshot.requestId,
          kind: "request",
          state: "cancelled",
        });
      }
      const registered = this.state.waiters.get(snapshot.requestId);
      if (!registered) return undefined;
      const waiters = [...registered];
      this.state.waiters.delete(snapshot.requestId);
      registered.clear();
      for (const waiter of waiters) waiter.routed = false;
      const terminal = Object.freeze({ outcome: "terminal" as const, event: snapshot });
      const reconcile = Object.freeze({ outcome: "reconcile" as const });
      for (const waiter of waiters) {
        waiter.resolve(waiter.expectedKind === snapshot.kind ? terminal : reconcile);
      }
    } catch {
      // This public best-effort notification boundary must be total for arbitrary hostile values.
    }
    return undefined;
  }

  stop(reason: RequestRuntimeStopReason): void {
    if (this.state.stoppedReason !== undefined) return;
    this.state.stoppedReason = reason;
    const registered = [...this.state.waiters.values()].map((set) => {
      const snapshot = [...set];
      for (const waiter of snapshot) waiter.routed = false;
      set.clear();
      return snapshot;
    });
    this.state.waiters.clear();
    for (const waiter of this.state.accounted) waiter.accounted = false;
    this.state.accounted.clear();
    this.state.totalWaiters = 0;
    this.state.sourceWaiters.clear();
    this.state.workspaceWaiters.clear();
    try {
      this.state.effects.abort(reason);
    } catch {
      // Waiters were already detached, so hostile reentrant listeners cannot observe terminal data.
    }
    const outcome = Object.freeze({ outcome: reason });
    for (const snapshot of registered) for (const waiter of snapshot) waiter.resolve(outcome);
  }

  private register(input: {
    readonly requestId: RequestId;
    readonly expectedKind: RequestKind;
    readonly sourceSessionId: SessionId;
    readonly workspaceKey: WorkspaceKey;
  }): RequestRuntimeRegistration {
    const sourceSessionId = input.sourceSessionId;
    const workspaceKey = input.workspaceKey;
    if (
      !validateRequestId(input.requestId).ok ||
      !requestKinds.includes(input.expectedKind) ||
      !validateSessionId(sourceSessionId).ok ||
      !validateWorkspaceKey(workspaceKey).ok
    ) {
      throw new TypeError("The request runtime attachment is malformed.");
    }
    if (this.state.stoppedReason !== undefined) return this.stoppedRegistration(input.expectedKind);
    if (this.state.totalWaiters >= this.maximumWaiters) {
      throw new RequestRuntimeCapacityError("The process-local request waiter bound was reached.");
    }
    if (
      (this.state.sourceWaiters.get(sourceSessionId) ?? 0) >= this.maximumWaitersPerSource ||
      (this.state.workspaceWaiters.get(workspaceKey) ?? 0) >= this.maximumWaitersPerWorkspace
    )
      throw new RequestRuntimeCapacityError("A scoped request waiter bound was reached.");
    let resolve!: (outcome: RequestRuntimeOutcome) => void;
    const outcome = new Promise<RequestRuntimeOutcome>((complete) => {
      resolve = complete;
    });
    const waiter = {
      expectedKind: input.expectedKind,
      sourceSessionId,
      workspaceKey,
      resolve,
      accounted: true,
      routed: true,
    };
    const set = this.state.waiters.get(input.requestId) ?? new Set<Waiter>();
    set.add(waiter);
    this.state.accounted.add(waiter);
    this.state.waiters.set(input.requestId, set);
    this.state.totalWaiters += 1;
    this.state.sourceWaiters.set(
      sourceSessionId,
      (this.state.sourceWaiters.get(sourceSessionId) ?? 0) + 1,
    );
    this.state.workspaceWaiters.set(
      workspaceKey,
      (this.state.workspaceWaiters.get(workspaceKey) ?? 0) + 1,
    );
    let attached = true;
    return Object.freeze({
      expectedKind: input.expectedKind,
      outcome,
      detach: () => {
        if (!attached) return;
        attached = false;
        if (waiter.routed) {
          set.delete(waiter);
          waiter.routed = false;
          if (set.size === 0) this.state.waiters.delete(input.requestId);
        }
        if (!waiter.accounted) return;
        waiter.accounted = false;
        this.state.accounted.delete(waiter);
        this.state.totalWaiters -= 1;
        this.decrementScopes(waiter);
      },
    });
  }

  wakeRequest(requestId: RequestId): void {
    const registered = this.state.waiters.get(requestId);
    if (!registered) return;
    const waiters = [...registered];
    this.state.waiters.delete(requestId);
    registered.clear();
    for (const waiter of waiters) {
      waiter.routed = false;
      waiter.resolve(Object.freeze({ outcome: "reconcile" }));
    }
  }

  private decrementScopes(waiter: Pick<Waiter, "sourceSessionId" | "workspaceKey">): void {
    for (const [map, key] of [
      [this.state.sourceWaiters, waiter.sourceSessionId],
      [this.state.workspaceWaiters, waiter.workspaceKey],
    ] as const) {
      const next = (map.get(key) ?? 1) - 1;
      if (next === 0) map.delete(key);
      else map.set(key, next);
    }
  }

  private stoppedRegistration(expectedKind: RequestKind): RequestRuntimeRegistration {
    const outcome = Promise.resolve(
      Object.freeze({ outcome: this.state.stoppedReason as RequestRuntimeStopReason }),
    );
    return Object.freeze({ expectedKind, outcome, detach: () => undefined });
  }
}
