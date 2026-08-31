import {
  type ContextAdmissionId,
  type ContextAdmissionKind,
  type ContextAdmissionState,
  contextAdmissionKinds,
} from "../domain/context-admissions";
import { validateDeliveryId, validateRequestId } from "../domain/generated-ids";
import { type SessionId, validateSessionId } from "../domain/sessions";
import { validateWorkspaceKey, type WorkspaceKey } from "../domain/workspaces";

export const contextAdmissionRuntimeMaximumWaitersHardCeiling = 4_096;

export interface CommittedContextAdmissionEvent {
  readonly id: ContextAdmissionId;
  readonly kind: ContextAdmissionKind;
  readonly state: Exclude<ContextAdmissionState, "prepared" | "awaiting_context">;
}

export type ContextAdmissionRuntimeOutcome =
  | { readonly outcome: "settled"; readonly event: CommittedContextAdmissionEvent }
  | { readonly outcome: "reconcile" }
  | { readonly outcome: "shutdown" | "ownership_lost" };

export interface ContextAdmissionRegistration {
  readonly outcome: Promise<ContextAdmissionRuntimeOutcome>;
  detach(): void;
}

export interface ContextAdmissionNotificationPort {
  notifyContextSettled(event: CommittedContextAdmissionEvent): undefined;
}

export interface ContextAdmissionRuntimePort extends ContextAdmissionNotificationPort {
  attach(input: {
    readonly id: ContextAdmissionId;
    readonly kind: ContextAdmissionKind;
    readonly sourceSessionId: SessionId;
    readonly workspaceKey: WorkspaceKey;
  }): ContextAdmissionRegistration;
  readonly effectSignal: AbortSignal;
}

interface Waiter {
  readonly kind: ContextAdmissionKind;
  readonly resolve: (outcome: ContextAdmissionRuntimeOutcome) => void;
  routed: boolean;
}

export class ContextAdmissionRuntime implements ContextAdmissionRuntimePort {
  private readonly waiters = new Map<ContextAdmissionId, Set<Waiter>>();
  private readonly effects = new AbortController();
  private stopped: "shutdown" | "ownership_lost" | undefined;
  private total = 0;

  constructor(readonly maximumWaiters = 256) {
    if (
      !Number.isSafeInteger(maximumWaiters) ||
      maximumWaiters < 1 ||
      maximumWaiters > contextAdmissionRuntimeMaximumWaitersHardCeiling
    ) {
      throw new RangeError("The context admission waiter bound is invalid.");
    }
  }

  get effectSignal(): AbortSignal {
    return this.effects.signal;
  }

  attach(input: {
    readonly id: ContextAdmissionId;
    readonly kind: ContextAdmissionKind;
    readonly sourceSessionId: SessionId;
    readonly workspaceKey: WorkspaceKey;
  }): ContextAdmissionRegistration {
    const validId =
      input.kind === "message" ? validateDeliveryId(input.id).ok : validateRequestId(input.id).ok;
    if (
      !validId ||
      !contextAdmissionKinds.includes(input.kind) ||
      !validateSessionId(input.sourceSessionId).ok ||
      !validateWorkspaceKey(input.workspaceKey).ok
    ) {
      throw new TypeError("The context admission attachment is malformed.");
    }
    if (this.stopped) {
      return Object.freeze({
        outcome: Promise.resolve({ outcome: this.stopped }),
        detach: () => {},
      });
    }
    if (this.total >= this.maximumWaiters) {
      throw new RangeError("The context admission waiter bound was reached.");
    }
    let resolve!: (outcome: ContextAdmissionRuntimeOutcome) => void;
    const outcome = new Promise<ContextAdmissionRuntimeOutcome>((complete) => {
      resolve = complete;
    });
    const waiter: Waiter = { kind: input.kind, resolve, routed: true };
    const set = this.waiters.get(input.id) ?? new Set<Waiter>();
    set.add(waiter);
    this.waiters.set(input.id, set);
    this.total += 1;
    let attached = true;
    return Object.freeze({
      outcome,
      detach: () => {
        if (!attached) return;
        attached = false;
        this.total -= 1;
        if (!waiter.routed) return;
        waiter.routed = false;
        set.delete(waiter);
        if (set.size === 0) this.waiters.delete(input.id);
      },
    });
  }

  notifyContextSettled(event: CommittedContextAdmissionEvent): undefined {
    try {
      if (this.stopped || !this.validEvent(event)) return undefined;
      const set = this.waiters.get(event.id);
      if (!set) return undefined;
      this.waiters.delete(event.id);
      const snapshot = Object.freeze({ ...event });
      for (const waiter of set) {
        waiter.routed = false;
        waiter.resolve(
          waiter.kind === event.kind
            ? Object.freeze({ outcome: "settled" as const, event: snapshot })
            : Object.freeze({ outcome: "reconcile" as const }),
        );
      }
      set.clear();
    } catch {
      // Notifications only accelerate a durable state read.
    }
    return undefined;
  }

  stop(reason: "shutdown" | "ownership_lost"): void {
    if (this.stopped) return;
    this.stopped = reason;
    try {
      this.effects.abort(reason);
    } catch {
      // Durable state remains authoritative if an abort listener is hostile.
    }
    for (const set of this.waiters.values()) {
      for (const waiter of set) {
        waiter.routed = false;
        waiter.resolve(Object.freeze({ outcome: reason }));
      }
      set.clear();
    }
    this.waiters.clear();
  }

  private validEvent(event: CommittedContextAdmissionEvent): boolean {
    if (
      !contextAdmissionKinds.includes(event.kind) ||
      !(["context_admitted", "failed", "cancelled"] as const).includes(event.state)
    ) {
      return false;
    }
    return event.kind === "message"
      ? validateDeliveryId(event.id).ok
      : validateRequestId(event.id).ok;
  }
}

export function notifyContextAdmissionSafely(
  notifications: ContextAdmissionNotificationPort,
  event: CommittedContextAdmissionEvent,
): void {
  try {
    notifications.notifyContextSettled(Object.freeze({ ...event }));
  } catch {
    // Store commit success never depends on process-local notification delivery.
  }
}
