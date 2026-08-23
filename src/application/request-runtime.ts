import { type RequestId, validateRequestId } from "../domain/generated-ids";
import { type RequestKind, requestKinds } from "../domain/request-types";
import type {
  CommittedRequestNotificationPort,
  CommittedRequestTerminalEvent,
} from "./request-notification-port";
import { snapshotCommittedRequestTerminalEvent } from "./request-terminal-notification";

export const requestRuntimeDefaultMaximumWaiters = 256;
export const requestRuntimeMaximumWaitersHardCeiling = 4_096;

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
  readonly resolve: (outcome: RequestRuntimeOutcome) => void;
}

interface RuntimeState {
  readonly waiters: Map<RequestId, Set<Waiter>>;
  readonly effects: AbortController;
  totalWaiters: number;
  stoppedReason: RequestRuntimeStopReason | undefined;
}

/**
 * Bounded process-local waiter registry. Invalid notifications are ignored and kind collisions
 * wake conflicting waiters for durable reconciliation; no terminal event cache intentionally exists.
 */
export class RequestRuntime implements CommittedRequestNotificationPort {
  private readonly state: RuntimeState;

  constructor(readonly maximumWaiters: number = requestRuntimeDefaultMaximumWaiters) {
    if (
      !Number.isSafeInteger(maximumWaiters) ||
      maximumWaiters < 1 ||
      maximumWaiters > requestRuntimeMaximumWaitersHardCeiling
    ) {
      throw new RangeError("The request runtime waiter bound is invalid.");
    }
    this.state = {
      waiters: new Map(),
      effects: new AbortController(),
      totalWaiters: 0,
      stoppedReason: undefined,
    };
  }

  get effectSignal(): AbortSignal {
    return this.state.effects.signal;
  }

  attach(input: {
    readonly requestId: RequestId;
    readonly expectedKind: RequestKind;
  }): RequestRuntimeRegistration {
    return this.register(input);
  }

  attachProvisional(input: {
    readonly requestId: RequestId;
    readonly expectedKind: RequestKind;
  }): RequestRuntimeRegistration {
    return this.register(input);
  }

  notifyTerminal(event: CommittedRequestTerminalEvent): undefined {
    try {
      if (this.state.stoppedReason !== undefined) return undefined;
      const snapshot = snapshotCommittedRequestTerminalEvent(event);
      if (!snapshot) return undefined;
      const registered = this.state.waiters.get(snapshot.requestId);
      if (!registered) return undefined;
      const waiters = [...registered];
      this.state.waiters.delete(snapshot.requestId);
      registered.clear();
      this.state.totalWaiters -= waiters.length;
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
      set.clear();
      return snapshot;
    });
    this.state.waiters.clear();
    this.state.totalWaiters = 0;
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
  }): RequestRuntimeRegistration {
    if (!validateRequestId(input.requestId).ok || !requestKinds.includes(input.expectedKind)) {
      throw new TypeError("The request runtime attachment is malformed.");
    }
    if (this.state.stoppedReason !== undefined) return this.stoppedRegistration(input.expectedKind);
    if (this.state.totalWaiters >= this.maximumWaiters) {
      throw new RequestRuntimeCapacityError("The process-local request waiter bound was reached.");
    }
    let resolve!: (outcome: RequestRuntimeOutcome) => void;
    const outcome = new Promise<RequestRuntimeOutcome>((complete) => {
      resolve = complete;
    });
    const waiter = { expectedKind: input.expectedKind, resolve };
    const set = this.state.waiters.get(input.requestId) ?? new Set<Waiter>();
    set.add(waiter);
    this.state.waiters.set(input.requestId, set);
    this.state.totalWaiters += 1;
    let attached = true;
    return Object.freeze({
      expectedKind: input.expectedKind,
      outcome,
      detach: () => {
        if (!attached) return;
        attached = false;
        if (!set.delete(waiter)) return;
        this.state.totalWaiters -= 1;
        if (set.size === 0) this.state.waiters.delete(input.requestId);
      },
    });
  }

  private stoppedRegistration(expectedKind: RequestKind): RequestRuntimeRegistration {
    const outcome = Promise.resolve(
      Object.freeze({ outcome: this.state.stoppedReason as RequestRuntimeStopReason }),
    );
    return Object.freeze({ expectedKind, outcome, detach: () => undefined });
  }
}
