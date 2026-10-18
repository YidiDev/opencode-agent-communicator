export interface SessionExportLimits {
  readonly maximumOutputBytes: number;
  readonly maximumConcurrent: number;
  readonly maximumSourceExportsPerMinute: number;
  readonly maximumWorkspaceExportsPerMinute: number;
}

export const sessionExportHardLimits = Object.freeze({
  maximumOutputBytes: 64 * 1024 * 1024,
  maximumConcurrent: 4,
  maximumSourceExportsPerMinute: 12,
  maximumWorkspaceExportsPerMinute: 48,
});

function bounded(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} exceeds its immutable export safety ceiling.`);
  }
  return value;
}

export function createSessionExportLimits(
  input: Partial<SessionExportLimits> = {},
): SessionExportLimits {
  return Object.freeze({
    maximumOutputBytes: bounded(
      input.maximumOutputBytes ?? 16 * 1024 * 1024,
      sessionExportHardLimits.maximumOutputBytes,
      "maximumOutputBytes",
    ),
    maximumConcurrent: bounded(
      input.maximumConcurrent ?? 2,
      sessionExportHardLimits.maximumConcurrent,
      "maximumConcurrent",
    ),
    maximumSourceExportsPerMinute: bounded(
      input.maximumSourceExportsPerMinute ?? 4,
      sessionExportHardLimits.maximumSourceExportsPerMinute,
      "maximumSourceExportsPerMinute",
    ),
    maximumWorkspaceExportsPerMinute: bounded(
      input.maximumWorkspaceExportsPerMinute ?? 16,
      sessionExportHardLimits.maximumWorkspaceExportsPerMinute,
      "maximumWorkspaceExportsPerMinute",
    ),
  });
}

/** Deliberately process-local: a restart releases all slots and never retries interrupted exports. */
export class ProcessLocalExportLimiter {
  private active = 0;
  private readonly sourceStarts = new Map<string, number[]>();
  private readonly workspaceStarts = new Map<string, number[]>();

  constructor(
    private readonly maximumConcurrent: number,
    private readonly maximumSourceRate = Number.MAX_SAFE_INTEGER,
    private readonly maximumWorkspaceRate = Number.MAX_SAFE_INTEGER,
  ) {}

  tryAcquire(
    scope: { readonly source?: string; readonly workspace?: string } = {},
    now = Date.now(),
  ): (() => void) | undefined {
    if (this.active >= this.maximumConcurrent) return undefined;
    const source = scope.source ?? "global";
    const workspace = scope.workspace ?? "global";
    const sourceStarts = this.current(this.sourceStarts, source, now);
    const workspaceStarts = this.current(this.workspaceStarts, workspace, now);
    if (
      sourceStarts.length >= this.maximumSourceRate ||
      workspaceStarts.length >= this.maximumWorkspaceRate
    ) {
      return undefined;
    }
    sourceStarts.push(now);
    workspaceStarts.push(now);
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }

  private current(store: Map<string, number[]>, key: string, now: number): number[] {
    const values = store.get(key) ?? [];
    const threshold = now - 60_000;
    while ((values[0] ?? now) <= threshold && values.length > 0) values.shift();
    store.set(key, values);
    return values;
  }
}
