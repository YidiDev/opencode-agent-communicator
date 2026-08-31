import { type FencingToken, OwnershipLostFault, validateFencingToken } from "../domain/ownership";

/** Application boundary used by tool-facing workflows to reject work before startup is complete. */
export interface CommunicatorReadinessPort {
  /** The epoch which completed full startup recovery. Ordinary work must preserve this epoch. */
  readonly fencingToken?: FencingToken;
  assertReady(): void;
  /** Process-local fail-closed hook used when an ordinary workflow detects an epoch mismatch. */
  ownershipLost?(): void;
}

export function assertCommunicatorReady(
  port: CommunicatorReadinessPort,
  expectedFencingToken?: FencingToken,
): void {
  port.assertReady();
  if (
    expectedFencingToken !== undefined &&
    port.fencingToken !== undefined &&
    port.fencingToken !== expectedFencingToken
  ) {
    port.ownershipLost?.();
    throw new OwnershipLostFault("Communicator lifecycle fencing epoch changed.");
  }
}

export function communicatorIsReady(
  port: CommunicatorReadinessPort,
  expectedFencingToken?: FencingToken,
): boolean {
  try {
    assertCommunicatorReady(port, expectedFencingToken);
    return true;
  } catch {
    return false;
  }
}

/** Returns only the epoch which passed startup recovery; this deliberately never reacquires. */
export function communicatorLifecycleFencingToken(port: CommunicatorReadinessPort): FencingToken {
  const token = validateFencingToken(port.fencingToken);
  if (!token.ok) {
    port.ownershipLost?.();
    throw new OwnershipLostFault("Communicator lifecycle has no valid recovered fencing epoch.");
  }
  return token.value;
}

export function stopCommunicatorForOwnershipLoss(port: CommunicatorReadinessPort): void {
  port.ownershipLost?.();
}
