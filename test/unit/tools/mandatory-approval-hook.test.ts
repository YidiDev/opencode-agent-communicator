import { describe, expect, test } from "bun:test";

import {
  enforceMandatoryApproval,
  enforceMandatoryStopConfiguration,
} from "../../../src/composition/mandatory-approval-hook";

describe("mandatory approval hook", () => {
  const permission = (type: string) => ({
    id: "per_1",
    type,
    sessionID: "ses_1",
    messageID: "msg_1",
    title: "Permission",
    metadata: {},
    time: { created: 1 },
  });

  test.each(["session_stop", "session_read"])(
    "narrows a configured %s allow decision back to ask",
    async (type) => {
      const output = { status: "allow" } as { status: "allow" | "ask" | "deny" };
      await enforceMandatoryApproval(permission(type), output);
      expect(output.status).toBe("ask");
    },
  );

  test("preserves denial and asking for both mandatory permission types", async () => {
    for (const type of ["session_stop", "session_read"]) {
      for (const status of ["deny", "ask"] as const) {
        const output = { status } as { status: "allow" | "ask" | "deny" };
        await enforceMandatoryApproval(permission(type), output);
        expect(output.status).toBe(status);
      }
    }
  });

  test("preserves unrelated permission decisions", async () => {
    const output = { status: "allow" } as { status: "allow" | "ask" | "deny" };
    await enforceMandatoryApproval(permission("session_send"), output);
    expect(output.status).toBe("allow");
  });

  test("installs both mandatory asks when permission configuration is absent", () => {
    const empty: { permission?: unknown } = {};
    enforceMandatoryStopConfiguration(empty);
    expect(empty.permission).toEqual({ session_stop: "ask", session_read: "ask" });
  });

  test("narrows global string, wildcard, and explicit allows to ask", () => {
    const objectPolicy: { permission: Record<string, string> } = {
      permission: { "*": "allow", session_read: "allow" },
    };
    enforceMandatoryStopConfiguration(objectPolicy);
    expect(objectPolicy.permission).toEqual({
      "*": "allow",
      session_read: "ask",
      session_stop: "ask",
    });
    const globalPolicy: { permission: unknown } = { permission: "allow" };
    enforceMandatoryStopConfiguration(globalPolicy);
    expect(globalPolicy.permission).toEqual({
      "*": "allow",
      session_stop: "ask",
      session_read: "ask",
    });
  });

  test("preserves explicit and inherited mandatory denials", () => {
    const explicit = { permission: { session_stop: "deny", session_read: "deny" } };
    enforceMandatoryStopConfiguration(explicit);
    expect(explicit.permission).toEqual({ session_stop: "deny", session_read: "deny" });

    const global: { permission: unknown } = { permission: "deny" };
    enforceMandatoryStopConfiguration(global);
    expect(global.permission).toEqual({
      "*": "deny",
      session_stop: "deny",
      session_read: "deny",
    });
  });

  test("rejects malformed host policy shapes", () => {
    for (const permission of ["sometimes", null, [], 42]) {
      expect(() => enforceMandatoryStopConfiguration({ permission })).toThrow("malformed");
    }
  });

  test("fails closed when the mandatory configuration mutation is rejected", () => {
    expect(() => enforceMandatoryStopConfiguration(Object.freeze({}))).toThrow(
      "could not be enforced",
    );
    expect(() =>
      enforceMandatoryStopConfiguration({ permission: Object.freeze({ bash: "allow" }) }),
    ).toThrow("could not be enforced");
  });

  test("rejects accessors and inherited permission mutation traps without invoking them", () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, "permission", {
      enumerable: true,
      get: () => {
        calls += 1;
        return {};
      },
      set: () => {
        calls += 1;
      },
    });
    const inherited = Object.create({
      set permission(_value: unknown) {
        calls += 1;
      },
    });
    expect(() => enforceMandatoryStopConfiguration(accessor)).toThrow("malformed");
    expect(() => enforceMandatoryStopConfiguration(inherited)).toThrow("malformed");
    expect(calls).toBe(0);
  });

  test("reads back own data properties and rejects no-op or lying proxy mutations", () => {
    const noOp = new Proxy(
      {},
      {
        defineProperty: () => true,
      },
    );
    expect(() => enforceMandatoryStopConfiguration(noOp)).toThrow("could not be enforced");

    const target: Record<string, unknown> = {};
    const lyingRead = new Proxy(target, {
      defineProperty(inner, key, descriptor) {
        return Reflect.defineProperty(inner, key, descriptor);
      },
      get(inner, key, receiver) {
        if (key === "permission") return { session_stop: "allow", session_read: "allow" };
        return Reflect.get(inner, key, receiver);
      },
    });
    expect(() => enforceMandatoryStopConfiguration(lyingRead)).toThrow("could not be enforced");

    const inconsistent = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(_inner, key) {
          if (key === "permission") {
            return { value: undefined, writable: true, enumerable: true, configurable: true };
          }
          return undefined;
        },
        defineProperty: () => true,
      },
    );
    expect(() => enforceMandatoryStopConfiguration(inconsistent)).toThrow("could not be enforced");
  });

  test("rejects malformed permission data, symbols, prototypes, and nested accessors", () => {
    const symbolPolicy = { bash: "allow", [Symbol("rule")]: "deny" };
    const inheritedPolicy = Object.create({ bash: "allow" });
    const nestedAccessor = {
      bash: Object.defineProperty({}, "git status", {
        enumerable: true,
        get: () => "allow",
      }),
    };
    for (const permission of [
      symbolPolicy,
      inheritedPolicy,
      nestedAccessor,
      { bash: "sometimes" },
      { bash: { "git *": "sometimes" } },
      { bash: null },
      { bash: [] },
      { session_stop: undefined },
    ]) {
      expect(() => enforceMandatoryStopConfiguration({ permission })).toThrow("malformed");
    }
  });

  test("narrows nested mandatory patterns while preserving their denials", () => {
    const config: { permission: Record<string, unknown> } = {
      permission: {
        bash: { "git status": "allow", "rm *": "deny" },
        read: "ask",
        session_read: { "safe:*": "allow", "blocked:*": "deny" },
      },
    };
    const original = config.permission;
    enforceMandatoryStopConfiguration(config);
    expect(config.permission).toBe(original);
    expect(config.permission).toEqual({
      bash: { "git status": "allow", "rm *": "deny" },
      read: "ask",
      session_stop: "ask",
      session_read: { "*": "ask", "safe:*": "ask", "blocked:*": "deny" },
    });
    const descriptor = Object.getOwnPropertyDescriptor(config.permission, "session_stop");
    expect(descriptor).toMatchObject({ value: "ask", writable: true, enumerable: true });
  });
});
