import { createHash } from "node:crypto";

import { validateRetainedRequestResult } from "../../domain/request-content";
import { serializeRetainedRequestResult } from "../../domain/request-serialization";
import type { RetainedRequestResult } from "../../domain/request-types";

export interface CanonicalRequestResult {
  readonly value: RetainedRequestResult;
  readonly json: string;
  readonly bytes: number;
  readonly digest: string;
}

export function canonicalRequestResult(result: unknown): CanonicalRequestResult | undefined {
  const validated = validateRetainedRequestResult(result);
  if (!validated.ok) return undefined;
  const json = serializeRetainedRequestResult(validated.value);
  const encoded = new TextEncoder().encode(json);
  return {
    value: validated.value,
    json,
    bytes: encoded.length,
    digest: createHash("sha256").update(encoded).digest("hex"),
  };
}

export function coherentCanonicalRequestResult(candidate: CanonicalRequestResult): boolean {
  const json = serializeRetainedRequestResult(candidate.value);
  const bytes = new TextEncoder().encode(json);
  return (
    json === candidate.json &&
    bytes.length === candidate.bytes &&
    createHash("sha256").update(bytes).digest("hex") === candidate.digest
  );
}
