export const soakHours = 48;

export class SoakAssertion extends Error {
  constructor(
    readonly step: string,
    readonly observation?: {
      readonly monotonic_delta_ms: number;
      readonly wall_delta_ms: number;
      readonly maximum_gap_ms: number;
    },
  ) {
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
    throw new SoakAssertion("observation:continuity_or_clock_invalid", {
      monotonic_delta_ms: monotonicDelta,
      wall_delta_ms: wallDelta,
      maximum_gap_ms: maximumGapMs,
    });
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
