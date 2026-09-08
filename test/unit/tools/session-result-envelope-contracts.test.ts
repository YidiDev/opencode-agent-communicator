import { describe, expect, test } from "bun:test";

import { validateSessionId } from "../../../src/domain/sessions";
import { validateWorkspaceKey } from "../../../src/domain/workspaces";
import { ToolContractFault } from "../../../src/tools/contracts";
import { serializeSessionRequestStartResult } from "../../../src/tools/session-request-start";
import { serializeSessionStartResult } from "../../../src/tools/session-start";
import { serializeSessionStopResult } from "../../../src/tools/session-stop";

function value<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  if (!result.ok) throw new Error("invalid fixture");
  return result.value;
}

const expected = {
  workspaceKey: value(validateWorkspaceKey("workspace:result-envelopes")),
  sourceSessionId: "ses_source",
  idempotencyKey: "strict-result",
};
const targetSessionId = value(validateSessionId("ses_target"));

const serializers = [
  (result: unknown) => serializeSessionStartResult(result as never, expected),
  (result: unknown) => serializeSessionRequestStartResult(result as never, expected),
  (result: unknown) => serializeSessionStopResult(result as never, targetSessionId),
];

describe("session mutation failure result envelopes", () => {
  test("reconstructs exact safe failures and rejects extra or malformed fields", () => {
    const failure = {
      ok: false as const,
      error: { code: "invalid_arguments" as const, message: "Invalid input.", retryable: false },
    };
    for (const serialize of serializers) {
      expect(JSON.parse(serialize(failure))).toEqual(failure);
      for (const malformed of [
        { ...failure, extra: true },
        { ok: false, error: { ...failure.error, extra: true } },
        { ok: false, error: { ...failure.error, message: 1 } },
        { ok: false, error: { ...failure.error, retryable: 0 } },
        { ok: false, error: { ...failure.error, details: undefined } },
      ]) {
        expect(() => serialize(malformed)).toThrow(ToolContractFault);
      }
    }
  });

  test("rejects accessor and proxy top-level or error envelopes without invoking accessors", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({ ok: false }, "error", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { code: "invalid_arguments", message: "Invalid input.", retryable: false };
      },
    });
    const proxiedTopLevel = new Proxy(
      {
        ok: false,
        error: { code: "invalid_arguments", message: "Invalid input.", retryable: false },
      },
      {},
    );
    const proxiedError = {
      ok: false,
      error: new Proxy(
        { code: "invalid_arguments", message: "Invalid input.", retryable: false },
        {},
      ),
    };
    for (const serialize of serializers) {
      expect(() => serialize(accessor)).toThrow(ToolContractFault);
      expect(() => serialize(proxiedTopLevel)).toThrow(ToolContractFault);
      expect(() => serialize(proxiedError)).toThrow(ToolContractFault);
    }
    expect(getterCalls).toBe(0);
  });
});
