/** Application boundary used by tool-facing workflows to reject work before startup is complete. */
export interface CommunicatorReadinessPort {
  assertReady(): void;
}

export function assertCommunicatorReady(port: CommunicatorReadinessPort): void {
  port.assertReady();
}
