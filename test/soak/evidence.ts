export const soakHours = 48;

export class SoakAssertion extends Error {
  constructor(readonly step: string) {
    super("A controlled soak assertion failed");
    this.name = "SoakAssertion";
  }
}

export interface SoakObservation {
  readonly elapsedMs: number;
  readonly wallMs: number;
}

export function assertContinuousObservation(
  previous: SoakObservation,
  current: SoakObservation,
  maximumGapMs: number,
): void {
  const monotonicDelta = current.elapsedMs - previous.elapsedMs;
  const wallDelta = current.wallMs - previous.wallMs;
  if (
    ![previous.elapsedMs, previous.wallMs, current.elapsedMs, current.wallMs, maximumGapMs].every(
      Number.isFinite,
    ) ||
    maximumGapMs <= 0 ||
    previous.elapsedMs < 0 ||
    monotonicDelta < 0 ||
    monotonicDelta > maximumGapMs ||
    Math.abs(wallDelta - monotonicDelta) > 30_000
  )
    throw new Error("Soak continuity or clock observation is invalid");
}

export function soakOutcome(input: {
  readonly smoke: boolean;
  readonly elapsedMs: number;
  readonly requestedMs: number;
  readonly samples: number;
  readonly restarts: number;
  readonly companionsPassed: boolean;
}): "passed" | "smoke_passed" {
  if (
    !Number.isFinite(input.elapsedMs) ||
    !Number.isFinite(input.requestedMs) ||
    input.requestedMs <= 0 ||
    input.elapsedMs < input.requestedMs ||
    input.samples < 2 ||
    !Number.isSafeInteger(input.samples) ||
    input.restarts !== 1 ||
    !input.companionsPassed ||
    (!input.smoke && input.requestedMs < soakHours * 3_600_000)
  )
    throw new Error("Soak is incomplete; stable evidence cannot be claimed");
  return input.smoke ? "smoke_passed" : "passed";
}
