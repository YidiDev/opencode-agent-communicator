import { type SessionId, validateSessionId } from "../domain/sessions";

export const participantOperationMaximumQueued = 4_096;

export class ParticipantOperationAbortedFault extends Error {
  override readonly name = "ParticipantOperationAbortedFault";
}

export class ParticipantOperationCapacityFault extends Error {
  override readonly name = "ParticipantOperationCapacityFault";
}

export class ParticipantOperationGateClosedFault extends Error {
  override readonly name = "ParticipantOperationGateClosedFault";
}

export interface ParticipantOperationPort {
  run<Value>(
    participantIds: readonly SessionId[],
    abort: AbortSignal,
    operation: () => Promise<Value>,
  ): Promise<Value>;
}

interface QueuedOperation {
  readonly keys: readonly SessionId[];
  readonly abort: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
  readonly onAbort: () => void;
}

/** Canonically ordered keyed gate that closes request-creation versus participant-stop races. */
export class ParticipantOperationGate implements ParticipantOperationPort {
  private readonly held = new Set<SessionId>();
  private readonly queued: QueuedOperation[] = [];
  private readonly active = new Set<Promise<unknown>>();
  private closed = false;

  async run<Value>(
    participantIds: readonly SessionId[],
    abort: AbortSignal,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const keys = this.canonicalKeys(participantIds);
    await this.acquire(keys, abort);
    const active = Promise.resolve().then(operation);
    this.active.add(active);
    try {
      return await active;
    } finally {
      this.active.delete(active);
      for (const key of keys) this.held.delete(key);
      this.dispatch();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const queued of this.queued.splice(0)) {
      queued.abort.removeEventListener("abort", queued.onAbort);
      queued.reject(new ParticipantOperationGateClosedFault("Participant operation gate closed."));
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }

  private canonicalKeys(participantIds: readonly SessionId[]): readonly SessionId[] {
    if (!Array.isArray(participantIds) || participantIds.length < 1 || participantIds.length > 2) {
      throw new TypeError("Participant operation keys are malformed.");
    }
    const unique = new Set<SessionId>();
    for (const value of participantIds) {
      const id = validateSessionId(value);
      if (!id.ok) throw new TypeError("Participant operation key is malformed.");
      unique.add(id.value);
    }
    return Object.freeze([...unique].sort());
  }

  private acquire(keys: readonly SessionId[], abort: AbortSignal): Promise<void> {
    if (abort.aborted) {
      return Promise.reject(new ParticipantOperationAbortedFault("Participant operation aborted."));
    }
    if (this.closed) {
      return Promise.reject(
        new ParticipantOperationGateClosedFault("Participant operation gate closed."),
      );
    }
    if (this.canAcquire(keys)) {
      for (const key of keys) this.held.add(key);
      return Promise.resolve();
    }
    if (this.queued.length >= participantOperationMaximumQueued) {
      return Promise.reject(
        new ParticipantOperationCapacityFault("Participant operation capacity is exhausted."),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const queued: QueuedOperation = {
        keys,
        abort,
        resolve,
        reject,
        onAbort: () => {
          const index = this.queued.indexOf(queued);
          if (index >= 0) this.queued.splice(index, 1);
          reject(new ParticipantOperationAbortedFault("Participant operation aborted."));
          this.dispatch();
        },
      };
      abort.addEventListener("abort", queued.onAbort, { once: true });
      this.queued.push(queued);
    });
  }

  private canAcquire(keys: readonly SessionId[]): boolean {
    return keys.every((key) => !this.held.has(key));
  }

  private dispatch(): void {
    if (this.closed) return;
    const queued = this.queued.find((candidate) => this.canAcquire(candidate.keys));
    if (!queued) return;
    this.queued.splice(this.queued.indexOf(queued), 1);
    queued.abort.removeEventListener("abort", queued.onAbort);
    for (const key of queued.keys) this.held.add(key);
    queued.resolve();
    this.dispatch();
  }
}
