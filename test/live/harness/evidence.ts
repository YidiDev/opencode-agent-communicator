import { readFile } from "node:fs/promises";

import { liveDeadlineMs } from "./constants";

export interface EvidenceRecord {
  readonly event: string;
  readonly pid: number;
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readEvidence(path: string): Promise<EvidenceRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || typeof value.event !== "string" || typeof value.pid !== "number") {
        throw new Error("invalid diagnostic plugin evidence");
      }
      return { ...value, event: value.event, pid: value.pid };
    });
}

export async function waitForEvidence(
  path: string,
  predicate: (record: EvidenceRecord) => boolean,
  deadlineMs = liveDeadlineMs,
): Promise<EvidenceRecord> {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() < deadline) {
    const match = (await readEvidence(path)).find(predicate);
    if (match) return match;
    await Bun.sleep(25);
  }
  throw new Error("plugin evidence deadline exceeded");
}
