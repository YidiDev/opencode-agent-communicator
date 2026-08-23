import { createHash } from "node:crypto";

import { deserializeRetainedRequestResult } from "../../domain/request-serialization";
import type { RequestMetadata, RetainedRequestResult } from "../../domain/request-types";
import { assertTerminalPrivateState } from "./request-repository-shared";
import type { StoreContext } from "./store-types";
import { StoreIntegrityError } from "./store-types";

export interface StoredRequestResult {
  readonly result: RetainedRequestResult;
  readonly resultJson: string;
}

function selectResultJson(context: StoreContext, requestId: string): unknown {
  return context.database
    .query<{ readonly resultJson: unknown }, [string]>(
      "SELECT result_json AS resultJson FROM request_results WHERE request_id = ?",
    )
    .get(requestId)?.resultJson;
}

export function validateStoredResultState(
  context: StoreContext,
  request: RequestMetadata,
): StoredRequestResult | undefined {
  if (request.resolutionState !== "pending") {
    assertTerminalPrivateState(context, request.id);
  }
  const resultJson = selectResultJson(context, request.id);
  if (request.resultState !== "available") {
    if (resultJson !== undefined) {
      throw new StoreIntegrityError("Erased request result content was unexpectedly retained.");
    }
    return undefined;
  }
  const parsed = deserializeRetainedRequestResult(resultJson);
  if (!parsed.ok || parsed.value.kind !== request.kind || typeof resultJson !== "string") {
    throw new StoreIntegrityError("Stored request result failed strict validation.");
  }
  const bytes = new TextEncoder().encode(resultJson);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== request.resultByteLength || digest !== request.resultSha256) {
    throw new StoreIntegrityError("Stored request result identity was incoherent.");
  }
  return { result: parsed.value, resultJson };
}
