import { describe, expect, test } from "bun:test";
import {
  invocationMessageAuthorization,
  invocationRequestAuthorization,
} from "../../../src/tools/invocation-authorization";

const abort = new AbortController().signal;

describe("OpenCode v2 static invocation authorization", () => {
  test("uses explicit allow/deny without a host approval callback", async () => {
    const binding = {} as never;
    expect(
      await invocationMessageAuthorization("allow").authorizeMessage(binding, { abort }),
    ).toEqual({ kind: "allow" });
    expect(
      await invocationMessageAuthorization("deny").authorizeMessage(binding, { abort }),
    ).toEqual({ kind: "deny" });
  });

  test("fails closed for a legacy ask value", async () => {
    expect(
      await invocationMessageAuthorization("ask" as never).authorizeMessage({} as never, { abort }),
    ).toEqual({ kind: "deny" });
  });

  test("selects ask/wait policy and denies cancelled operations", async () => {
    const authorization = invocationRequestAuthorization({ ask: "allow", wait: "deny" });
    expect(await authorization.authorizeRequest({ operation: "ask" } as never, { abort })).toEqual({
      kind: "allow",
    });
    expect(await authorization.authorizeRequest({ operation: "wait" } as never, { abort })).toEqual(
      { kind: "deny" },
    );
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      await authorization.authorizeRequest({ operation: "ask" } as never, {
        abort: cancelled.signal,
      }),
    ).toEqual({ kind: "deny" });
  });
});
